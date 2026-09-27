/**
 * A fake Emscripten module with the `fcapi_*` ABI, for testing the loader and the worker without a
 * build: a growable heap with a bump allocator, UTF-8 helpers, a tiny MEMFS, and `fcapi_dispatch`
 * backed by the mock server's dispatcher, so real requests round-trip through the fake heap.
 * Events are published through `Module.__fcapiEvent` with a view into the heap, during the
 * dispatch, as the real module does.
 */
import { createMockDispatcher, type MockDispatcher } from "@fab-cad/mock-server";
import type { FreeCadWasmFS, FreeCadWasmModule, FreeCadWasmModuleFactory } from "../src/index";

const DIR = 0o040000;
const FILE = 0o100000;

export function fakeFS(): FreeCadWasmFS & { files: Map<string, Uint8Array>; dirs: Set<string> } {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/"]);
  const parent = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf("/")));
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { errno: 44 });
  return {
    files,
    dirs,
    mkdir(p) {
      if (dirs.has(p) || files.has(p)) throw Object.assign(new Error(`EEXIST: ${p}`), { errno: 20 });
      if (!dirs.has(parent(p))) throw enoent(parent(p));
      dirs.add(p);
    },
    writeFile(p, data) {
      if (!dirs.has(parent(p))) throw enoent(parent(p));
      files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
    },
    readFile(p) {
      const f = files.get(p);
      if (!f) throw enoent(p);
      return f;
    },
    readdir(p) {
      if (!dirs.has(p)) throw enoent(p);
      const prefix = p === "/" ? "/" : `${p}/`;
      const names = new Set<string>();
      for (const k of [...files.keys(), ...dirs])
        if (k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) names.add(k.slice(prefix.length));
      return [".", "..", ...names];
    },
    unlink(p) {
      if (!files.delete(p)) throw enoent(p);
    },
    rmdir(p) {
      dirs.delete(p);
    },
    stat(p) {
      if (dirs.has(p)) return { mode: DIR, size: 4096 };
      const f = files.get(p);
      if (!f) throw enoent(p);
      return { mode: FILE, size: f.length };
    },
    isDir: (mode) => (mode & DIR) === DIR,
    isFile: (mode) => (mode & FILE) === FILE,
    analyzePath: (p) => ({ exists: dirs.has(p) || files.has(p) }),
  };
}

export interface FakeModuleControl {
  /** Config JSON `fcapi_init` received. */
  config?: Record<string, unknown>;
  dispatcher?: MockDispatcher;
  initCalls: number;
  shutdownCalls: number;
  frees: number;
  /** Make `fcapi_init` fail with this code. */
  failInit?: number;
  /** Make the next dispatch abort (WebAssembly.RuntimeError). */
  abortNext?: boolean;
  /** Export names without the leading underscore (some Emscripten settings do). */
  bareNames?: boolean;
  moduleArg?: Record<string, unknown>;
}

export function fakeFactory(control: FakeModuleControl = { initCalls: 0, shutdownCalls: 0, frees: 0 }): FreeCadWasmModuleFactory {
  return async (moduleArg = {}) => {
    control.moduleArg = moduleArg;
    let heap = new Uint8Array(1024);
    let top = 8;
    let lastError = 0;
    const enc = new TextEncoder();
    const m = { ...moduleArg } as unknown as FreeCadWasmModule & Record<string, unknown>;
    const malloc = (n: number) => {
      const p = top;
      top += (n + 7) & ~7;
      if (top > heap.length) {
        // grow: the old HEAPU8 view is replaced, as in Emscripten with ALLOW_MEMORY_GROWTH
        const bigger = new Uint8Array(Math.max(heap.length * 2, top * 2));
        bigger.set(heap);
        heap = bigger;
        m.HEAPU8 = heap;
      }
      return p;
    };
    const writeString = (s: string) => {
      const b = enc.encode(`${s}\0`);
      const p = malloc(b.length);
      heap.set(b, p);
      return p;
    };
    const readString = (p: number) => {
      let e = p;
      while (heap[e] !== 0) e++;
      return new TextDecoder().decode(heap.subarray(p, e));
    };
    const fns: Record<string, unknown> = {
      malloc,
      free: () => {},
      fcapi_init: (ptr: number) => {
        control.initCalls++;
        control.config = JSON.parse(readString(ptr));
        if (control.failInit) {
          lastError = writeString("no FreeCAD home");
          return control.failInit;
        }
        control.dispatcher = createMockDispatcher({ demo: true, eventEncoding: control.config!.eventEncoding as "cbor" | "json" });
        control.dispatcher.onEvent((bytes) => {
          const p = malloc(bytes.length);
          heap.set(bytes, p);
          (m.__fcapiEvent as ((b: Uint8Array) => void) | undefined)?.(heap.subarray(p, p + bytes.length));
        });
        return 0;
      },
      fcapi_dispatch: (req: number, len: number, outLen: number) => {
        if (control.abortNext) {
          control.abortNext = false;
          throw new WebAssembly.RuntimeError("unreachable");
        }
        const reply = control.dispatcher!.dispatch(heap.slice(req, req + len));
        const p = malloc(reply.length);
        heap.set(reply, p);
        new DataView(heap.buffer).setUint32(outLen, reply.length, true);
        return p;
      },
      fcapi_free: () => {
        control.frees++;
      },
      fcapi_shutdown: () => {
        control.shutdownCalls++;
        control.dispatcher?.shutdown();
      },
      fcapi_last_error: () => lastError,
    };
    for (const [k, v] of Object.entries(fns)) m[control.bareNames ? k : `_${k}`] = v;
    m.HEAPU8 = heap;
    m.FS = fakeFS();
    m.UTF8ToString = readString;
    m.stringToNewUTF8 = writeString;
    return m;
  };
}

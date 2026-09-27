/**
 * The worker side of the browser's wasm mode: it owns one `createFreeCadWasm()` instance and its
 * MEMFS. Why a worker: `fcapi_dispatch` is a synchronous call into a single-threaded module, so a
 * recompute that takes a second would take the main thread with it; on a worker it costs nothing
 * visible, and `worker.terminate()` ends a wedged command.
 *
 * The logic is here, apart from `worker.ts`, so the protocol can be driven from a test with a fake
 * port and a fake module.
 */
import { createFreeCadWasm, type FreeCadWasm, type FreeCadWasmModule, type FreeCadWasmModuleFactory } from "./index";
import { exists, listFiles, mkdirTree, readFile, remove, writeFile } from "./fs";
import {
  isWasmAbort,
  type FreeCadWasmWorkerInit,
  type FreeCadWasmWorkerPort,
  type FromFreeCadWasmWorker,
  type ToFreeCadWasmWorker,
  type WasmFsRequest,
} from "./worker-protocol";

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ServeOptions {
  /** Resolve the factory some other way than `import(moduleUrl)` (tests). */
  loadFactory?: (moduleUrl: string) => Promise<FreeCadWasmModuleFactory>;
}

/** Serve the protocol on `port` until `{stop}`. */
export function serveFreeCadWasm(port: FreeCadWasmWorkerPort, opts: ServeOptions = {}): void {
  let wasm: FreeCadWasm | null = null;
  let stopped = false;
  const post = (message: FromFreeCadWasmWorker, transfer?: Transferable[]): void => port.postMessage(message, transfer);
  const load = opts.loadFactory ?? importFactory;

  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as ToFreeCadWasmWorker;
    // Each branch runs synchronously up to its first await and fcapi_dispatch is synchronous, so
    // requests reach the module in the order the host posted them.
    if ("start" in m) void start(m.start);
    else if ("req" in m) dispatch(m.id, m.req);
    else if ("fs" in m) fsOp(m.id, m.fs);
    else if ("stop" in m) stop();
  };

  async function start(cfg: FreeCadWasmWorkerInit): Promise<void> {
    post({ state: "starting" });
    try {
      const factory = await load(cfg.moduleUrl);
      // The loader awaits the factory and only then runs fcapi_init: the one hook that gets files
      // into MEMFS before FreeCAD opens `preload`.
      const seeding: FreeCadWasmModuleFactory = async (moduleArg) => {
        const module = (await factory(moduleArg)) as FreeCadWasmModule;
        for (const f of cfg.files ?? []) writeFile({ FS: module.FS }, f.path, f.bytes);
        if (cfg.files?.length) post({ log: `seeded ${cfg.files.length} file(s) into MEMFS` });
        return module;
      };
      wasm = await createFreeCadWasm({
        module: seeding,
        moduleUrl: cfg.moduleUrl,
        wasmUrl: cfg.wasmUrl,
        home: cfg.home,
        argv0: cfg.argv0,
        env: cfg.env,
        modules: cfg.modules,
        preload: cfg.preload,
        python: cfg.python,
        events: cfg.events,
        eventEncoding: cfg.eventEncoding,
        print: (line) => post({ log: line }),
        printErr: (line) => post({ log: line, level: "warn" }),
      });
      wasm.onEvent((bytes) => {
        const copy = new Uint8Array(bytes);
        post({ event: copy }, [copy.buffer]);
      });
      post({ state: "running" });
    } catch (e) {
      post({ state: "failed", message: describe(e) });
    }
  }

  function dispatch(id: number, req: Uint8Array): void {
    if (!wasm || stopped) {
      post({ id, error: "the wasm module is not running" });
      return;
    }
    let res: Uint8Array;
    try {
      res = wasm.dispatch(req);
    } catch (e) {
      const fatal = isWasmAbort(e);
      post({ id, error: describe(e), fatal });
      if (fatal) {
        wasm = null;
        post({ state: "failed", message: describe(e) });
      }
      return;
    }
    // `FreeCadWasm.dispatch` returns a slice of the heap: a buffer nobody else holds.
    post({ id, res }, [res.buffer]);
  }

  function fsOp(id: number, op: WasmFsRequest): void {
    if (!wasm) {
      post({ id, error: "the wasm module is not running" });
      return;
    }
    const w = wasm;
    try {
      switch (op.op) {
        case "writeFiles":
          for (const f of op.files) writeFile(w, f.path, f.bytes);
          post({ id, value: op.files.length });
          return;
        case "readFile": {
          const bytes = new Uint8Array(readFile(w, op.path));
          post({ id, value: bytes }, [bytes.buffer]);
          return;
        }
        case "exists":
          post({ id, value: exists(w, op.path) });
          return;
        case "stat": {
          if (!exists(w, op.path)) {
            post({ id, value: null });
            return;
          }
          const st = w.FS.stat(op.path);
          post({ id, value: { kind: w.FS.isDir(st.mode) ? "dir" : "file", size: st.size } });
          return;
        }
        case "listFiles":
          post({ id, value: listFiles(w, op.path) });
          return;
        case "mkdir":
          mkdirTree(w.FS, op.path);
          post({ id, value: undefined });
          return;
        case "remove":
          remove(w, op.path);
          post({ id, value: undefined });
          return;
      }
    } catch (e) {
      post({ id, error: describe(e) });
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    try {
      wasm?.shutdown();
      post({ state: "exited" });
    } catch (e) {
      post({ state: "failed", message: describe(e) });
    } finally {
      wasm = null;
      port.close?.();
    }
  }
}

async function importFactory(moduleUrl: string): Promise<FreeCadWasmModuleFactory> {
  if (!moduleUrl) throw new Error("no moduleUrl: a worker cannot resolve the packaged freecad_api.js on its own");
  const mod = (await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown };
  if (typeof mod.default !== "function") throw new Error(`${moduleUrl} has no default export (expected the createFreecadApi factory)`);
  return mod.default as FreeCadWasmModuleFactory;
}

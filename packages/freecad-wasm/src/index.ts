/**
 * `@fab-cad/freecad-wasm` — loader for FreeCAD's API core compiled to WebAssembly.
 *
 * The build (`freecad_api.js` + `freecad_api.wasm`, optionally `freecad_api.data` for a
 * `--preload-file` bundle; Emscripten `MODULARIZE` + `EXPORT_ES6` with
 * `EXPORT_NAME=createFreecadApi`) exports the C ABI of `src/Api/ApiC.h`:
 *
 * ```c
 * int         fcapi_init(const char* configJson);   // 0 = ok
 * uint8_t*    fcapi_dispatch(const uint8_t* req, size_t len, size_t* outLen);
 * void        fcapi_free(void* reply);
 * void        fcapi_shutdown(void);
 * const char* fcapi_last_error(void);
 * ```
 *
 * and calls `Module.__fcapiEvent(bytes)` with each encoded event (a view into the heap), before
 * `fcapi_dispatch` returns. The callback must be in place before `fcapi_init`.
 *
 * `createFreeCadWasm()` wraps that in a `FreeCadWasm`, which is exactly the `FreeCadWasmInstance`
 * `WasmTransport` from `@fab-cad/client` consumes. This package knows nothing about the envelope:
 * it moves bytes and owns the module's lifetime and its MEMFS.
 */
import { mkdirTree } from "./fs";

/** Emscripten's `FS`, narrowed to what this package uses. */
export interface FreeCadWasmFS {
  mkdir(path: string, mode?: number): unknown;
  mkdirTree?(path: string, mode?: number): unknown;
  writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string; flags?: string }): unknown;
  readFile(path: string, opts?: { encoding?: string }): Uint8Array;
  readdir(path: string): string[];
  unlink(path: string): unknown;
  rmdir?(path: string): unknown;
  stat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  analyzePath?(path: string, dontResolveLastLink?: boolean): { exists: boolean };
}

/** The resolved Emscripten module. Function names carry the leading underscore Emscripten adds. */
export interface FreeCadWasmModule {
  HEAPU8: Uint8Array;
  FS: FreeCadWasmFS;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _fcapi_init(configJson: number): number;
  _fcapi_dispatch(req: number, len: number, outLen: number): number;
  _fcapi_free(ptr: number): void;
  _fcapi_shutdown(): void;
  _fcapi_last_error(): number;
  UTF8ToString(ptr: number, maxBytes?: number): string;
  stringToNewUTF8(s: string): number;
  __fcapiEvent?: (bytes: Uint8Array) => void;
  [key: string]: unknown;
}

/** The default export of `freecad_api.js` (`createFreecadApi`). */
export type FreeCadWasmModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<FreeCadWasmModule>;

/** What `fcapi_init` is told (ApiC.h), serialized as JSON. */
export interface FreeCadWasmConfig {
  /** Where FreeCAD looks for its home. Default `/freecad/bin/FreeCADApi`. */
  argv0: string;
  /** Environment set before FreeCAD starts. `FREECAD_USER_HOME` defaults to `home`. */
  env: Record<string, string>;
  /** Modules imported after start (`Part`, `Sketcher`, `PartDesign`, ...). */
  modules: string[];
  /** MEMFS path of a document to open after start, or `""`. */
  preload: string;
  /** Allow `RunPython`. */
  python: boolean;
  /** Publish events through `Module.__fcapiEvent`. */
  events: boolean;
  /** Encoding of event messages. */
  eventEncoding: "cbor" | "json";
}

export interface FreeCadWasmOptions extends Partial<FreeCadWasmConfig> {
  /** Writable MEMFS directory for FreeCAD's user data; created before init. Default `/home/freecad`. */
  home?: string;
  /** The factory exported by `freecad_api.js`. Omit to `import()` it from `moduleUrl`. */
  module?: FreeCadWasmModuleFactory;
  /** Where to find `freecad_api.js`. Default: `dist/freecad_api.js` in this package. */
  moduleUrl?: string | URL;
  /** Where to find `freecad_api.wasm`, when not next to the glue (Emscripten `locateFile`). */
  wasmUrl?: string | URL;
  /** Event messages from the module (already copied out of the heap). */
  onEvent?: (bytes: Uint8Array) => void;
  /** `Module.print` / `Module.printErr`. */
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

export const DEFAULT_HOME = "/home/freecad";

const DEFAULT_CONFIG: FreeCadWasmConfig = {
  argv0: "/freecad/bin/FreeCADApi",
  env: {},
  modules: ["Part"],
  preload: "",
  python: true,
  events: true,
  eventEncoding: "cbor",
};

/** Thrown when the module reports a failure; carries `fcapi_last_error()` when there is one. */
export class FreeCadWasmError extends Error {
  override readonly name = "FreeCadWasmError";
  constructor(
    message: string,
    readonly lastError = "",
  ) {
    super(lastError ? `${message}: ${lastError}` : message);
  }
}

/**
 * A loaded module. Implements `FreeCadWasmInstance` from `@fab-cad/client` structurally, so
 * `new WasmTransport(await createFreeCadWasm())` is all the wiring there is.
 */
export class FreeCadWasm {
  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private closed = false;

  constructor(
    readonly module: FreeCadWasmModule,
    readonly config: FreeCadWasmConfig,
  ) {}

  get FS(): FreeCadWasmFS {
    return this.module.FS;
  }

  /** `fcapi_last_error()`, or `""`. */
  lastError(): string {
    try {
      const ptr = this.module._fcapi_last_error();
      return ptr ? this.module.UTF8ToString(ptr) : "";
    } catch {
      return "";
    }
  }

  /** One encoded request in, one encoded reply out. Synchronous, like the ABI. */
  dispatch(request: Uint8Array): Uint8Array {
    if (this.closed) throw new FreeCadWasmError("the wasm module has been shut down");
    const m = this.module;
    const reqPtr = m._malloc(request.length || 1);
    const lenPtr = m._malloc(4);
    if (!reqPtr || !lenPtr) throw new FreeCadWasmError("out of wasm memory", this.lastError());
    try {
      m.HEAPU8.set(request, reqPtr);
      const outPtr = m._fcapi_dispatch(reqPtr, request.length, lenPtr);
      if (!outPtr) throw new FreeCadWasmError("fcapi_dispatch returned null", this.lastError());
      // The heap may have grown (and HEAPU8 been replaced) during the call. size_t is 32-bit.
      const heap = m.HEAPU8;
      const len = (heap[lenPtr]! | (heap[lenPtr + 1]! << 8) | (heap[lenPtr + 2]! << 16) | (heap[lenPtr + 3]! << 24)) >>> 0;
      const reply = heap.slice(outPtr, outPtr + len);
      m._fcapi_free(outPtr);
      return reply;
    } finally {
      m._free(reqPtr);
      m._free(lenPtr);
    }
  }

  onEvent(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Called through `Module.__fcapiEvent`; also usable from tests. */
  emitEvent(bytes: Uint8Array): void {
    for (const cb of Array.from(this.listeners)) cb(bytes);
  }

  /** `fcapi_shutdown()`. Idempotent; the module is unusable afterwards. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    try {
      this.module._fcapi_shutdown();
    } finally {
      this.module.__fcapiEvent = undefined;
    }
  }

  get isShutDown(): boolean {
    return this.closed;
  }
}

/** Load `freecad_api.js`, wire the event callback, run `fcapi_init` and hand back the instance. */
export async function createFreeCadWasm(opts: FreeCadWasmOptions = {}): Promise<FreeCadWasm> {
  const home = opts.home ?? DEFAULT_HOME;
  const config: FreeCadWasmConfig = {
    argv0: opts.argv0 ?? DEFAULT_CONFIG.argv0,
    env: { FREECAD_USER_HOME: home, ...(opts.env ?? {}) },
    modules: opts.modules ?? DEFAULT_CONFIG.modules,
    preload: opts.preload ?? DEFAULT_CONFIG.preload,
    python: opts.python ?? DEFAULT_CONFIG.python,
    events: opts.events ?? DEFAULT_CONFIG.events,
    eventEncoding: opts.eventEncoding ?? DEFAULT_CONFIG.eventEncoding,
  };

  const factory = opts.module ?? (await loadFactory(opts.moduleUrl));
  let instance: FreeCadWasm | undefined;
  const onEvent = (bytes: Uint8Array) => {
    // A view into the heap; copy before it grows, moves or is freed.
    const copy = new Uint8Array(bytes);
    opts.onEvent?.(copy);
    instance?.emitEvent(copy);
  };

  const moduleArg: Record<string, unknown> = { __fcapiEvent: onEvent };
  const wasmUrl = opts.wasmUrl ? String(opts.wasmUrl) : undefined;
  const base = opts.moduleUrl ? String(opts.moduleUrl) : opts.module ? "" : defaultModuleUrl().href;
  if (wasmUrl || base) {
    moduleArg.locateFile = (path: string) => (path.endsWith(".wasm") && wasmUrl ? wasmUrl : base ? sibling(base, path) : path);
  }
  if (opts.print) moduleArg.print = opts.print;
  if (opts.printErr) moduleArg.printErr = opts.printErr;

  const module = normalise(await factory(moduleArg));
  module.__fcapiEvent = onEvent; // in case the factory did not copy moduleArg onto the Module
  instance = new FreeCadWasm(module, config);
  mkdirTree(module.FS, home);

  const cfgPtr = module.stringToNewUTF8(JSON.stringify(config));
  let rc: number;
  try {
    rc = module._fcapi_init(cfgPtr);
  } finally {
    module._free(cfgPtr);
  }
  if (rc !== 0) throw new FreeCadWasmError(`fcapi_init returned ${rc}`, instance.lastError());
  return instance;
}

const ABI = ["malloc", "free", "fcapi_init", "fcapi_dispatch", "fcapi_free", "fcapi_shutdown", "fcapi_last_error"];

/** Accept exports with or without Emscripten's leading underscore; fail clearly on what is missing. */
function normalise(module: FreeCadWasmModule): FreeCadWasmModule {
  const m = module as unknown as Record<string, unknown>;
  for (const name of ABI) if (typeof m[`_${name}`] !== "function" && typeof m[name] === "function") m[`_${name}`] = m[name];
  const missing = ABI.map((n) => `_${n}`).filter((n) => typeof m[n] !== "function");
  if (missing.length > 0)
    throw new FreeCadWasmError(`the wasm module does not export ${missing.join(", ")} (rebuild with -sEXPORTED_FUNCTIONS)`);
  for (const n of ["UTF8ToString", "stringToNewUTF8"]) {
    if (typeof m[n] !== "function")
      throw new FreeCadWasmError(`the wasm module does not export the runtime method ${n} (-sEXPORTED_RUNTIME_METHODS)`);
  }
  if (!m.HEAPU8) throw new FreeCadWasmError("the wasm module does not expose HEAPU8 (-sEXPORTED_RUNTIME_METHODS=HEAPU8)");
  if (!m.FS) throw new FreeCadWasmError("the wasm module does not expose FS (-sEXPORTED_RUNTIME_METHODS=FS)");
  return module;
}

/**
 * A sidecar (`freecad_api.wasm`, `freecad_api.data`) next to the glue. Emscripten asks for them by
 * bare name and would resolve against the page (or the cwd under Bun); `file:` URLs become paths
 * because the `--preload-file` loader reads them with `readFileSync`.
 */
export function sibling(base: string, name: string): string {
  const url = base.replace(/[^/]*$/, "") + name;
  return url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
}

/** `dist/freecad_api.js` in this package, where `bun run fetch` puts the build. */
export function defaultModuleUrl(): URL {
  return new URL(/* @vite-ignore */ "../dist/freecad_api.js", import.meta.url);
}

async function loadFactory(moduleUrl?: string | URL): Promise<FreeCadWasmModuleFactory> {
  const url = moduleUrl ? String(moduleUrl) : defaultModuleUrl().href;
  let mod: { default?: unknown };
  try {
    mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } catch (e) {
    throw new FreeCadWasmError(
      `cannot load the FreeCAD wasm module from ${url} — build it in the fork and run 'bun run --filter @fab-cad/freecad-wasm fetch' (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (typeof mod.default !== "function") throw new FreeCadWasmError(`${url} has no default export (expected the createFreecadApi factory)`);
  return mod.default as FreeCadWasmModuleFactory;
}

export * from "./fs";
export * from "./worker-client";

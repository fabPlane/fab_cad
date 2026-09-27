/**
 * The host side of the browser's wasm mode: `createFreeCadWasmInWorker()` starts `worker.ts`,
 * waits for the module to report `running`, and returns an object that `WasmTransport` consumes
 * (through `dispatchAsync`: a worker cannot answer synchronously) and that answers MEMFS
 * questions over the same channel.
 *
 *   const wasm = await createFreeCadWasmInWorker({ moduleUrl: "/freecad-wasm/freecad_api.js" });
 *   const client = new FreeCADClient(new WasmTransport(wasm));
 *   await wasm.writeFile("/work/part.FCStd", bytes);
 */
import {
  WASM_ABORT_ERROR_NAME,
  type FreeCadWasmWorkerInit,
  type FreeCadWasmWorkerLike,
  type FreeCadWasmWorkerState,
  type FromFreeCadWasmWorker,
  type WasmFile,
  type WasmFsRequest,
  type WasmStat,
} from "./worker-protocol";

export type { FreeCadWasmWorkerInit, FreeCadWasmWorkerLike, FreeCadWasmWorkerState, WasmFile, WasmFsRequest, WasmStat };

export interface FreeCadWasmInWorkerOptions extends Partial<FreeCadWasmWorkerInit> {
  /** Build the worker. Default: `worker.ts` next to this file, as an ES module. */
  createWorker?: () => FreeCadWasmWorkerLike;
  log?: (line: string, level?: "info" | "warn") => void;
  onEvent?: (bytes: Uint8Array) => void;
  /** How long to wait for `fcapi_init`. Default 120 000 ms; `0` disables. */
  startTimeoutMs?: number;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
}

/** A module running in a Worker, shaped like `FreeCadWasmInstance` plus async MEMFS calls. */
export class FreeCadWasmWorkerClient {
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private readonly stateWaiters = new Set<(s: FreeCadWasmWorkerState, message?: string) => void>();
  private readonly log: (line: string, level?: "info" | "warn") => void;
  private readonly onEventOpt: ((bytes: Uint8Array) => void) | undefined;
  private nextId = 1;
  private _state: FreeCadWasmWorkerState = "starting";
  private closed = false;

  constructor(
    readonly worker: FreeCadWasmWorkerLike,
    opts: FreeCadWasmInWorkerOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.onEventOpt = opts.onEvent;
    worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as FromFreeCadWasmWorker);
    worker.onerror = (ev: ErrorEvent) => this.fail(ev?.message ? String(ev.message) : "the FreeCAD wasm worker failed to start");
  }

  get state(): FreeCadWasmWorkerState {
    return this._state;
  }

  get isShutDown(): boolean {
    return this.closed || this._state === "exited" || this._state === "failed";
  }

  // ------------------------------------------------------------------ FreeCadWasmInstance

  /** Always a mistake: a worker cannot answer synchronously. `WasmTransport` uses `dispatchAsync`. */
  dispatch(_request: Uint8Array): Uint8Array {
    throw new Error("this FreeCAD module runs in a Worker; use dispatchAsync() (WasmTransport does)");
  }

  dispatchAsync(request: Uint8Array): Promise<Uint8Array> {
    // A copy, because the buffer is transferred and the caller may still hold the request.
    const copy = new Uint8Array(request);
    return this.send<Uint8Array>({ req: copy }, [copy.buffer]);
  }

  onEvent(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** `fcapi_shutdown()` on the worker, then `terminate()`. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const exited = this.waitForState(["exited", "failed"], 2000);
      this.worker.postMessage({ stop: true });
      await exited;
    } catch {
      /* the worker never answered; terminate() ends it either way */
    } finally {
      this.worker.terminate();
      this.failAll(new Error("the FreeCAD wasm worker has been shut down"));
      this.listeners.clear();
    }
  }

  /** `terminate()` without the stop handshake: for a module wedged in a command. */
  terminate(reason = "the FreeCAD wasm worker was terminated"): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this._state = "failed";
    this.notifyState("failed", reason);
    this.failAll(new Error(reason), true);
    this.listeners.clear();
    this.log(reason, "warn");
  }

  // ------------------------------------------------------------------ MEMFS, over messages

  writeFiles(files: WasmFile[]): Promise<number> {
    return files.length === 0 ? Promise.resolve(0) : this.fs<number>({ op: "writeFiles", files });
  }

  writeFile(path: string, bytes: Uint8Array): Promise<number> {
    return this.writeFiles([{ path, bytes }]);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.fs<Uint8Array>({ op: "readFile", path });
  }

  exists(path: string): Promise<boolean> {
    return this.fs<boolean>({ op: "exists", path });
  }

  stat(path: string): Promise<WasmStat | null> {
    return this.fs<WasmStat | null>({ op: "stat", path });
  }

  listFiles(path: string): Promise<string[]> {
    return this.fs<string[]>({ op: "listFiles", path });
  }

  mkdir(path: string): Promise<void> {
    return this.fs<void>({ op: "mkdir", path });
  }

  remove(path: string): Promise<void> {
    return this.fs<void>({ op: "remove", path });
  }

  // ------------------------------------------------------------------ plumbing

  /** Resolves when the module reports `running`; rejects with `fcapi_init`'s error otherwise. */
  async ready(timeoutMs = 120_000): Promise<void> {
    if (this._state === "running") return;
    const s = await this.waitForState(["running", "failed", "exited"], timeoutMs);
    if (s.state !== "running") throw new Error(s.message ?? `the FreeCAD wasm worker is ${s.state}`);
  }

  private fs<T>(op: WasmFsRequest): Promise<T> {
    // Requests are cloned, not transferred: the caller keeps its bytes.
    return this.send<T>({ fs: op });
  }

  private send<T>(body: { req: Uint8Array } | { fs: WasmFsRequest }, transfer?: Transferable[]): Promise<T> {
    if (this.isShutDown) return Promise.reject(new Error("the FreeCAD wasm worker is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      try {
        this.worker.postMessage({ id, ...body }, transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(m: FromFreeCadWasmWorker): void {
    if ("state" in m) {
      this._state = m.state;
      this.notifyState(m.state, m.message);
      if (m.state === "failed" || m.state === "exited")
        this.failAll(new Error(m.message ?? `the FreeCAD wasm worker ${m.state}`), m.state === "failed");
      return;
    }
    if ("log" in m) {
      this.log(m.log, m.level);
      return;
    }
    if ("event" in m) {
      for (const cb of Array.from(this.listeners)) {
        try {
          cb(m.event);
        } catch (e) {
          this.log(`event listener threw: ${e instanceof Error ? e.message : String(e)}`, "warn");
        }
      }
      this.onEventOpt?.(m.event);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if ("error" in m) {
      const err = new Error(m.error);
      // So `WasmTransport` closes itself instead of dispatching into a dead module.
      if (m.fatal) err.name = WASM_ABORT_ERROR_NAME;
      p.reject(err);
      return;
    }
    p.resolve(("res" in m ? m.res : m.value) as never);
  }

  private fail(message: string): void {
    this._state = "failed";
    this.notifyState("failed", message);
    this.failAll(new Error(message));
    this.log(message, "warn");
  }

  private failAll(err: Error, fatal = false): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    if (fatal) err.name = WASM_ABORT_ERROR_NAME;
    for (const p of waiting) p.reject(err);
  }

  private notifyState(state: FreeCadWasmWorkerState, message?: string): void {
    for (const cb of Array.from(this.stateWaiters)) cb(state, message);
  }

  private waitForState(want: FreeCadWasmWorkerState[], timeoutMs: number): Promise<{ state: FreeCadWasmWorkerState; message?: string }> {
    if (want.includes(this._state)) return Promise.resolve({ state: this._state });
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.stateWaiters.delete(cb);
              reject(new Error(`the FreeCAD wasm worker did not report ${want.join("/")} within ${timeoutMs} ms`));
            }, timeoutMs)
          : null;
      const cb = (state: FreeCadWasmWorkerState, message?: string): void => {
        if (!want.includes(state)) return;
        if (timer) clearTimeout(timer);
        this.stateWaiters.delete(cb);
        resolve({ state, message });
      };
      this.stateWaiters.add(cb);
    });
  }
}

/**
 * Start `freecad_api.js` in a Worker and resolve once `fcapi_init` has returned. `moduleUrl` is
 * made absolute against the page first: a worker's `import()` resolves against the worker
 * script's (bundler-generated) URL.
 */
export async function createFreeCadWasmInWorker(opts: FreeCadWasmInWorkerOptions = {}): Promise<FreeCadWasmWorkerClient> {
  const worker = opts.createWorker ? opts.createWorker() : defaultWorker();
  const client = new FreeCadWasmWorkerClient(worker, opts);
  const init: FreeCadWasmWorkerInit = {
    moduleUrl: absoluteUrl(opts.moduleUrl ?? ""),
    wasmUrl: opts.wasmUrl ? absoluteUrl(opts.wasmUrl) : undefined,
    files: opts.files ?? [],
    home: opts.home,
    argv0: opts.argv0,
    env: opts.env,
    modules: opts.modules,
    preload: opts.preload,
    python: opts.python,
    events: opts.events,
    eventEncoding: opts.eventEncoding,
  };
  worker.postMessage({ start: init });
  try {
    await client.ready(opts.startTimeoutMs ?? 120_000);
  } catch (e) {
    await client.shutdown();
    throw e;
  }
  return client;
}

function defaultWorker(): FreeCadWasmWorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as unknown as FreeCadWasmWorkerLike;
}

export function absoluteUrl(url: string): string {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const base = typeof location !== "undefined" && location.href ? location.href : undefined;
  return base ? new URL(url, base).href : url;
}

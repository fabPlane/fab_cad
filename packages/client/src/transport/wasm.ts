/**
 * `WasmTransport` — in-process transport over FreeCAD's API core compiled to WebAssembly
 * (`@fab-cad/freecad-wasm`), or anything with the same shape (`createMockDispatcher()` from
 * `@fab-cad/mock-server`). `send()` hands the request bytes to the module's synchronous
 * `fcapi_dispatch` and gets the reply bytes straight back.
 *
 * The module is single-threaded and re-entrant calls into it are undefined, so requests are queued
 * FIFO and dispatched one at a time from a microtask — `send()` never runs the module inside the
 * caller's stack frame, so `await client.call(...)` inside an event handler is safe.
 *
 * The module delivers a request's events *before* `fcapi_dispatch` returns (ApiC.h). They are
 * buffered while a dispatch runs and flushed after the reply promise has resolved, so a listener
 * never sees an event for a change whose reply the caller has not seen yet — the order the socket
 * transports get from the server.
 */
import { utf8, type Message } from "@fab-cad/protocol";
import { Listeners, TransportError, errorMessage, type SendOptions, type Transport, type TransportState } from "./types";

/** What `WasmTransport` needs from a loaded module (`createFreeCadWasm()` in `@fab-cad/freecad-wasm`). */
export interface FreeCadWasmInstance {
  /** Synchronously dispatch one encoded request; returns the encoded reply. */
  dispatch(request: Uint8Array): Uint8Array;
  /**
   * The same dispatch, one round trip away — for an instance on another thread
   * (`createFreeCadWasmInWorker()`), where the synchronous ABI cannot be reached synchronously.
   * `WasmTransport` prefers it when present.
   */
  dispatchAsync?(request: Uint8Array): Promise<Uint8Array>;
  /** Subscribe to encoded event messages. Returns an unsubscribe function. */
  onEvent(cb: (bytes: Uint8Array) => void): () => void;
  /** Tear the module down (`fcapi_shutdown`). */
  shutdown(): void | Promise<void>;
}

export interface WasmTransportOptions {
  /**
   * Default per-request budget when `send()` gets no `timeoutMs`. `0` disables. Default 60 000 ms.
   * A dispatch under way cannot be interrupted (it is a synchronous call into the module), so the
   * timeout only covers the time a request spends queued.
   */
  defaultTimeoutMs?: number;
  /** Call `instance.shutdown()` from `close()`. Default `true`. */
  ownsInstance?: boolean;
  log?: (message: string) => void;
}

interface Pending {
  payload: Uint8Array;
  timeoutMs: number;
  resolve: (reply: Message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
}

export class WasmTransport implements Transport {
  readonly kind = "wasm";
  private readonly defaultTimeoutMs: number;
  private readonly ownsInstance: boolean;
  private readonly log: (message: string) => void;
  private _state: TransportState = "open";
  private readonly stateListeners: Listeners<[TransportState]>;
  private readonly eventListeners: Listeners<[Message]>;
  private readonly offInstanceEvents: () => void;
  private queue: Pending[] = [];
  private pumping = false;
  private dispatching = false;
  private eventBuffer: Uint8Array[] = [];
  private lastError: Error | null = null;

  /** Symmetry with the socket transports; the module is ready as soon as it is loaded. */
  static async connect(instance: FreeCadWasmInstance, opts: WasmTransportOptions = {}): Promise<WasmTransport> {
    return new WasmTransport(instance, opts);
  }

  constructor(
    readonly instance: FreeCadWasmInstance,
    opts: WasmTransportOptions = {},
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.ownsInstance = opts.ownsInstance ?? true;
    this.log = opts.log ?? (() => {});
    this.stateListeners = new Listeners(this.log);
    this.eventListeners = new Listeners(this.log);
    this.offInstanceEvents = instance.onEvent((bytes) => this.onModuleEvent(bytes));
  }

  get state(): TransportState {
    return this._state;
  }

  /** Requests waiting behind the one being dispatched. */
  get queued(): number {
    return this.queue.length;
  }

  /** Events raised during the current dispatch, waiting to be flushed. */
  get bufferedEvents(): number {
    return this.eventBuffer.length;
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    return this.stateListeners.add(cb);
  }

  onEvent(cb: (event: Message) => void): () => void {
    return this.eventListeners.add(cb);
  }

  send(request: Message, opts: SendOptions = {}): Promise<Message> {
    if (this._state === "closed") return Promise.reject(this.lastError ?? new TransportError("closed", "wasm transport is closed"));
    const payload = typeof request === "string" ? utf8(request) : request;
    return new Promise<Message>((resolve, reject) => {
      const p: Pending = { payload, timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs, resolve, reject, timer: null, cancelled: false };
      if (p.timeoutMs > 0 && Number.isFinite(p.timeoutMs)) {
        p.timer = setTimeout(() => {
          if (p.cancelled) return;
          p.cancelled = true;
          p.reject(new TransportError("timeout", `request timed out after ${p.timeoutMs} ms waiting for the wasm module`));
        }, p.timeoutMs);
      }
      this.queue.push(p);
      this.schedule();
    });
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    const err = new TransportError("closed", "wasm transport closed");
    this.lastError = err;
    this.failAll(err);
    this.offInstanceEvents();
    this.eventBuffer = [];
    this.setState("closed");
    if (this.ownsInstance) {
      try {
        await this.instance.shutdown();
      } catch (e) {
        this.log(`shutdown threw: ${errorMessage(e)}`);
      }
    }
  }

  // ---------------------------------------------------------------- dispatch loop

  private schedule(): void {
    if (this.pumping || this.dispatching) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this._state === "closed" || this.dispatching) return;
    let p = this.queue.shift();
    while (p && p.cancelled) p = this.queue.shift(); // timed out while queued
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.cancelled = true; // no timeout can fire once the module has the request

    if (this.instance.dispatchAsync) {
      void this.pumpAsync(p);
      return;
    }
    let reply: Uint8Array;
    this.dispatching = true;
    try {
      reply = this.instance.dispatch(p.payload);
    } catch (e) {
      this.dispatching = false;
      this.failDispatch(p, e);
      return;
    }
    this.dispatching = false;
    // Resolving schedules the caller's continuation; flushing from a later microtask therefore
    // delivers events strictly after the reply the module produced them for.
    p.resolve(reply);
    this.afterDispatch();
  }

  private async pumpAsync(p: Pending): Promise<void> {
    let reply: Uint8Array;
    this.dispatching = true;
    try {
      reply = await this.instance.dispatchAsync!(p.payload);
    } catch (e) {
      this.dispatching = false;
      this.failDispatch(p, e);
      return;
    }
    this.dispatching = false;
    p.resolve(reply);
    this.afterDispatch();
  }

  private failDispatch(p: Pending, e: unknown): void {
    const err = e instanceof TransportError ? e : new TransportError("protocol", `wasm dispatch failed: ${errorMessage(e)}`, { cause: e });
    this.log(err.message);
    p.reject(err);
    if (isWasmAbort(e)) {
      // The module called abort(): its heap is gone and every later dispatch traps again. Close, so
      // the owner sees a closed transport and can reload the module.
      void this.close();
      return;
    }
    this.afterDispatch();
  }

  private afterDispatch(): void {
    queueMicrotask(() => {
      this.flushEvents();
      if (this.queue.length > 0) this.schedule();
    });
  }

  private onModuleEvent(bytes: Uint8Array): void {
    // The module may hand out a view into its heap; copy before it moves or is freed.
    const copy = new Uint8Array(bytes);
    if (this.dispatching) {
      this.eventBuffer.push(copy);
      return;
    }
    this.eventListeners.emit(copy);
  }

  private flushEvents(): void {
    if (this.eventBuffer.length === 0) return;
    const buffered = this.eventBuffer;
    this.eventBuffer = [];
    for (const b of buffered) this.eventListeners.emit(b);
  }

  private failAll(err: Error): void {
    const q = this.queue;
    this.queue = [];
    for (const p of q) {
      if (p.timer) clearTimeout(p.timer);
      if (p.cancelled) continue;
      p.cancelled = true;
      p.reject(err);
    }
  }

  private setState(s: TransportState): void {
    if (this._state === s) return;
    this._state = s;
    this.stateListeners.emit(s);
  }
}

/** The name `@fab-cad/freecad-wasm`'s worker client gives an error for an abort on the worker thread. */
export const WASM_ABORT_ERROR_NAME = "FreeCadWasmAbort";

/**
 * Did the module abort, as opposed to failing one request? Emscripten's `abort()` surfaces as a
 * `WebAssembly.RuntimeError`; a FreeCAD failure comes back as a well-formed reply instead.
 */
export function isWasmAbort(e: unknown): boolean {
  if (e instanceof Error && e.name === WASM_ABORT_ERROR_NAME) return true;
  return typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;
}

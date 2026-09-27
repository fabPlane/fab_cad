/**
 * `WebSocketTransport` — talks to `FreeCADApiServer --listen ws://…` (or the bridge's `/ws` proxy
 * in front of one) from a browser or from Bun.
 *
 * A JSON request goes out as a text frame, a CBOR request as a binary frame; the server answers in
 * kind. Replies are matched to callers by the envelope `id`, so any number of requests may be in
 * flight (the server still runs them one at a time, in order). Messages without an `id` are events
 * and go to `onEvent` listeners. There is no reconnect: when the socket closes, pending requests
 * are rejected and the state goes to `closed`; the owner decides whether to dial again.
 */
import { peekEnvelope, toMessage, type Message, type RequestId } from "@fab-cad/protocol";
import { Listeners, TransportError, errorMessage, type SendOptions, type Transport, type TransportState } from "./types";

/** The subset of the WHATWG WebSocket API used here (so tests and other runtimes can inject one). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: (ev: unknown) => void): void;
  addEventListener(type: "close", cb: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
}

export interface WebSocketTransportOptions {
  /** Default per-request timeout when `send()` gets no `timeoutMs`. `0` disables. Default 60 000 ms. */
  defaultTimeoutMs?: number;
  /** Time allowed for the socket to open. Default 10 000 ms. */
  connectTimeoutMs?: number;
  /** Factory for the underlying socket; defaults to the global `WebSocket`. */
  createWebSocket?: (url: string) => WebSocketLike;
  log?: (message: string) => void;
}

interface Pending {
  resolve: (reply: Message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WebSocketTransport implements Transport {
  readonly kind = "websocket";
  readonly url: string;
  private readonly ws: WebSocketLike;
  private readonly defaultTimeoutMs: number;
  private readonly log: (message: string) => void;
  private _state: TransportState = "connecting";
  private readonly stateListeners: Listeners<[TransportState]>;
  private readonly eventListeners: Listeners<[Message]>;
  private readonly pending = new Map<RequestId, Pending>();
  private lastError: Error | null = null;
  private closedByUser = false;

  /** Open a transport and wait until the socket is up. */
  static async connect(url: string | URL, opts?: WebSocketTransportOptions): Promise<WebSocketTransport> {
    const t = new WebSocketTransport(url, opts);
    await t.ready();
    return t;
  }

  constructor(url: string | URL, opts: WebSocketTransportOptions = {}) {
    this.url = typeof url === "string" ? url : url.toString();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.log = opts.log ?? (() => {});
    this.stateListeners = new Listeners(this.log);
    this.eventListeners = new Listeners(this.log);
    const create = opts.createWebSocket ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    this.ws = create(this.url);
    this.ws.binaryType = "arraybuffer";

    const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    const connectTimer = setTimeout(() => {
      if (this._state !== "connecting") return;
      this.lastError = new TransportError("connect", `connect to ${this.url} timed out after ${connectTimeoutMs} ms`);
      try {
        this.ws.close(4000, "connect timeout");
      } catch {
        /* ignore */
      }
      this.finish();
    }, connectTimeoutMs);

    this.ws.addEventListener("open", () => {
      clearTimeout(connectTimer);
      if (this._state === "connecting") this.setState("open");
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    this.ws.addEventListener("error", (ev) => {
      const msg = (ev as { message?: string })?.message ?? "WebSocket error";
      this.lastError ??= new TransportError(this._state === "connecting" ? "connect" : "closed", `${this.url}: ${msg}`);
      this.log(this.lastError.message);
    });
    this.ws.addEventListener("close", (ev) => {
      clearTimeout(connectTimer);
      if (!this.lastError || this._state === "open") {
        const detail = ev.code ? ` (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})` : "";
        this.lastError = new TransportError(this._state === "connecting" ? "connect" : "closed", `WebSocket ${this.url} closed${detail}`);
      }
      this.finish();
    });
  }

  get state(): TransportState {
    return this._state;
  }

  /** Number of requests awaiting a reply. */
  get inFlight(): number {
    return this.pending.size;
  }

  onEvent(cb: (event: Message) => void): () => void {
    return this.eventListeners.add(cb);
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    return this.stateListeners.add(cb);
  }

  ready(): Promise<void> {
    if (this._state === "open") return Promise.resolve();
    if (this._state === "closed") return Promise.reject(this.closedError());
    return new Promise((resolve, reject) => {
      const off = this.onStateChange((s) => {
        if (s === "open") (off(), resolve());
        else if (s === "closed") (off(), reject(this.closedError()));
      });
    });
  }

  async send(request: Message, opts: SendOptions = {}): Promise<Message> {
    if (this._state === "connecting") await this.ready();
    if (this._state !== "open") throw this.closedError();
    let id = opts.id;
    if (id === undefined) {
      const peeked = peekEnvelope(request).id;
      if (peeked === undefined || peeked === null)
        throw new TransportError("protocol", "request has no id; the WebSocket transport matches replies by id");
      id = peeked;
    }
    if (this.pending.has(id)) throw new TransportError("protocol", `request id ${String(id)} is already in flight`);
    const key = id;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<Message>((resolve, reject) => {
      const p: Pending = { resolve, reject, timer: null };
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        p.timer = setTimeout(() => {
          if (this.pending.get(key) === p) {
            this.pending.delete(key);
            reject(new TransportError("timeout", `request ${String(key)} timed out after ${timeoutMs} ms`));
          }
        }, timeoutMs);
      }
      this.pending.set(key, p);
      try {
        this.ws.send(request);
      } catch (e) {
        this.pending.delete(key);
        if (p.timer) clearTimeout(p.timer);
        reject(new TransportError("closed", `send on ${this.url} failed: ${errorMessage(e)}`, { cause: e }));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closedByUser) return;
    this.closedByUser = true;
    this.lastError = new TransportError("closed", `transport to ${this.url} closed`);
    try {
      this.ws.close(1000, "client closed");
    } catch {
      /* ignore */
    }
    this.finish();
  }

  // ---------------------------------------------------------------- internals

  private onMessage(data: unknown): void {
    let msg: Message;
    let peek: ReturnType<typeof peekEnvelope>;
    try {
      msg = toMessage(data);
      peek = peekEnvelope(msg);
    } catch (e) {
      this.log(`ignoring undecodable frame: ${errorMessage(e)}`);
      return;
    }
    if (peek.id === undefined) {
      if (peek.event !== undefined) this.eventListeners.emit(msg);
      else this.log("ignoring a message with neither id nor event");
      return;
    }
    if (peek.id === null) {
      // The server could not read a request's id (malformed envelope). Nothing to match it to.
      this.log("dropping a reply with id null (the server could not parse a request)");
      return;
    }
    const p = this.pending.get(peek.id);
    if (!p) {
      this.log(`dropping reply with unknown id ${String(peek.id)}`);
      return;
    }
    this.pending.delete(peek.id);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(msg);
  }

  private finish(): void {
    const err = this.closedError();
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.setState("closed");
  }

  private closedError(): Error {
    return this.lastError ?? new TransportError("closed", `transport to ${this.url} is closed`);
  }

  private setState(s: TransportState): void {
    if (this._state === s) return;
    this._state = s;
    this.stateListeners.emit(s);
  }
}

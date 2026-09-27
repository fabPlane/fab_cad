/**
 * `StdioTransport` — Bun-only transport that runs `FreeCADApiServer --stdio` (or anything speaking
 * the same framing) as a child process: requests on **stdin**, replies on **stdout**, events on
 * **fd 3**. Every frame is `uint32 big-endian length || payload`; the payload is a JSON (UTF-8) or
 * CBOR message exactly as on the WebSocket.
 *
 * The server answers strictly one request at a time, in order, so `send()` calls are queued FIFO
 * and replies are matched positionally. A request that times out leaves a reply we no longer want
 * behind; the count is tracked and the late frame is dropped instead of being handed to the next
 * caller. stderr is inherited (the server's log lines go to ours).
 */
import { utf8, type Message } from "@fab-cad/protocol";
import { Listeners, TransportError, errorMessage, type SendOptions, type Transport, type TransportState } from "./types";

/** Length prefix in front of every request, reply and event frame. */
export const STDIO_FRAME_HEADER_LENGTH = 4;
/** Child descriptor the server publishes events on. */
export const STDIO_EVENTS_FD = 3;

const DEFAULT_MAX_FRAME_BYTES = 512 * 1024 * 1024;

/** `uint32be length || payload`. */
export function encodeStdioFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(STDIO_FRAME_HEADER_LENGTH + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, STDIO_FRAME_HEADER_LENGTH);
  return out;
}

/** Incremental parser for the length-prefixed stream; `push()` returns the frames it completed. */
export class StdioFrameParser {
  private buf: Uint8Array = new Uint8Array(0);
  constructor(private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buf.length === 0) this.buf = chunk;
    else {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < STDIO_FRAME_HEADER_LENGTH) break;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getUint32(0, false);
      if (len > this.maxFrameBytes)
        throw new TransportError("protocol", `frame of ${len} bytes exceeds the ${this.maxFrameBytes} byte limit`);
      if (this.buf.length < STDIO_FRAME_HEADER_LENGTH + len) break;
      out.push(this.buf.slice(STDIO_FRAME_HEADER_LENGTH, STDIO_FRAME_HEADER_LENGTH + len));
      this.buf = this.buf.subarray(STDIO_FRAME_HEADER_LENGTH + len);
    }
    return out;
  }

  /** Bytes buffered behind an incomplete frame (diagnostics). */
  get pending(): number {
    return this.buf.length;
  }
}

export interface StdioTransportOptions {
  /** Executable to spawn, e.g. `FreeCADApiServer`. */
  command: string;
  /** Arguments. `--stdio` is not added for you. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Default per-request timeout when `send()` gets no `timeoutMs`. `0` disables. Default 60 000 ms. */
  defaultTimeoutMs?: number;
  /** Open the fd 3 events channel. Default `true`. */
  events?: boolean;
  /** Reject frames larger than this. Default 512 MiB. */
  maxFrameBytes?: number;
  /** How long `close()` waits after SIGTERM before SIGKILL. Default 3000 ms. */
  killGraceMs?: number;
  log?: (message: string) => void;
}

interface Pending {
  payload: Uint8Array;
  timeoutMs: number;
  resolve: (reply: Message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type Proc = Bun.Subprocess<"pipe", "pipe", "inherit">;

export class StdioTransport implements Transport {
  readonly kind = "stdio";
  readonly command: string;
  private readonly defaultTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly log: (message: string) => void;
  private proc: Proc | null = null;
  private _state: TransportState = "connecting";
  private readonly stateListeners: Listeners<[TransportState]>;
  private readonly eventListeners: Listeners<[Message]>;
  private queue: Pending[] = [];
  private inFlight: Pending | null = null;
  /** Replies belonging to timed-out requests that are still on their way. */
  private orphanReplies = 0;
  private closedByUser = false;
  private lastError: Error | null = null;
  private _eventsOpen = false;

  /** Spawn the server and resolve once its pipes are up. Rejects with `TransportError('connect')`. */
  static async connect(opts: StdioTransportOptions): Promise<StdioTransport> {
    const t = new StdioTransport(opts);
    await t.ready();
    return t;
  }

  constructor(opts: StdioTransportOptions) {
    this.command = opts.command;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.log = opts.log ?? (() => {});
    this.stateListeners = new Listeners(this.log);
    this.eventListeners = new Listeners(this.log);
    const wantEvents = opts.events !== false;
    const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    try {
      const stdio = wantEvents ? ["pipe", "pipe", "inherit", "pipe"] : ["pipe", "pipe", "inherit"];
      const proc = Bun.spawn([opts.command, ...(opts.args ?? [])], {
        cwd: opts.cwd,
        env: opts.env ? ({ ...process.env, ...opts.env } as Record<string, string>) : undefined,
        stdio: stdio as unknown as ["pipe", "pipe", "inherit"],
      }) as Proc;
      this.proc = proc;
      const eventsFd = wantEvents ? (proc as unknown as { stdio?: unknown[] }).stdio?.[STDIO_EVENTS_FD] : undefined;
      if (wantEvents && typeof eventsFd !== "number")
        this.log(`events fd ${STDIO_EVENTS_FD} is not available on this Bun build; events are off`);
      this._eventsOpen = typeof eventsFd === "number";
      void this.pumpStdout(proc, maxFrameBytes);
      if (typeof eventsFd === "number") void this.pumpEvents(eventsFd, maxFrameBytes);
      void proc.exited.then((code) => this.onExit(code));
      this.setState("open");
    } catch (e) {
      this.lastError = new TransportError("connect", `spawning ${opts.command} failed: ${errorMessage(e)}`, { cause: e });
      this.log(this.lastError.message);
      this.setState("closed");
    }
  }

  get state(): TransportState {
    return this._state;
  }

  /** True while the fd 3 events channel is readable. */
  get eventsOpen(): boolean {
    return this._eventsOpen;
  }

  /** Requests waiting behind the one in flight. */
  get queued(): number {
    return this.queue.length;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** Exit code of the server process, or `null` while it runs. */
  get exitCode(): number | null {
    return this.proc?.exitCode ?? null;
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    return this.stateListeners.add(cb);
  }

  onEvent(cb: (event: Message) => void): () => void {
    return this.eventListeners.add(cb);
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

  send(request: Message, opts: SendOptions = {}): Promise<Message> {
    if (this._state === "closed") return Promise.reject(this.closedError());
    const payload = typeof request === "string" ? utf8(request) : request;
    return new Promise<Message>((resolve, reject) => {
      this.queue.push({ payload, timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs, resolve, reject, timer: null });
      this.pump();
    });
  }

  /** Close stdin, SIGTERM, and SIGKILL after `killGraceMs` if the server is still there. */
  async close(): Promise<void> {
    if (this.closedByUser) return;
    this.closedByUser = true;
    const err = new TransportError("closed", `${this.command} closed`);
    this.lastError = err;
    this.failAll(err);
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.stdin.end();
      } catch {
        /* already gone */
      }
      proc.kill("SIGTERM");
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, this.killGraceMs);
      await proc.exited;
      clearTimeout(t);
    }
    this._eventsOpen = false;
    this.setState("closed");
  }

  // ---------------------------------------------------------------- data path

  private async pumpStdout(proc: Proc, maxFrameBytes: number): Promise<void> {
    const parser = new StdioFrameParser(maxFrameBytes);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let frames: Uint8Array[];
        try {
          frames = parser.push(new Uint8Array(value));
        } catch (e) {
          const err = e instanceof TransportError ? e : new TransportError("protocol", errorMessage(e), { cause: e });
          this.lastError = err;
          this.log(`protocol error: ${err.message}`);
          this.failAll(err);
          void this.close();
          return;
        }
        for (const frame of frames) this.onReply(frame);
      }
    } catch (e) {
      this.log(`stdout ended: ${errorMessage(e)}`);
    }
  }

  private async pumpEvents(fd: number, maxFrameBytes: number): Promise<void> {
    const parser = new StdioFrameParser(maxFrameBytes);
    const reader = Bun.file(fd).stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let frames: Uint8Array[];
        try {
          frames = parser.push(new Uint8Array(value));
        } catch (e) {
          this.log(`dropping the events channel: ${errorMessage(e)}`);
          break;
        }
        for (const frame of frames) this.eventListeners.emit(frame);
      }
    } catch (e) {
      this.log(`events fd ${STDIO_EVENTS_FD} ended: ${errorMessage(e)}`);
    }
    this._eventsOpen = false;
  }

  private onReply(frame: Uint8Array): void {
    if (this.orphanReplies > 0) {
      this.orphanReplies--;
      this.log(`dropping a late reply for a timed-out request (${this.orphanReplies} still outstanding)`);
      return;
    }
    const p = this.inFlight;
    if (!p) {
      this.log(`dropping an unsolicited reply of ${frame.length} bytes`);
      return;
    }
    this.inFlight = null;
    if (p.timer) clearTimeout(p.timer);
    p.resolve(frame);
    this.pump();
  }

  private onExit(code: number | null): void {
    if (this.closedByUser) return;
    const err = new TransportError("closed", `${this.command} exited with code ${code}`);
    this.lastError = err;
    this.log(err.message);
    this._eventsOpen = false;
    this.failAll(err);
    this.setState("closed");
  }

  private pump(): void {
    if (this._state !== "open" || this.inFlight || this.queue.length === 0) return;
    const proc = this.proc;
    if (!proc) return;
    const p = this.queue.shift()!;
    this.inFlight = p;
    if (p.timeoutMs > 0 && Number.isFinite(p.timeoutMs)) p.timer = setTimeout(() => this.onRequestTimeout(p), p.timeoutMs);
    try {
      proc.stdin.write(encodeStdioFrame(p.payload));
      proc.stdin.flush();
    } catch (e) {
      const err = new TransportError("closed", `writing to ${this.command} failed: ${errorMessage(e)}`, { cause: e });
      this.lastError = err;
      this.failAll(err);
      this.setState("closed");
    }
  }

  private onRequestTimeout(p: Pending): void {
    if (this.inFlight !== p) return;
    this.inFlight = null;
    p.timer = null;
    // The server will still answer this one; without ids on this channel the only correlation is order.
    this.orphanReplies++;
    p.reject(new TransportError("timeout", `request to ${this.command} timed out after ${p.timeoutMs} ms`));
    this.pump();
  }

  private failAll(err: Error): void {
    if (this.inFlight) {
      const p = this.inFlight;
      this.inFlight = null;
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    const q = this.queue;
    this.queue = [];
    for (const p of q) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private closedError(): Error {
    return this.lastError ?? new TransportError("closed", `${this.command} is closed`);
  }

  private setState(s: TransportState): void {
    if (this._state === s) return;
    this._state = s;
    this.stateListeners.emit(s);
  }
}

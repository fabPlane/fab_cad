/**
 * Layer 1 — transport. Moves whole encoded messages (a JSON string or bytes; see `Message` in
 * `@fab-cad/protocol`) to a FreeCAD API server and back. It knows the envelope only as far as it
 * must to route: the WebSocket transport reads a reply's `id` to find its caller, the stdio and
 * wasm transports match replies by position. Encoding and decoding the payload happen above.
 */
import type { Message, RequestId } from "@fab-cad/protocol";

export type { Message };

export type TransportState = "connecting" | "open" | "closed";

export interface SendOptions {
  /** Reject with `TransportError('timeout')` if no reply arrives within this many milliseconds. */
  timeoutMs?: number;
  /**
   * The request's `id`, when the caller knows it (the client always does). Transports that match
   * replies by id read it from the message otherwise.
   */
  id?: RequestId;
}

export interface Transport {
  /** Send one request and resolve with the raw reply. Calls may be issued concurrently. */
  send(request: Message, opts?: SendOptions): Promise<Message>;
  /** Subscribe to raw event messages (`{event, seq, data}`). Returns an unsubscribe function. */
  onEvent(cb: (event: Message) => void): () => void;
  /** Close the transport. Pending requests are rejected with `TransportError('closed')`. Idempotent. */
  close(): Promise<void>;
  readonly state: TransportState;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(cb: (state: TransportState) => void): () => void;
  /** `websocket`, `stdio` or `wasm` — diagnostics only. */
  readonly kind: string;
}

export type TransportErrorCode = "timeout" | "closed" | "protocol" | "connect";

export class TransportError extends Error {
  override readonly name = "TransportError";
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  static is(e: unknown, code?: TransportErrorCode): e is TransportError {
    return e instanceof TransportError && (code === undefined || e.code === code);
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A small listener set that isolates listener exceptions. */
export class Listeners<T extends unknown[]> {
  private readonly set = new Set<(...args: T) => void>();

  constructor(private readonly log: (message: string) => void = () => {}) {}

  add(cb: (...args: T) => void): () => void {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }

  emit(...args: T): void {
    for (const cb of Array.from(this.set)) {
      try {
        cb(...args);
      } catch (e) {
        this.log(`listener threw: ${errorMessage(e)}`);
      }
    }
  }

  clear(): void {
    this.set.clear();
  }

  get size(): number {
    return this.set.size;
  }
}

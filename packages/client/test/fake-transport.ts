import {
  decodeMessage,
  encodeMessage,
  type Encoding,
  type EventMessage,
  type Message,
  type Request,
  type Response,
} from "@fab-cad/protocol";
import type { SendOptions, Transport, TransportState } from "../src/transport/types";

/** A transport answering from a function, for client-level tests. */
export class FakeTransport implements Transport {
  readonly kind = "fake";
  state: TransportState = "open";
  readonly requests: Request[] = [];
  private readonly eventCbs = new Set<(m: Message) => void>();

  constructor(private readonly answer: (req: Request) => Omit<Response, "id">) {}

  async send(request: Message, _opts?: SendOptions): Promise<Message> {
    const req = decodeMessage<Request>(request);
    this.requests.push(req);
    const enc: Encoding = typeof request === "string" ? "json" : "cbor";
    return encodeMessage({ id: req.id, ...this.answer(req) }, enc);
  }

  emit(ev: EventMessage, encoding: Encoding = "cbor"): void {
    const m = encodeMessage(ev, encoding);
    for (const cb of this.eventCbs) cb(m);
  }

  onEvent(cb: (m: Message) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onStateChange(): () => void {
    return () => {};
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

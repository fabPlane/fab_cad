/**
 * The envelope (PROTOCOL.md, "Encoding" / "Request" / "Response" / "Events") and its two
 * encodings.
 *
 * A message is a JSON object sent as JSON text or as CBOR; the first byte tells them apart (`{` is
 * JSON, anything else CBOR). Binary data is a CBOR byte string, or `{"$bytes": "<base64>"}` in JSON.
 * Both decoders return byte data as a plain `Uint8Array` (never a Node `Buffer`, never a `$bytes`
 * object) and both encoders accept `Uint8Array` anywhere in the message, so callers see one shape
 * regardless of the encoding.
 */
import { Decoder, Encoder } from "cbor-x";
import type { CommandName, EventName, Events, ParamsOf, ResultOf } from "./commands";
import { base64ToBytes, bytesToBase64 } from "./values";

export type Encoding = "json" | "cbor";

/** What travels: JSON text as a string (a WebSocket text frame) or bytes (CBOR, or UTF-8 JSON). */
export type Message = string | Uint8Array;

export type RequestId = number | string;

export const STATUSES = ["OK", "BAD_REQUEST", "UNKNOWN_COMMAND", "NOT_FOUND", "TOKEN_MISMATCH", "FORBIDDEN", "FAILED"] as const;
export type Status = (typeof STATUSES)[number];

export interface Request<K extends CommandName = CommandName> {
  id: RequestId;
  cmd: K;
  params?: ParamsOf<K>;
  token?: string;
  client?: string;
}

export interface OkResponse<K extends CommandName = CommandName> {
  id: RequestId | null;
  status: "OK";
  token: string;
  result: ResultOf<K>;
}

export interface ErrorResponse {
  /** `null` when the request was too malformed to carry an id. */
  id: RequestId | null;
  status: Exclude<Status, "OK">;
  token: string;
  error: string;
}

export type Response<K extends CommandName = CommandName> = OkResponse<K> | ErrorResponse;

export interface EventMessage<E extends EventName = EventName> {
  event: E;
  seq: number;
  data: Events[E];
}

/** Anything that can arrive on a connection. */
export type Incoming = Response | EventMessage;

export function isEventMessage(m: unknown): m is EventMessage {
  return typeof m === "object" && m !== null && typeof (m as { event?: unknown }).event === "string" && !("id" in m);
}

export function isResponse(m: unknown): m is Response {
  return typeof m === "object" && m !== null && typeof (m as { status?: unknown }).status === "string" && "id" in m;
}

export function isRequest(m: unknown): m is Request {
  return typeof m === "object" && m !== null && typeof (m as { cmd?: unknown }).cmd === "string";
}

// ------------------------------------------------------------------------------------ helpers

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return utf8Enc.encode(s);
}

/** Normalises the message shapes a socket or worker can hand over into a `Message`. */
export function toMessage(data: unknown): Message {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return plainBytes(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer) return new Uint8Array(data);
  throw new TypeError(`not a message: ${Object.prototype.toString.call(data)}`);
}

/** `Buffer` (a `Uint8Array` subclass) as a plain `Uint8Array` view over the same memory. */
function plainBytes(b: Uint8Array): Uint8Array {
  return b.constructor === Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/** Which encoding a message uses: text and bytes starting with `{` are JSON. */
export function detectEncoding(m: Message): Encoding {
  if (typeof m === "string") return "json";
  // Leading whitespace is legal JSON; CBOR maps start at 0xA0.
  for (let i = 0; i < m.length; i++) {
    const b = m[i]!;
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) continue;
    return b === 0x7b ? "json" : "cbor";
  }
  return "cbor";
}

// --------------------------------------------------------------------------------------- JSON

/** Replace `Uint8Array`s with `{$bytes}` and drop `undefined` members, as `JSON.stringify` would. */
function jsonReplacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  // JSON.stringify calls toJSON on Buffers before the replacer sees them.
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return { $bytes: bytesToBase64(Uint8Array.from((value as { data: number[] }).data)) };
  }
  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const b = (value as { $bytes?: unknown }).$bytes;
    if (typeof b === "string" && Object.keys(value).length === 1) return base64ToBytes(b);
  }
  return value;
}

export function encodeJson(message: object): string {
  return JSON.stringify(message, jsonReplacer);
}

export function decodeJson<T = unknown>(text: string | Uint8Array): T {
  return JSON.parse(typeof text === "string" ? text : utf8Dec.decode(text), jsonReviver) as T;
}

// --------------------------------------------------------------------------------------- CBOR

const cborEncoder = new Encoder({
  // Plain RFC 8949: no record extension, no tag 64 on Uint8Array, no tag 259 on maps.
  useRecords: false,
  mapsAsObjects: true,
  tagUint8Array: false,
  useTag259ForMaps: false,
  variableMapSize: true,
  pack: false,
} as ConstructorParameters<typeof Encoder>[0]);

const cborDecoder = new Decoder({ useRecords: false, mapsAsObjects: true } as ConstructorParameters<typeof Decoder>[0]);

/** Drop `undefined` members (CBOR would carry them as `undefined`, JSON drops them). */
function stripUndefined(v: unknown): unknown {
  if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      const y = x === undefined ? null : stripUndefined(x);
      if (y !== x) (copy ??= v.slice())[i] = y;
    }
    return copy ?? v;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) {
      copy ??= { ...(v as Record<string, unknown>) };
      delete copy[k];
      continue;
    }
    const y = stripUndefined(x);
    if (y !== x) (copy ??= { ...(v as Record<string, unknown>) })[k] = y;
  }
  return copy ?? v;
}

/** Byte strings as plain `Uint8Array` views (cbor-x gives `Buffer`s under Bun/Node). */
function normaliseBytes(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return plainBytes(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = normaliseBytes(v[i]);
    return v;
  }
  if (ArrayBuffer.isView(v)) return v;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) o[k] = normaliseBytes(o[k]);
  return o;
}

export function encodeCbor(message: object): Uint8Array {
  return plainBytes(cborEncoder.encode(stripUndefined(message)));
}

export function decodeCbor<T = unknown>(bytes: Uint8Array): T {
  return normaliseBytes(cborDecoder.decode(bytes)) as T;
}

// ----------------------------------------------------------------------------------- envelope

/** Encode for a WebSocket: JSON as text, CBOR as bytes. */
export function encodeMessage(message: object, encoding: Encoding): Message {
  return encoding === "json" ? encodeJson(message) : encodeCbor(message);
}

/** Encode for a byte channel (stdio, the wasm ABI): JSON as UTF-8, CBOR as is. */
export function encodeMessageBytes(message: object, encoding: Encoding): Uint8Array {
  return encoding === "json" ? utf8(encodeJson(message)) : encodeCbor(message);
}

/** Decode any message, whatever its encoding. */
export function decodeMessage<T = unknown>(message: Message): T {
  if (typeof message === "string") return decodeJson<T>(message);
  return detectEncoding(message) === "json" ? decodeJson<T>(message) : decodeCbor<T>(message);
}

export const encodeRequest = (req: Request, encoding: Encoding): Message => encodeMessage(req, encoding);
export const encodeResponse = (res: Response, encoding: Encoding): Message => encodeMessage(res, encoding);
export const encodeEvent = (ev: EventMessage, encoding: Encoding): Message => encodeMessage(ev, encoding);

export function decodeIncoming(message: Message): Incoming {
  const m = decodeMessage<unknown>(message);
  if (isEventMessage(m) || isResponse(m)) return m;
  throw new Error("message is neither a response nor an event");
}

// --------------------------------------------------------------------------------------- peek

export interface EnvelopePeek {
  /** The `id` member, when present (`null` when present and null). */
  id?: RequestId | null;
  /** The `event` member, when present. */
  event?: string;
}

/**
 * Read just `id` / `event` of a message without decoding the payload — what a transport needs to
 * route replies and events. CBOR is walked (values it does not need are skipped, so a multi-MB
 * tessellation costs nothing); JSON is parsed, it is not the geometry path.
 */
export function peekEnvelope(message: Message): EnvelopePeek {
  if (detectEncoding(message) === "json") {
    const m = decodeMessage<Record<string, unknown>>(message);
    const out: EnvelopePeek = {};
    if (m && typeof m === "object") {
      if ("id" in m) out.id = m.id as RequestId | null;
      if (typeof m.event === "string") out.event = m.event;
    }
    return out;
  }
  return peekCbor(message as Uint8Array);
}

class CborCursor {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  private need(n: number): void {
    if (this.pos + n > this.b.length) throw new Error("truncated CBOR");
  }

  /** Header: major type and argument (length/value); `-1` argument means indefinite length. */
  head(): { major: number; arg: number; info: number } {
    this.need(1);
    const ib = this.b[this.pos++]!;
    const major = ib >> 5;
    const info = ib & 31;
    let arg: number;
    if (info < 24) arg = info;
    else if (info === 24) (this.need(1), (arg = this.b[this.pos]!), (this.pos += 1));
    else if (info === 25) (this.need(2), (arg = (this.b[this.pos]! << 8) | this.b[this.pos + 1]!), (this.pos += 2));
    else if (info === 26) {
      this.need(4);
      arg = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4).getUint32(0);
      this.pos += 4;
    } else if (info === 27) {
      this.need(8);
      arg = Number(new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8).getBigUint64(0));
      this.pos += 8;
    } else if (info === 31) arg = -1;
    else throw new Error(`bad CBOR additional info ${info}`);
    return { major, arg, info };
  }

  isBreak(): boolean {
    return this.b[this.pos] === 0xff;
  }

  skip(): void {
    const { major, arg, info } = this.head();
    switch (major) {
      case 0:
      case 1:
        return;
      case 2:
      case 3:
        if (arg < 0) {
          while (!this.isBreak()) this.skip();
          this.pos++;
        } else {
          this.need(arg);
          this.pos += arg;
        }
        return;
      case 4:
        if (arg < 0) {
          while (!this.isBreak()) this.skip();
          this.pos++;
        } else for (let i = 0; i < arg; i++) this.skip();
        return;
      case 5:
        if (arg < 0) {
          while (!this.isBreak()) (this.skip(), this.skip());
          this.pos++;
        } else for (let i = 0; i < arg; i++) (this.skip(), this.skip());
        return;
      case 6:
        this.skip();
        return;
      case 7:
        void info; // simple values and floats: the head already consumed them
        return;
    }
  }

  /** A text string at the cursor, or `undefined` (cursor then past the value). */
  text(): string | undefined {
    const start = this.pos;
    const { major, arg } = this.head();
    if (major !== 3 || arg < 0) {
      this.pos = start;
      this.skip();
      return undefined;
    }
    this.need(arg);
    const s = utf8Dec.decode(this.b.subarray(this.pos, this.pos + arg));
    this.pos += arg;
    return s;
  }

  /** A scalar id (int, text, null) at the cursor. */
  scalar(): RequestId | null | undefined {
    const start = this.pos;
    const { major, arg, info } = this.head();
    if (major === 0) return arg;
    if (major === 1) return -1 - arg;
    if (major === 7 && info === 22) return null;
    if (major === 7 && (info === 25 || info === 26 || info === 27)) {
      const end = start + 1 + (1 << (info - 24));
      this.pos = end;
      return decodeCbor<number>(this.b.subarray(start, end));
    }
    this.pos = start;
    if (major === 3) return this.text();
    this.skip();
    return undefined;
  }
}

function peekCbor(bytes: Uint8Array): EnvelopePeek {
  const c = new CborCursor(bytes);
  const out: EnvelopePeek = {};
  let { major, arg } = c.head();
  while (major === 6) ({ major, arg } = c.head()); // tolerate a self-describe tag
  if (major !== 5) return out;
  for (let i = 0; arg < 0 ? !c.isBreak() : i < arg; i++) {
    const key = c.text();
    if (key === "id") out.id = c.scalar();
    else if (key === "event") out.event = c.text();
    else c.skip();
    if (out.id !== undefined && out.event !== undefined) break;
  }
  return out;
}

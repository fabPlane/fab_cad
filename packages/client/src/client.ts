/**
 * Layer 2 — `FreeCADClient`: wraps a command in the envelope, sends it through a `Transport`,
 * decodes the reply and maps a non-`OK` status to `FreeCADApiError`.
 *
 * - `call(cmd, params)` is typed from `Commands` in `@fab-cad/protocol`; there is also one method
 *   per command (`getObjects(doc)`, `setProperties(doc, obj, values)`, `tessellate(doc)`, ...).
 * - The first reply's token is pinned and sent with every later request. A server that restarted
 *   answers `TOKEN_MISMATCH` (or a different token); the client emits `restarted`, pins the new
 *   token and throws, so the UI can reload its state.
 * - Events are decoded and delivered to typed listeners: `client.on("ObjectChanged", cb)`.
 *   Sequence gaps are reported through `onGap` (events were lost; re-read state).
 */
import {
  decodeMessage,
  decodeTessellation,
  encodeMessage,
  isEventMessage,
  toWire,
  type CommandName,
  type DecodeTessellationOptions,
  type Encoding,
  type EventMessage,
  type EventName,
  type Events,
  type ExportFormat,
  type Message,
  type ParamsOf,
  type PropertyInput,
  type Request,
  type Response,
  type ResultOf,
  type Tessellation,
} from "@fab-cad/protocol";
import { FreeCADApiError } from "./errors";
import { Listeners, TransportError, errorMessage, type Transport } from "./transport/types";

export interface FreeCADClientOptions {
  /** Encoding of requests (and so of replies). Default `cbor`. */
  encoding?: Encoding;
  /** Reported by the server in the events a request caused (`data.client`). Default `fab-cad`. */
  clientName?: string;
  /** Token of the instance expected; learned from the first reply when omitted. */
  token?: string;
  /** Default timeout per request. Default 60 000 ms. */
  defaultTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface CallOptions {
  timeoutMs?: number;
}

export interface RestartInfo {
  previousToken: string;
  newToken: string;
  command: string;
}

export interface EventGap {
  /** Last sequence number seen. */
  last: number;
  /** The one that arrived. */
  received: number;
}

type AnyEventListener = (data: Events[EventName], event: EventMessage) => void;

export class FreeCADClient {
  readonly transport: Transport;
  readonly encoding: Encoding;
  readonly clientName: string;
  readonly defaultTimeoutMs: number;
  private _token: string | undefined;
  private nextId = 1;
  private lastSeq: number | undefined;
  private readonly log: (message: string) => void;
  private readonly eventListeners = new Map<EventName | "*", Listeners<[never, EventMessage]>>();
  private readonly restartListeners: Listeners<[RestartInfo]>;
  private readonly gapListeners: Listeners<[EventGap]>;
  private readonly offTransport: () => void;

  /** Create a client and ping the server once (which pins its token). */
  static async connect(transport: Transport, opts: FreeCADClientOptions = {}): Promise<FreeCADClient> {
    const client = new FreeCADClient(transport, opts);
    await client.ping();
    return client;
  }

  constructor(transport: Transport, opts: FreeCADClientOptions = {}) {
    this.transport = transport;
    this.encoding = opts.encoding ?? "cbor";
    this.clientName = opts.clientName ?? "fab-cad";
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this._token = opts.token;
    this.log = opts.log ?? (() => {});
    this.restartListeners = new Listeners(this.log);
    this.gapListeners = new Listeners(this.log);
    this.offTransport = transport.onEvent((m) => this.onEventMessage(m));
  }

  /** The pinned server token, once known. */
  get token(): string | undefined {
    return this._token;
  }

  /** Highest event sequence number seen. */
  get lastEventSeq(): number | undefined {
    return this.lastSeq;
  }

  // ------------------------------------------------------------------------------ core

  /** Send one command and return its result; throws `FreeCADApiError` for a non-`OK` reply. */
  async call<K extends CommandName>(cmd: K, params?: ParamsOf<K>, opts: CallOptions = {}): Promise<ResultOf<K>> {
    const id = this.nextId++;
    const request: Request<K> = { id, cmd, params: params ?? ({} as ParamsOf<K>), token: this._token ?? "", client: this.clientName };
    const raw = await this.transport.send(encodeMessage(request, this.encoding), {
      id,
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
    });
    let reply: Response<K>;
    try {
      reply = decodeMessage<Response<K>>(raw);
    } catch (e) {
      throw new TransportError("protocol", `${cmd}: cannot decode the reply: ${errorMessage(e)}`, { cause: e });
    }
    if (typeof reply !== "object" || reply === null || typeof reply.status !== "string") {
      throw new TransportError("protocol", `${cmd}: the reply is not a response envelope`);
    }
    if (reply.id !== null && reply.id !== undefined && reply.id !== id) {
      throw new TransportError("protocol", `${cmd}: reply id ${String(reply.id)} does not match request id ${id}`);
    }
    this.checkToken(reply.token, cmd);
    if (reply.status !== "OK") throw new FreeCADApiError(reply.status, reply.error ?? "", cmd);
    return (reply.result ?? null) as ResultOf<K>;
  }

  private checkToken(token: string | undefined, command: string): void {
    if (!token) return;
    if (this._token === undefined || this._token === "") {
      this._token = token;
      return;
    }
    if (token !== this._token) {
      const info: RestartInfo = { previousToken: this._token, newToken: token, command };
      this._token = token;
      this.lastSeq = undefined;
      this.log(`server restarted (token ${info.previousToken} -> ${token})`);
      this.restartListeners.emit(info);
    }
  }

  // ------------------------------------------------------------------------------ events

  /** Typed event subscription. `"*"` receives every event. Returns an unsubscribe function. */
  on<E extends EventName>(event: E, cb: (data: Events[E], message: EventMessage<E>) => void): () => void;
  on(event: "*", cb: AnyEventListener): () => void;
  on(event: EventName | "*", cb: (data: never, message: never) => void): () => void {
    let set = this.eventListeners.get(event);
    if (!set) this.eventListeners.set(event, (set = new Listeners(this.log)));
    return set.add(cb as (data: never, message: EventMessage) => void);
  }

  /** Resolves with the next event of that name (optionally matching `filter`), or rejects after `timeoutMs`. */
  next<E extends EventName>(event: E, opts: { timeoutMs?: number; filter?: (data: Events[E]) => boolean } = {}): Promise<Events[E]> {
    return new Promise((resolve, reject) => {
      const timer = opts.timeoutMs
        ? setTimeout(() => (off(), reject(new Error(`timed out waiting for ${event}`))), opts.timeoutMs)
        : undefined;
      const off = this.on(event, (data) => {
        if (opts.filter && !opts.filter(data)) return;
        if (timer) clearTimeout(timer);
        off();
        resolve(data);
      });
    });
  }

  /** The server restarted (its token changed). Everything cached about it is stale. */
  onRestarted(cb: (info: RestartInfo) => void): () => void {
    return this.restartListeners.add(cb);
  }

  /** Events were missed (a `seq` jumped); re-read state. */
  onGap(cb: (gap: EventGap) => void): () => void {
    return this.gapListeners.add(cb);
  }

  private onEventMessage(m: Message): void {
    let ev: unknown;
    try {
      ev = decodeMessage(m);
    } catch (e) {
      this.log(`dropping an undecodable event: ${errorMessage(e)}`);
      return;
    }
    if (!isEventMessage(ev)) {
      this.log("dropping a message that is not an event");
      return;
    }
    if (typeof ev.seq === "number") {
      if (this.lastSeq !== undefined && ev.seq > this.lastSeq + 1) this.gapListeners.emit({ last: this.lastSeq, received: ev.seq });
      if (this.lastSeq === undefined || ev.seq > this.lastSeq || ev.seq === 1) this.lastSeq = ev.seq;
    }
    this.eventListeners.get(ev.event)?.emit(ev.data as never, ev);
    this.eventListeners.get("*")?.emit(ev.data as never, ev);
  }

  /** Detach from the transport and close it. */
  async close(): Promise<void> {
    this.offTransport();
    for (const l of this.eventListeners.values()) l.clear();
    await this.transport.close();
  }

  // ------------------------------------------------------------------------------ server

  ping(): Promise<null> {
    return this.call("Ping");
  }

  getVersion(): Promise<ResultOf<"GetVersion">> {
    return this.call("GetVersion");
  }

  getServerInfo(): Promise<ResultOf<"GetServerInfo">> {
    return this.call("GetServerInfo");
  }

  getCommands(): Promise<ResultOf<"GetCommands">> {
    return this.call("GetCommands");
  }

  getTypes(base?: string): Promise<string[]> {
    return this.call("GetTypes", base === undefined ? {} : { base });
  }

  loadModule(name: string): Promise<null> {
    return this.call("LoadModule", { name });
  }

  // ------------------------------------------------------------------------------ documents

  listDocuments(): Promise<ResultOf<"ListDocuments">> {
    return this.call("ListDocuments");
  }

  newDocument(opts: ParamsOf<"NewDocument"> = {}): Promise<ResultOf<"NewDocument">> {
    return this.call("NewDocument", opts);
  }

  openDocument(path: string): Promise<ResultOf<"OpenDocument">> {
    return this.call("OpenDocument", { path });
  }

  openDocumentBytes(data: Uint8Array, fileName?: string): Promise<ResultOf<"OpenDocumentBytes">> {
    return this.call("OpenDocumentBytes", fileName === undefined ? { data } : { data, fileName });
  }

  saveDocument(doc: string): Promise<ResultOf<"SaveDocument">> {
    return this.call("SaveDocument", { doc });
  }

  saveDocumentAs(doc: string, path: string): Promise<ResultOf<"SaveDocumentAs">> {
    return this.call("SaveDocumentAs", { doc, path });
  }

  saveDocumentBytes(doc: string): Promise<ResultOf<"SaveDocumentBytes">> {
    return this.call("SaveDocumentBytes", { doc });
  }

  closeDocument(doc: string): Promise<null> {
    return this.call("CloseDocument", { doc });
  }

  setActiveDocument(doc: string): Promise<null> {
    return this.call("SetActiveDocument", { doc });
  }

  recompute(doc: string, force?: boolean): Promise<ResultOf<"Recompute">> {
    return this.call("Recompute", force === undefined ? { doc } : { doc, force });
  }

  undo(doc: string): Promise<ResultOf<"Undo">> {
    return this.call("Undo", { doc });
  }

  redo(doc: string): Promise<ResultOf<"Redo">> {
    return this.call("Redo", { doc });
  }

  getUndoStack(doc: string): Promise<ResultOf<"GetUndoStack">> {
    return this.call("GetUndoStack", { doc });
  }

  openTransaction(doc: string, name: string): Promise<null> {
    return this.call("OpenTransaction", { doc, name });
  }

  commitTransaction(doc: string): Promise<null> {
    return this.call("CommitTransaction", { doc });
  }

  abortTransaction(doc: string): Promise<null> {
    return this.call("AbortTransaction", { doc });
  }

  /** Run `body` inside one named transaction: committed when it resolves, aborted when it throws. */
  async transaction<T>(doc: string, name: string, body: () => Promise<T>): Promise<T> {
    await this.openTransaction(doc, name);
    let result: T;
    try {
      result = await body();
    } catch (e) {
      try {
        await this.abortTransaction(doc);
      } catch (abortError) {
        this.log(`AbortTransaction failed: ${errorMessage(abortError)}`);
      }
      throw e;
    }
    await this.commitTransaction(doc);
    return result;
  }

  // ------------------------------------------------------------------------------ objects

  getObjects(doc: string): Promise<ResultOf<"GetObjects">> {
    return this.call("GetObjects", { doc });
  }

  getObject(doc: string, object: string, opts: { properties?: boolean } = {}): Promise<ResultOf<"GetObject">> {
    return this.call("GetObject", opts.properties ? { doc, object, properties: true } : { doc, object });
  }

  getProperties(doc: string, object: string, names?: string[]): Promise<ResultOf<"GetProperties">> {
    return this.call("GetProperties", names ? { doc, object, names } : { doc, object });
  }

  /** Values may be wire values or the classes from `@fab-cad/protocol` (`Placement`, `Quantity`, ...). */
  setProperties(doc: string, object: string, values: Record<string, PropertyInput>): Promise<ResultOf<"SetProperties">> {
    return this.call("SetProperties", { doc, object, values: wireValues(values) });
  }

  async setProperty(
    doc: string,
    object: string,
    name: string,
    value: PropertyInput,
  ): Promise<ResultOf<"SetProperties">[number] | undefined> {
    return (await this.setProperties(doc, object, { [name]: value }))[0];
  }

  /** `null` clears the expression. */
  setExpression(doc: string, object: string, path: string, expression: string | null): Promise<null> {
    return this.call("SetExpression", { doc, object, path, expression });
  }

  addObject(
    doc: string,
    type: string,
    opts: { name?: string; label?: string; properties?: Record<string, PropertyInput>; group?: string } = {},
  ): Promise<ResultOf<"AddObject">> {
    const params: ParamsOf<"AddObject"> = { doc, type };
    if (opts.name !== undefined) params.name = opts.name;
    if (opts.label !== undefined) params.label = opts.label;
    if (opts.group !== undefined) params.group = opts.group;
    if (opts.properties !== undefined) params.properties = wireValues(opts.properties);
    return this.call("AddObject", params);
  }

  removeObject(doc: string, object: string, recursive?: boolean): Promise<null> {
    return this.call("RemoveObject", recursive === undefined ? { doc, object } : { doc, object, recursive });
  }

  addProperty(
    doc: string,
    object: string,
    type: string,
    name: string,
    opts: { group?: string; documentation?: string } = {},
  ): Promise<ResultOf<"AddProperty">> {
    return this.call("AddProperty", { doc, object, type, name, ...opts });
  }

  removeProperty(doc: string, object: string, name: string): Promise<null> {
    return this.call("RemoveProperty", { doc, object, name });
  }

  // ------------------------------------------------------------------------------ geometry

  /** `Tessellate`, decoded into typed arrays. `call("Tessellate", …)` gives the raw bytes. */
  async tessellate(
    doc: string,
    opts: { objects?: string[]; deflection?: number; edges?: boolean } & DecodeTessellationOptions = {},
  ): Promise<Tessellation[]> {
    const { normals, ...rest } = opts;
    const raw = await this.call("Tessellate", { doc, ...rest });
    return raw.map((t) => decodeTessellation(t, { normals }));
  }

  getBoundingBox(doc: string, objects?: string[]): Promise<ResultOf<"GetBoundingBox">> {
    return this.call("GetBoundingBox", objects ? { doc, objects } : { doc });
  }

  // ------------------------------------------------------------------------------ import / export / python

  /** `Import` (named so because `import` reads badly as a method). */
  importFile(doc: string, file: { path?: string; data?: Uint8Array; fileName: string }): Promise<string[]> {
    return this.call("Import", { doc, ...file });
  }

  /** `Export`. */
  exportObjects(doc: string, objects: string[], format: ExportFormat): Promise<ResultOf<"Export">> {
    return this.call("Export", { doc, objects, format });
  }

  runPython(code: string, mode?: "exec" | "eval" | "auto"): Promise<ResultOf<"RunPython">> {
    return this.call("RunPython", mode === undefined ? { code } : { code, mode });
  }
}

function wireValues(values: Record<string, PropertyInput>): Record<string, PropertyInput> {
  const out: Record<string, PropertyInput> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = toWire(v);
  return out;
}

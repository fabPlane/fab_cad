/**
 * `MockFreeCAD` — an in-memory stand-in for FreeCAD's API dispatcher (`Api::Server::dispatch`).
 *
 * It implements PROTOCOL.md v1 on decoded messages: documents, objects of the types in
 * `./types`, property get/set with FreeCAD's coercions (quantities from numbers or strings,
 * placements from quaternions or axis/angle), expressions, recompute with real tessellations,
 * transactions with undo/redo, and the events FreeCAD raises. The transports around it
 * (`./dispatcher`, `./server`, `./stdio`) only encode, decode and deliver.
 *
 * Behaviour a real FreeCAD may not share, chosen so the UI has something sensible to talk to:
 * - A modifying command outside an explicit transaction gets its own transaction (named like
 *   the GUI names them), so every edit is undoable; `Recompute` is never a transaction.
 * - `SaveDocumentBytes` / `OpenDocumentBytes` use a JSON stand-in for `.FCStd` (a zip in FreeCAD).
 * - `Export` writes `stl` and `obj` only; `Import` and `RunPython` are refused.
 * - `Angle` on cylinders and spheres is kept but the mesh is always the full solid.
 */
import {
  COMMAND_NAMES,
  PROTOCOL_VERSION,
  Placement,
  Rotation,
  Vector,
  decodeJson,
  encodeJson,
  float32Bytes,
  isTaggedAs,
  parseQuantity,
  uint32Bytes,
  unitDimension,
  utf8,
  type BoundBox,
  type CommandName,
  type DocumentInfo,
  type EventMessage,
  type EventName,
  type Events,
  type ObjectInfo,
  type PropertyInfo,
  type Request,
  type Response,
  type Status,
  type UndoStack,
  type WireObjectRef,
  type WirePlacement,
  type WireQuantity,
  type WireTessellation,
  type WireValue,
} from "@fab-cad/protocol";
import { compileExpression, type ExprRef } from "./expressions";
import {
  boundsOf,
  boxMesh,
  circleSegments,
  cylinderMesh,
  diagonal,
  sphereMesh,
  transformMesh,
  unionBounds,
  type BBox,
  type Mesh,
} from "./geometry";
import { TYPES, dynamicPropertyDefault, knownType, q, typesDerivedFrom, type Prop, type TypeDef } from "./types";

export interface MockFileSystem {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
}

export interface MockFreeCADOptions {
  /** Instance token; random when omitted. */
  token?: string;
  /** Start with the demo document (`Demo`: a group with a box, a cylinder and a sphere). Default false. */
  demo?: boolean;
  /** Reported by `GetServerInfo`: `ws`, `stdio` or `inproc`. Default `inproc`. */
  transport?: string;
  url?: string;
  /** Backs `OpenDocument` / `SaveDocument` / `SaveDocumentAs`; they fail without one. */
  fs?: MockFileSystem;
}

export class ApiFailure extends Error {
  constructor(
    readonly status: Exclude<Status, "OK">,
    message: string,
  ) {
    super(message);
  }
}

const bad = (m: string) => new ApiFailure("BAD_REQUEST", m);
const notFound = (m: string) => new ApiFailure("NOT_FOUND", m);
const failed = (m: string) => new ApiFailure("FAILED", m);

interface Shape {
  kind: "box" | "cylinder" | "sphere";
  /** Dimensions in mm: box `[L, W, H]`, cylinder `[r, h]`, sphere `[r]`. */
  dims: number[];
  placement: WirePlacement;
  revision: number;
}

interface SerializedObject {
  name: string;
  type: string;
  props: Prop[];
  touched: boolean;
  error: string | null;
  shape: Shape | null;
}

interface Snapshot {
  objects: SerializedObject[];
}

class MockObject {
  touched = true;
  error: string | null = null;
  shape: Shape | null = null;

  constructor(
    readonly name: string,
    readonly type: TypeDef,
    readonly props: Map<string, Prop>,
  ) {}

  prop(name: string): Prop | undefined {
    return this.props.get(name);
  }

  get label(): string {
    return String(this.props.get("Label")?.value ?? this.name);
  }

  get visibility(): boolean {
    return this.props.get("Visibility")?.value !== false;
  }

  num(name: string): number {
    const v = this.props.get(name)?.value;
    if (typeof v === "number") return v;
    if (isTaggedAs(v, "Quantity")) return v.value;
    return 0;
  }

  serialize(): SerializedObject {
    return structuredClone({
      name: this.name,
      type: this.type.name,
      props: [...this.props.values()],
      touched: this.touched,
      error: this.error,
      shape: this.shape,
    });
  }

  static restore(s: SerializedObject): MockObject {
    const c = structuredClone(s);
    const o = new MockObject(c.name, TYPES[c.type]!, new Map(c.props.map((p) => [p.name, p])));
    o.touched = c.touched;
    o.error = c.error;
    o.shape = c.shape;
    return o;
  }
}

interface Transaction {
  name: string;
  before: Snapshot;
}

class MockDocument {
  fileName = "";
  modified = false;
  readonly objects = new Map<string, MockObject>();
  undo: Transaction[] = [];
  redo: Transaction[] = [];
  open: (Transaction & { changes: number }) | null = null;
  /** Bumped by every change; tells an auto transaction whether it recorded anything. */
  changes = 0;

  constructor(
    readonly name: string,
    public label: string,
  ) {}

  snapshot(): Snapshot {
    return { objects: [...this.objects.values()].map((o) => o.serialize()) };
  }

  restore(s: Snapshot): void {
    this.objects.clear();
    for (const o of s.objects) this.objects.set(o.name, MockObject.restore(o));
  }

  object(name: string): MockObject {
    const o = this.objects.get(name);
    if (!o) throw notFound(`No object '${name}' in document '${this.name}'`);
    return o;
  }

  byLabelOrName(ref: string): MockObject | undefined {
    if (ref.startsWith("<<") && ref.endsWith(">>")) {
      const label = ref.slice(2, -2);
      return [...this.objects.values()].find((o) => o.label === label);
    }
    return this.objects.get(ref);
  }
}

/** Events collected while one request runs; delivered after its reply. */
class RequestContext {
  readonly events: { event: EventName; data: Record<string, unknown> }[] = [];
  private readonly changed = new Set<string>();

  constructor(readonly client: string | undefined) {}

  emit<E extends EventName>(event: E, data: Omit<Events[E], "client">): void {
    if (event === "ObjectChanged") {
      // Coalesced per request: one event per (object, property).
      const d = data as unknown as Events["ObjectChanged"];
      const key = `${d.doc}\0${d.object}\0${d.property}`;
      if (this.changed.has(key)) return;
      this.changed.add(key);
    }
    this.events.push({ event, data: this.client ? { ...data, client: this.client } : { ...data } });
  }
}

type Handler = (p: Record<string, unknown>, ctx: RequestContext) => unknown;

const MODULES = new Set([
  "Part",
  "PartDesign",
  "Sketcher",
  "Draft",
  "Mesh",
  "Import",
  "Spreadsheet",
  "TechDraw",
  "Materials",
  "FreeCAD",
  "App",
]);

const DESCRIPTIONS: Record<CommandName, string> = {
  Ping: "Check that the server answers",
  GetVersion: "FreeCAD and protocol version",
  GetServerInfo: "Instance token, transport and paths",
  GetCommands: "List the commands this server implements",
  GetTypes: "Registered document object types derived from a base type",
  LoadModule: "Import a FreeCAD module",
  ListDocuments: "List open documents",
  NewDocument: "Create a document",
  OpenDocument: "Open a document from a path",
  OpenDocumentBytes: "Open a document from .FCStd bytes",
  SaveDocument: "Save a document to its file",
  SaveDocumentAs: "Save a document to a new path",
  SaveDocumentBytes: "Serialize a document to .FCStd bytes",
  CloseDocument: "Close a document",
  SetActiveDocument: "Make a document the active one",
  Recompute: "Recompute touched objects",
  Undo: "Undo the last transaction",
  Redo: "Redo the last undone transaction",
  GetUndoStack: "Undo and redo transaction names",
  OpenTransaction: "Open a named transaction",
  CommitTransaction: "Commit the open transaction",
  AbortTransaction: "Abort the open transaction",
  GetObjects: "Objects of a document, in document order",
  GetObject: "One object, optionally with its properties",
  GetProperties: "Properties of an object",
  SetProperties: "Set property values",
  SetExpression: "Bind or clear an expression",
  AddObject: "Create a document object",
  RemoveObject: "Delete a document object",
  AddProperty: "Add a dynamic property",
  RemoveProperty: "Remove a dynamic property",
  Tessellate: "Meshes of shapes for display",
  GetBoundingBox: "Bounding box of objects",
  Import: "Import a file into a document",
  Export: "Export objects to a file format",
  RunPython: "Run Python in FreeCAD's interpreter",
};

export class MockFreeCAD {
  readonly token: string;
  private readonly docs = new Map<string, MockDocument>();
  private active: string | null = null;
  private seq = 0;
  private revision = 0;
  private readonly listeners = new Set<(ev: EventMessage) => void>();
  private readonly meshCache = new Map<string, { mesh: Mesh; bbox: BBox | undefined; deflection: number }>();
  private readonly handlers: Record<CommandName, Handler>;
  readonly startedAt = Date.now();

  constructor(readonly options: MockFreeCADOptions = {}) {
    this.token = options.token ?? randomToken();
    this.handlers = this.buildHandlers();
    if (options.demo) this.seedDemo();
  }

  /** Every event, once its request's reply has gone out (see `publish`). */
  onEvent(cb: (ev: EventMessage) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  publish(events: EventMessage[]): void {
    for (const ev of events) for (const cb of Array.from(this.listeners)) cb(ev);
  }

  /**
   * Handle one decoded request. Returns the reply and the events it raised, sequence numbers
   * assigned; the caller sends the reply first and then passes the events to `publish()`.
   */
  handle(message: unknown): { response: Response; events: EventMessage[] } {
    const m = (typeof message === "object" && message !== null ? message : {}) as Partial<Request> & Record<string, unknown>;
    const id = typeof m.id === "number" || typeof m.id === "string" ? m.id : null;
    const reply = (r: { status: Status; error?: string; result?: unknown }): Response => ({ id, token: this.token, ...r }) as Response;
    if (typeof m.cmd !== "string") {
      return { response: reply({ status: "BAD_REQUEST", error: "missing 'cmd'" }), events: [] };
    }
    if (m.token && m.token !== this.token) {
      return { response: reply({ status: "TOKEN_MISMATCH", error: "token does not match this server instance" }), events: [] };
    }
    const handler = (this.handlers as Record<string, Handler | undefined>)[m.cmd];
    if (!handler) return { response: reply({ status: "UNKNOWN_COMMAND", error: `unknown command '${m.cmd}'` }), events: [] };
    const params = m.params ?? {};
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return { response: reply({ status: "BAD_REQUEST", error: "'params' must be an object" }), events: [] };
    }
    const ctx = new RequestContext(typeof m.client === "string" && m.client ? m.client : undefined);
    let response: Response;
    try {
      const result = handler(params as Record<string, unknown>, ctx);
      response = reply({ status: "OK", result: (result === undefined ? null : result) as never });
    } catch (e) {
      if (e instanceof ApiFailure) response = reply({ status: e.status, error: e.message });
      else response = reply({ status: "FAILED", error: e instanceof Error ? e.message : String(e) });
    }
    const events = ctx.events.map((e) => ({ event: e.event, seq: ++this.seq, data: e.data }) as unknown as EventMessage);
    return { response, events };
  }

  /** Test helper: the current event sequence number. */
  get lastSeq(): number {
    return this.seq;
  }

  // ------------------------------------------------------------------------------ handlers

  private buildHandlers(): Record<CommandName, Handler> {
    return {
      Ping: () => null,
      GetVersion: () => ({ major: 1, minor: 1, patch: 0, revision: "mock", full: "1.1.0 (fab-cad mock)", api: PROTOCOL_VERSION }),
      GetServerInfo: () => ({
        token: this.token,
        transport: this.options.transport ?? "inproc",
        url: this.options.url ?? "inproc://freecad",
        python: false,
        events: true,
        pid: typeof process !== "undefined" ? process.pid : 0,
        platform: "mock",
        homePath: "/mock/freecad",
        userDataPath: "/mock/user",
        gui: false,
      }),
      GetCommands: () => COMMAND_NAMES.map((name) => ({ name, description: DESCRIPTIONS[name] })),
      GetTypes: (p) => {
        const base = optString(p, "base") ?? "App::DocumentObject";
        if (!knownType(base)) throw notFound(`No type '${base}'`);
        return typesDerivedFrom(base);
      },
      LoadModule: (p) => {
        const name = str(p, "name");
        if (!MODULES.has(name)) throw failed(`No module named '${name}'`);
        return null;
      },

      ListDocuments: () => [...this.docs.values()].map((d) => this.docInfo(d)),
      NewDocument: (p, ctx) => {
        const d = this.newDocument(optString(p, "name") ?? "Unnamed", optString(p, "label"), ctx);
        return this.docInfo(d);
      },
      OpenDocument: (p, ctx) => {
        const path = str(p, "path");
        const fs = this.fs();
        let data: Uint8Array;
        try {
          data = fs.readFile(path);
        } catch (e) {
          throw failed(`cannot read '${path}': ${e instanceof Error ? e.message : String(e)}`);
        }
        const d = this.openBytes(data, basename(path), ctx);
        d.fileName = path;
        return this.docInfo(d);
      },
      OpenDocumentBytes: (p, ctx) => {
        const data = p.data;
        if (!(data instanceof Uint8Array)) throw bad("'data' must be bytes");
        return this.docInfo(this.openBytes(data, optString(p, "fileName") ?? "Unnamed.FCStd", ctx));
      },
      SaveDocument: (p, ctx) => {
        const d = this.doc(p);
        if (!d.fileName) throw failed(`Document '${d.name}' has no file name; use SaveDocumentAs`);
        this.writeDoc(d, d.fileName, ctx);
        return this.docInfo(d);
      },
      SaveDocumentAs: (p, ctx) => {
        const d = this.doc(p);
        const path = str(p, "path");
        this.writeDoc(d, path, ctx);
        d.fileName = path;
        return this.docInfo(d);
      },
      SaveDocumentBytes: (p) => {
        const d = this.doc(p);
        return { data: this.serializeDoc(d), fileName: d.fileName ? basename(d.fileName) : `${d.name}.FCStd` };
      },
      CloseDocument: (p, ctx) => {
        const d = this.doc(p);
        this.docs.delete(d.name);
        ctx.emit("DocumentDeleted", { doc: d.name });
        if (this.active === d.name) {
          this.active = this.docs.keys().next().value ?? null;
          if (this.active) ctx.emit("ActiveDocumentChanged", { doc: this.active });
        }
        return null;
      },
      SetActiveDocument: (p, ctx) => {
        const d = this.doc(p);
        if (this.active !== d.name) {
          this.active = d.name;
          ctx.emit("ActiveDocumentChanged", { doc: d.name });
        }
        return null;
      },
      Recompute: (p, ctx) => this.recompute(this.doc(p), optBool(p, "force") ?? false, ctx),
      Undo: (p, ctx) => this.undoRedo(this.doc(p), "undo", ctx),
      Redo: (p, ctx) => this.undoRedo(this.doc(p), "redo", ctx),
      GetUndoStack: (p) => this.undoStack(this.doc(p)),
      OpenTransaction: (p, ctx) => {
        const d = this.doc(p);
        const name = str(p, "name");
        if (d.open) this.commit(d, ctx);
        d.open = { name, before: d.snapshot(), changes: d.changes };
        ctx.emit("TransactionOpened", { doc: d.name, name });
        return null;
      },
      CommitTransaction: (p, ctx) => {
        const d = this.doc(p);
        if (d.open) this.commit(d, ctx);
        return null;
      },
      AbortTransaction: (p, ctx) => {
        const d = this.doc(p);
        if (!d.open) return null;
        const before = d.snapshot();
        d.restore(d.open.before);
        d.open = null;
        this.emitDiff(d, before, ctx);
        ctx.emit("TransactionAborted", { doc: d.name });
        return null;
      },

      GetObjects: (p) => {
        const d = this.doc(p);
        return [...d.objects.values()].map((o) => this.objectInfo(d, o));
      },
      GetObject: (p) => {
        const d = this.doc(p);
        const o = d.object(str(p, "object"));
        const info: ObjectInfo & { properties?: PropertyInfo[] } = this.objectInfo(d, o);
        if (optBool(p, "properties")) info.properties = [...o.props.values()].map(propertyInfo);
        return info;
      },
      GetProperties: (p) => {
        const d = this.doc(p);
        const o = d.object(str(p, "object"));
        const names = optStringArray(p, "names");
        if (!names) return [...o.props.values()].map(propertyInfo);
        return names.map((n) => {
          const prop = o.prop(n);
          if (!prop) throw notFound(`No property '${n}' in '${o.name}'`);
          return propertyInfo(prop);
        });
      },
      SetProperties: (p, ctx) => {
        const d = this.doc(p);
        const o = d.object(str(p, "object"));
        const values = p.values;
        if (typeof values !== "object" || values === null || Array.isArray(values)) throw bad("'values' must be an object");
        return this.modify(d, `Edit ${o.label}`, ctx, () => {
          const out: PropertyInfo[] = [];
          for (const [name, v] of Object.entries(values as Record<string, WireValue>)) {
            out.push(propertyInfo(this.setProperty(d, o, name, v, ctx)));
          }
          return out;
        });
      },
      SetExpression: (p, ctx) => {
        const d = this.doc(p);
        const o = d.object(str(p, "object"));
        const path = str(p, "path");
        const expression = p.expression;
        if (expression !== null && typeof expression !== "string") throw bad("'expression' must be a string or null");
        const prop = o.prop(path);
        if (!prop) throw notFound(`No property '${path}' in '${o.name}'`);
        return this.modify(d, `Set expression ${o.label}.${path}`, ctx, () => {
          if (expression === null || expression === "") delete prop.expression;
          else {
            try {
              compileExpression(expression);
            } catch (e) {
              throw failed(`Invalid expression '${expression}': ${e instanceof Error ? e.message : String(e)}`);
            }
            prop.expression = expression;
          }
          this.touch(d, o);
          ctx.emit("ObjectChanged", { doc: d.name, object: o.name, property: "ExpressionEngine" });
          return null;
        });
      },
      AddObject: (p, ctx) => {
        const d = this.doc(p);
        const typeName = str(p, "type");
        const type = TYPES[typeName];
        if (!type) throw failed(`No document object found of type '${typeName}'`);
        if (!type.creatable) throw failed(`Cannot create an object of abstract type '${typeName}'`);
        const groupName = optString(p, "group");
        const group = groupName !== undefined ? d.object(groupName) : undefined;
        if (group && !group.prop("Group")) throw failed(`'${groupName}' is not a group`);
        const properties = p.properties;
        if (properties !== undefined && (typeof properties !== "object" || properties === null || Array.isArray(properties))) {
          throw bad("'properties' must be an object");
        }
        return this.modify(d, `Create ${optString(p, "label") ?? type.baseName}`, ctx, () => {
          const o = this.addObject(d, type, optString(p, "name"), optString(p, "label"), ctx);
          for (const [name, v] of Object.entries((properties ?? {}) as Record<string, WireValue>)) this.setProperty(d, o, name, v, ctx);
          if (group) {
            const list = group.prop("Group")!;
            list.value = [...(list.value as WireObjectRef[]), { $type: "Object", doc: d.name, name: o.name }];
            this.changed(d, group, "Group", ctx);
          }
          return this.objectInfo(d, o);
        });
      },
      RemoveObject: (p, ctx) => {
        const d = this.doc(p);
        const o = d.object(str(p, "object"));
        return this.modify(d, `Delete ${o.label}`, ctx, () => {
          this.removeObject(d, o, optBool(p, "recursive") ?? false, ctx);
          return null;
        });
      },
      AddProperty: (p, ctx) => {
        const d = this.doc(p);
        const o = d.object(str(p, "object"));
        const type = str(p, "type");
        const name = str(p, "name");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw bad(`invalid property name '${name}'`);
        if (o.prop(name)) throw failed(`Object '${o.name}' already has a property '${name}'`);
        const def = dynamicPropertyDefault(type);
        if (!def) throw failed(`Unknown property type '${type}'`);
        return this.modify(d, `Add property ${name}`, ctx, () => {
          const prop: Prop = {
            name,
            type,
            group: optString(p, "group") ?? "Base",
            doc: optString(p, "documentation") ?? "",
            status: ["Dynamic"],
            value: def.value,
            ...(def.unit !== undefined ? { unit: def.unit } : {}),
            ...(def.enum !== undefined ? { enum: def.enum } : {}),
          };
          o.props.set(name, prop);
          this.changed(d, o, name, ctx);
          return propertyInfo(prop);
        });
      },
      RemoveProperty: (p, ctx) => {
        const d = this.doc(p);
        const o = d.object(str(p, "object"));
        const name = str(p, "name");
        const prop = o.prop(name);
        if (!prop) throw notFound(`No property '${name}' in '${o.name}'`);
        if (!prop.status.includes("Dynamic")) throw failed(`Property '${name}' is not dynamic and cannot be removed`);
        return this.modify(d, `Remove property ${name}`, ctx, () => {
          o.props.delete(name);
          this.changed(d, o, name, ctx);
          return null;
        });
      },

      Tessellate: (p) => {
        const d = this.doc(p);
        const names = optStringArray(p, "objects");
        const objs = names ? names.map((n) => d.object(n)) : [...d.objects.values()];
        const deflection = optNumber(p, "deflection");
        const edges = optBool(p, "edges") ?? true;
        const out: WireTessellation[] = [];
        for (const o of objs) {
          if (!o.shape) continue;
          const { mesh, deflection: used } = this.mesh(o.shape, deflection);
          out.push({
            object: o.name,
            placement: placementOut(o.shape.placement),
            revision: o.shape.revision,
            deflection: used,
            positions: float32Bytes(mesh.positions),
            indices: uint32Bytes(mesh.indices),
            // uint32 pairs as bytes, like the real server
            faces: uint32Bytes(mesh.faces.flat()),
            edges: edges ? uint32Bytes(mesh.edges.flat()) : new Uint8Array(0),
            edgePositions: edges ? float32Bytes(mesh.edgePositions) : new Uint8Array(0),
            vertices: edges ? float32Bytes(mesh.vertices) : new Uint8Array(0),
          });
        }
        return out;
      },
      GetBoundingBox: (p) => {
        const d = this.doc(p);
        const names = optStringArray(p, "objects");
        const objs = names ? names.map((n) => d.object(n)) : [...d.objects.values()];
        return unionBounds(objs.map((o) => (o.shape ? this.mesh(o.shape).bbox : undefined))) ?? null;
      },

      Import: () => {
        throw failed("the mock server cannot import files");
      },
      Export: (p) => {
        const d = this.doc(p);
        const names = optStringArray(p, "objects");
        if (!names) throw bad("missing parameter 'objects'");
        const format = str(p, "format");
        const objs = names.map((n) => d.object(n));
        if (format === "stl") return { data: utf8(this.toStl(objs)), fileName: `${d.name}.stl` };
        if (format === "obj") return { data: utf8(this.toObj(objs)), fileName: `${d.name}.obj` };
        if (["step", "iges", "brep"].includes(format))
          throw failed(`the mock server cannot write '${format}' (no OpenCASCADE); use stl or obj`);
        throw bad(`unknown export format '${format}'`);
      },
      RunPython: () => {
        throw new ApiFailure("FORBIDDEN", "the mock server has no Python interpreter");
      },
    };
  }

  // ------------------------------------------------------------------------------ documents

  private fs(): MockFileSystem {
    if (!this.options.fs) throw failed("the mock server was started without file system access");
    return this.options.fs;
  }

  private doc(p: Record<string, unknown>): MockDocument {
    const name = str(p, "doc");
    const d = this.docs.get(name);
    if (!d) throw notFound(`No document '${name}'`);
    return d;
  }

  private docInfo(d: MockDocument): DocumentInfo {
    return {
      name: d.name,
      label: d.label,
      fileName: d.fileName,
      modified: d.modified,
      active: this.active === d.name,
      transient: false,
      objectCount: d.objects.size,
      undoCount: d.undo.length,
      redoCount: d.redo.length,
    };
  }

  private newDocument(requested: string, label: string | undefined, ctx: RequestContext | null): MockDocument {
    const name = uniqueDocName(sanitizeName(requested), (n) => this.docs.has(n));
    const d = new MockDocument(name, label ?? name);
    this.docs.set(name, d);
    this.active = name;
    ctx?.emit("DocumentCreated", { doc: name, label: d.label });
    ctx?.emit("ActiveDocumentChanged", { doc: name });
    return d;
  }

  private serializeDoc(d: MockDocument): Uint8Array {
    return utf8(encodeJson({ fabCadMockDocument: 1, name: d.name, label: d.label, objects: d.snapshot().objects }));
  }

  private openBytes(data: Uint8Array, fileName: string, ctx: RequestContext): MockDocument {
    if (data[0] === 0x50 && data[1] === 0x4b) throw failed("the mock server cannot read real .FCStd (zip) files, only its own saves");
    let parsed: { fabCadMockDocument?: number; name?: string; label?: string; objects?: SerializedObject[] };
    try {
      parsed = decodeJson(data);
    } catch {
      throw failed(`'${fileName}' is not a document`);
    }
    if (parsed.fabCadMockDocument !== 1 || !Array.isArray(parsed.objects)) throw failed(`'${fileName}' is not a document`);
    for (const o of parsed.objects) if (!TYPES[o.type]) throw failed(`'${fileName}' has an object of unknown type '${o.type}'`);
    const d = this.newDocument(parsed.name ?? fileName.replace(/\.[^.]*$/, ""), parsed.label, null);
    d.restore({ objects: parsed.objects });
    ctx.emit("DocumentCreated", { doc: d.name, label: d.label });
    ctx.emit("DocumentRestored", { doc: d.name });
    ctx.emit("ActiveDocumentChanged", { doc: d.name });
    return d;
  }

  private writeDoc(d: MockDocument, path: string, ctx: RequestContext): void {
    try {
      this.fs().writeFile(path, this.serializeDoc(d));
    } catch (e) {
      if (e instanceof ApiFailure) throw e;
      throw failed(`cannot write '${path}': ${e instanceof Error ? e.message : String(e)}`);
    }
    d.modified = false;
    ctx.emit("DocumentSaved", { doc: d.name, fileName: path });
  }

  // ------------------------------------------------------------------------------ transactions

  /**
   * Run a modifying command atomically: on failure the document is put back as it was. Outside
   * an explicit transaction the command gets its own, named like the GUI would name it.
   */
  private modify<T>(d: MockDocument, name: string, ctx: RequestContext, body: () => T): T {
    const before = d.snapshot();
    const changes = d.changes;
    const eventCount = ctx.events.length;
    let result: T;
    try {
      result = body();
    } catch (e) {
      d.restore(before);
      d.changes = changes;
      ctx.events.length = eventCount;
      throw e;
    }
    if (!d.open && d.changes !== changes) {
      d.undo.push({ name, before });
      d.redo = [];
      ctx.events.splice(eventCount, 0, { event: "TransactionOpened", data: withClient({ doc: d.name, name }, ctx) });
      ctx.emit("TransactionCommitted", { doc: d.name });
    }
    return result;
  }

  private commit(d: MockDocument, ctx: RequestContext): void {
    const open = d.open!;
    d.open = null;
    if (d.changes !== open.changes) {
      d.undo.push({ name: open.name, before: open.before });
      d.redo = [];
    }
    ctx.emit("TransactionCommitted", { doc: d.name });
  }

  private undoRedo(d: MockDocument, which: "undo" | "redo", ctx: RequestContext): UndoStack {
    if (d.open) this.commit(d, ctx);
    const from = which === "undo" ? d.undo : d.redo;
    const to = which === "undo" ? d.redo : d.undo;
    const tx = from.pop();
    if (!tx) throw failed(`Nothing to ${which}`);
    const current = d.snapshot();
    d.restore(tx.before);
    to.push({ name: tx.name, before: current });
    d.changes++;
    d.modified = true;
    this.emitDiff(d, current, ctx);
    ctx.emit(which === "undo" ? "Undo" : "Redo", { doc: d.name });
    return this.undoStack(d);
  }

  private undoStack(d: MockDocument): UndoStack {
    return { undo: d.undo.map((t) => t.name).reverse(), redo: d.redo.map((t) => t.name).reverse() };
  }

  /** Events describing the change from `before` to the document's current state. */
  private emitDiff(d: MockDocument, before: Snapshot, ctx: RequestContext): void {
    const old = new Map(before.objects.map((o) => [o.name, o]));
    for (const o of old.values()) if (!d.objects.has(o.name)) ctx.emit("ObjectDeleted", { doc: d.name, object: o.name });
    for (const o of d.objects.values()) {
      const prev = old.get(o.name);
      if (!prev) {
        ctx.emit("ObjectCreated", { doc: d.name, object: o.name, type: o.type.name });
        continue;
      }
      const prevProps = new Map(prev.props.map((p) => [p.name, p]));
      for (const p of o.props.values()) {
        const q0 = prevProps.get(p.name);
        if (!q0 || encodeJson(q0) !== encodeJson(p)) ctx.emit("ObjectChanged", { doc: d.name, object: o.name, property: p.name });
      }
      for (const name of prevProps.keys())
        if (!o.props.has(name)) ctx.emit("ObjectChanged", { doc: d.name, object: o.name, property: name });
    }
  }

  // ------------------------------------------------------------------------------ objects

  private addObject(d: MockDocument, type: TypeDef, name: string | undefined, label: string | undefined, ctx: RequestContext): MockObject {
    const internal = uniqueObjectName(sanitizeName(name ?? type.baseName), (n) => d.objects.has(n));
    const o = new MockObject(internal, type, new Map(type.props().map((p) => [p.name, p])));
    o.prop("Label")!.value = uniqueLabel(d, label ?? internal);
    d.objects.set(internal, o);
    d.changes++;
    d.modified = true;
    ctx.emit("ObjectCreated", { doc: d.name, object: internal, type: type.name });
    return o;
  }

  private removeObject(d: MockDocument, o: MockObject, recursive: boolean, ctx: RequestContext): void {
    if (!d.objects.has(o.name)) return;
    const members = recursive ? this.children(d, o) : [];
    d.objects.delete(o.name);
    d.changes++;
    d.modified = true;
    // Drop links to it (group membership, link properties).
    for (const other of d.objects.values()) {
      for (const p of other.props.values()) {
        if (Array.isArray(p.value) && p.type === "App::PropertyLinkList") {
          const kept = (p.value as WireObjectRef[]).filter((r) => r.name !== o.name);
          if (kept.length !== p.value.length) {
            p.value = kept;
            this.changed(d, other, p.name, ctx);
          }
        } else if (isTaggedAs(p.value, "Object") && p.value.name === o.name) {
          p.value = null;
          this.changed(d, other, p.name, ctx);
        }
      }
    }
    ctx.emit("ObjectDeleted", { doc: d.name, object: o.name });
    for (const m of members) {
      const child = d.objects.get(m);
      if (child) this.removeObject(d, child, true, ctx);
    }
  }

  private children(d: MockDocument, o: MockObject): string[] {
    const g = o.prop("Group");
    if (!g || !Array.isArray(g.value)) return [];
    return (g.value as WireObjectRef[]).filter((r) => d.objects.has(r.name)).map((r) => r.name);
  }

  private objectInfo(d: MockDocument, o: MockObject): ObjectInfo {
    const outList = new Set<string>();
    for (const p of o.props.values()) {
      for (const r of refsIn(p.value)) if (r.name !== o.name) outList.add(r.name);
      if (p.expression)
        for (const ref of safeRefs(p.expression)) if (ref.object) outList.add(d.byLabelOrName(ref.object)?.name ?? ref.object);
    }
    const inList: string[] = [];
    const parents: string[] = [];
    for (const other of d.objects.values()) {
      if (other === o) continue;
      if (this.children(d, other).includes(o.name)) parents.push(other.name);
      let links = false;
      for (const p of other.props.values()) {
        if (refsIn(p.value).some((r) => r.name === o.name)) links = true;
        if (p.expression && safeRefs(p.expression).some((r) => r.object && (d.byLabelOrName(r.object) ?? null) === o)) links = true;
      }
      if (links) inList.push(other.name);
    }
    // FreeCAD's getStatusString()
    const status = o.error ? o.error : o.touched ? "Touched" : "Valid";
    const info: ObjectInfo = {
      name: o.name,
      label: o.label,
      type: o.type.name,
      typeHierarchy: [...o.type.hierarchy],
      isGeo: o.type.isGeo,
      isValid: !o.error,
      isTouched: o.touched,
      isError: !!o.error,
      status,
      inList,
      outList: [...outList].filter((n) => d.objects.has(n)),
      children: this.children(d, o),
      parents,
      visibility: o.visibility,
    };
    if (o.shape) {
      const bbox = this.mesh(o.shape).bbox;
      if (bbox) info.bbox = bbox;
    }
    return info;
  }

  private touch(d: MockDocument, o: MockObject): void {
    o.touched = true;
    d.changes++;
    d.modified = true;
  }

  private changed(d: MockDocument, o: MockObject, property: string, ctx: RequestContext): void {
    d.changes++;
    d.modified = true;
    ctx.emit("ObjectChanged", { doc: d.name, object: o.name, property });
  }

  private setProperty(d: MockDocument, o: MockObject, name: string, input: WireValue, ctx: RequestContext): Prop {
    const prop = o.prop(name);
    if (!prop) throw notFound(`No property '${name}' in '${o.name}'`);
    if (prop.type === "Part::PropertyPartShape") throw failed(`Property '${name}' is an output shape and cannot be set`);
    let value = coerce(prop, input, d);
    if (name === "Label" && typeof value === "string" && value !== prop.value) value = uniqueLabel(d, value, o);
    if (encodeJson({ v: value }) === encodeJson({ v: prop.value })) return prop;
    prop.value = value;
    this.changed(d, o, name, ctx);
    if (prop.status.includes("NoRecompute") || name === "Label" || name === "Label2") return prop;
    if (name === "Placement") {
      // A placement moves the shape at once, without a recompute (Part::Feature::onChanged).
      if (o.shape) {
        o.shape = { ...o.shape, placement: value as WirePlacement, revision: ++this.revision };
        o.prop("Shape")!.value = shapeRepr(o.shape);
        this.changed(d, o, "Shape", ctx);
      }
      return prop;
    }
    o.touched = true;
    return prop;
  }

  // ------------------------------------------------------------------------------ recompute

  private recompute(
    d: MockDocument,
    force: boolean,
    ctx: RequestContext,
  ): { recomputed: number; errors: { object: string; message: string }[] } {
    // Objects that need it: touched ones, plus anything whose expressions read from them.
    const pending = new Set<string>();
    for (const o of d.objects.values()) if (force || o.touched || hasExpressions(o)) pending.add(o.name);
    const order = this.dependencyOrder(d, pending);
    const errors: { object: string; message: string }[] = [];
    let count = 0;
    for (const o of order) {
      const wasTouched = o.touched;
      let exprChanged = false;
      let exprError: string | null = null;
      try {
        exprChanged = this.evaluateExpressions(d, o, ctx);
      } catch (e) {
        exprError = e instanceof Error ? e.message : String(e);
      }
      if (!force && !wasTouched && !exprChanged && !exprError && !o.error) continue;
      count++;
      o.error = exprError ?? this.buildShape(d, o, ctx);
      o.touched = false;
      d.changes++;
      if (o.error) errors.push({ object: o.name, message: o.error });
      ctx.emit("ObjectRecomputed", { doc: d.name, object: o.name });
    }
    ctx.emit("Recomputed", { doc: d.name });
    return { recomputed: count, errors };
  }

  private dependencyOrder(d: MockDocument, names: Set<string>): MockObject[] {
    const out: MockObject[] = [];
    const state = new Map<string, "visiting" | "done">();
    const visit = (o: MockObject) => {
      const s = state.get(o.name);
      if (s === "done" || s === "visiting") return; // cycles are broken, not reported
      state.set(o.name, "visiting");
      for (const p of o.props.values()) {
        if (!p.expression) continue;
        for (const r of safeRefs(p.expression)) {
          const dep = r.object ? d.byLabelOrName(r.object) : undefined;
          if (dep && dep !== o) visit(dep);
        }
      }
      state.set(o.name, "done");
      if (names.has(o.name)) out.push(o);
    };
    for (const o of d.objects.values()) visit(o);
    return out;
  }

  /** Apply bound expressions; true when a value changed. */
  private evaluateExpressions(d: MockDocument, o: MockObject, ctx: RequestContext): boolean {
    let changed = false;
    for (const p of o.props.values()) {
      if (!p.expression) continue;
      const { evaluate } = compileExpression(p.expression);
      const v = evaluate((ref: ExprRef) => {
        const target = ref.object ? d.byLabelOrName(ref.object) : o;
        if (!target) throw new Error(`Expression '${p.expression}': no object '${ref.object}'`);
        const tp = target.prop(ref.property);
        if (!tp) throw new Error(`Expression '${p.expression}': no property '${ref.property}' in '${target.name}'`);
        if (typeof tp.value === "number") return tp.value;
        if (isTaggedAs(tp.value, "Quantity")) return tp.value.value;
        throw new Error(`Expression '${p.expression}': '${target.name}.${ref.property}' is not a number`);
      });
      if (!Number.isFinite(v)) throw new Error(`Expression '${p.expression}' is not finite`);
      const next = isTaggedAs(p.value, "Quantity") ? q(v, p.value.unit) : p.type === "App::PropertyInteger" ? Math.trunc(v) : v;
      if (encodeJson({ v: next }) !== encodeJson({ v: p.value })) {
        p.value = next;
        changed = true;
        ctx.emit("ObjectChanged", { doc: d.name, object: o.name, property: p.name });
      }
    }
    return changed;
  }

  /** Rebuild the shape from the parameters; returns an error message or null. */
  private buildShape(d: MockDocument, o: MockObject, ctx: RequestContext): string | null {
    const kind = o.type.shape;
    if (!kind) return null;
    let dims: number[];
    if (kind === "box") {
      dims = [o.num("Length"), o.num("Width"), o.num("Height")];
      if (dims.some((x) => x < 1e-7))
        return dims[0]! < 1e-7 ? "Length of box too small" : dims[1]! < 1e-7 ? "Width of box too small" : "Height of box too small";
    } else if (kind === "cylinder") {
      dims = [o.num("Radius"), o.num("Height")];
      if (dims[0]! < 1e-7) return "Radius of cylinder too small";
      if (dims[1]! < 1e-7) return "Height of cylinder too small";
    } else {
      dims = [o.num("Radius")];
      if (dims[0]! < 1e-7) return "Radius of sphere too small";
    }
    const placement = o.prop("Placement")!.value as WirePlacement;
    const same =
      o.shape &&
      o.shape.kind === kind &&
      encodeJson(o.shape.dims) === encodeJson(dims) &&
      encodeJson(o.shape.placement) === encodeJson(placement);
    if (!same) {
      o.shape = { kind, dims, placement, revision: ++this.revision };
      o.prop("Shape")!.value = shapeRepr(o.shape);
      this.changed(d, o, "Shape", ctx);
    }
    return null;
  }

  private mesh(shape: Shape, deflection?: number): { mesh: Mesh; bbox: BBox | undefined; deflection: number } {
    const angular = 28.5; // FreeCAD's default angular deflection, degrees
    const key = `${shape.revision}:${deflection ?? "auto"}`;
    const hit = this.meshCache.get(key);
    if (hit) return hit;
    const [a = 0, b = 0, c = 0] = shape.dims;
    const localDiag =
      shape.kind === "box" ? Math.hypot(a, b, c) : shape.kind === "cylinder" ? Math.hypot(2 * a, 2 * a, b) : 2 * a * Math.sqrt(3);
    const defl = deflection && deflection > 0 ? deflection : Math.max(localDiag * 0.001, 1e-4);
    let local: Mesh;
    if (shape.kind === "box") local = boxMesh(a, b, c);
    else if (shape.kind === "cylinder") local = cylinderMesh(a, b, circleSegments(a, defl, angular));
    else local = sphereMesh(a, circleSegments(a, defl, angular));
    const p = new Placement(Vector.fromArray(shape.placement.base), Rotation.fromQuaternion(shape.placement.rotation));
    const mesh = transformMesh(local, p);
    const entry = { mesh, bbox: boundsOf(mesh.positions), deflection: defl };
    if (this.meshCache.size > 256) this.meshCache.delete(this.meshCache.keys().next().value!);
    this.meshCache.set(key, entry);
    return entry;
  }

  private toStl(objs: MockObject[]): string {
    const lines = ["solid fabcad"];
    for (const o of objs) {
      if (!o.shape) continue;
      const { mesh } = this.mesh(o.shape);
      const P = (i: number) => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [P(mesh.indices[t]!), P(mesh.indices[t + 1]!), P(mesh.indices[t + 2]!)];
        const n = new Vector(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!)
          .cross(new Vector(c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!))
          .normalize();
        lines.push(`  facet normal ${n.x} ${n.y} ${n.z}`, "    outer loop");
        for (const v of [a, b, c]) lines.push(`      vertex ${v.join(" ")}`);
        lines.push("    endloop", "  endfacet");
      }
    }
    lines.push("endsolid fabcad");
    return lines.join("\n") + "\n";
  }

  private toObj(objs: MockObject[]): string {
    const lines = ["# fab-cad mock export"];
    let base = 1;
    for (const o of objs) {
      if (!o.shape) continue;
      const { mesh } = this.mesh(o.shape);
      lines.push(`o ${o.name}`);
      for (let i = 0; i < mesh.positions.length; i += 3)
        lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
      for (let t = 0; t < mesh.indices.length; t += 3)
        lines.push(`f ${mesh.indices[t]! + base} ${mesh.indices[t + 1]! + base} ${mesh.indices[t + 2]! + base}`);
      base += mesh.positions.length / 3;
    }
    return lines.join("\n") + "\n";
  }

  // ------------------------------------------------------------------------------ demo

  private seedDemo(): void {
    const ctx = new RequestContext(undefined);
    const d = this.newDocument("Demo", "Demo", null);
    const group = this.addObject(d, TYPES["App::DocumentObjectGroup"]!, "Parts", "Parts", ctx);
    const box = this.addObject(d, TYPES["Part::Box"]!, undefined, undefined, ctx);
    const cyl = this.addObject(d, TYPES["Part::Cylinder"]!, undefined, undefined, ctx);
    this.setProperty(d, cyl, "Radius", 5, ctx);
    this.setProperty(d, cyl, "Placement", { $type: "Placement", base: [25, 5, 0], rotation: [0, 0, 0, 1] }, ctx);
    const sphere = this.addObject(d, TYPES["Part::Sphere"]!, undefined, undefined, ctx);
    this.setProperty(d, sphere, "Placement", { $type: "Placement", base: [45, 5, 5], rotation: [0, 0, 0, 1] }, ctx);
    group.prop("Group")!.value = [box, cyl, sphere].map((o) => ({ $type: "Object", doc: d.name, name: o.name }));
    this.recompute(d, true, ctx);
    d.modified = false;
    d.undo = [];
  }
}

// ------------------------------------------------------------------------------------ helpers

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function withClient(data: Record<string, unknown>, ctx: RequestContext): Record<string, unknown> {
  return ctx.client ? { ...data, client: ctx.client } : data;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (v === undefined || v === null) throw bad(`missing parameter '${key}'`);
  if (typeof v !== "string") throw bad(`parameter '${key}' must be a string`);
  return v;
}

function optString(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`parameter '${key}' must be a string`);
  return v;
}

function optBool(p: Record<string, unknown>, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw bad(`parameter '${key}' must be a boolean`);
  return v;
}

function optNumber(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`parameter '${key}' must be a number`);
  return v;
}

function optStringArray(p: Record<string, unknown>, key: string): string[] | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(`parameter '${key}' must be an array of strings`);
  return v as string[];
}

function sanitizeName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]/g, "_");
  if (!n) n = "Unnamed";
  if (/^[0-9]/.test(n)) n = `_${n}`;
  return n;
}

/** FreeCAD's document naming: `Unnamed`, `Unnamed1`, `Unnamed2`, ... */
function uniqueDocName(base: string, taken: (n: string) => boolean): string {
  if (!taken(base)) return base;
  const stem = base.replace(/\d+$/, "");
  for (let i = 1; ; i++) if (!taken(`${stem}${i}`)) return `${stem}${i}`;
}

/** FreeCAD's object naming: `Box`, `Box001`, `Box002`, ... */
function uniqueObjectName(base: string, taken: (n: string) => boolean): string {
  if (!taken(base)) return base;
  const stem = base.replace(/\d+$/, "");
  for (let i = 1; ; i++) {
    const n = `${stem}${String(i).padStart(3, "0")}`;
    if (!taken(n)) return n;
  }
}

function uniqueLabel(d: MockDocument, label: string, self?: MockObject): string {
  const taken = (l: string) => [...d.objects.values()].some((o) => o !== self && o.label === l);
  if (!taken(label)) return label;
  const stem = label.replace(/\d+$/, "");
  for (let i = 1; ; i++) {
    const l = `${stem}${String(i).padStart(3, "0")}`;
    if (!taken(l)) return l;
  }
}

function propertyInfo(p: Prop): PropertyInfo {
  const out: PropertyInfo = {
    name: p.name,
    type: p.type,
    group: p.group,
    doc: p.doc,
    status: [...p.status],
    value: structuredClone(p.value),
  };
  if (p.expression !== undefined) out.expression = p.expression;
  if (p.enum !== undefined) out.enum = [...p.enum];
  if (p.unit !== undefined) out.unit = p.unit;
  return out;
}

/** A placement as the server writes it: quaternion plus axis and angle. */
function placementOut(p: WirePlacement): WirePlacement {
  const r = Rotation.fromQuaternion(p.rotation);
  return { $type: "Placement", base: [...p.base], rotation: r.q, axis: r.axis, angle: r.angle };
}

function shapeRepr(s: Shape): WireValue {
  return { $type: "Repr", type: "Part.Shape", repr: `<Solid object (${s.kind}, revision ${s.revision})>` };
}

function hasExpressions(o: MockObject): boolean {
  for (const p of o.props.values()) if (p.expression) return true;
  return false;
}

function safeRefs(expression: string): ExprRef[] {
  try {
    return compileExpression(expression).refs;
  } catch {
    return [];
  }
}

function refsIn(v: WireValue): WireObjectRef[] {
  if (isTaggedAs(v, "Object")) return [v];
  if (Array.isArray(v)) return v.flatMap((x) => refsIn(x));
  return [];
}

const QUANTITY_TYPES: Record<string, "length" | "angle" | "any"> = {
  "App::PropertyLength": "length",
  "App::PropertyDistance": "length",
  "App::PropertyAngle": "angle",
  "App::PropertyQuantity": "any",
};

/** FreeCAD's conversions from a Python value to a property value, for the types the mock knows. */
function coerce(prop: Prop, v: WireValue, d: MockDocument): WireValue {
  const fail = (what: string) => failed(`Property '${prop.name}' (${prop.type}): expected ${what}, got ${describe(v)}`);
  const qt = QUANTITY_TYPES[prop.type];
  if (qt) {
    let value: number;
    let unit = prop.unit ?? "";
    if (typeof v === "number") value = v;
    else if (typeof v === "string" || isTaggedAs(v, "Quantity")) {
      const text = typeof v === "string" ? v : v.value === undefined && typeof v.text === "string" ? v.text : `${v.value} ${v.unit ?? ""}`;
      let parsed;
      try {
        parsed = parseQuantity(text);
      } catch {
        throw fail("a quantity");
      }
      if (qt !== "any" && parsed.dimension !== "none" && parsed.dimension !== qt) throw fail(`a ${qt}`);
      value = parsed.value;
      if (qt === "any") unit = parsed.unit || (isTaggedAs(v, "Quantity") ? v.unit : unit);
      else if (parsed.dimension === "none" && isTaggedAs(v, "Quantity") && v.unit && unitDimension(v.unit) === "none")
        unit = prop.unit ?? "";
    } else throw fail("a number, a string or a Quantity");
    if (prop.type === "App::PropertyLength" && value < 0) throw failed(`Property '${prop.name}': negative length not allowed`);
    return q(value, unit) satisfies WireQuantity;
  }
  switch (prop.type) {
    case "App::PropertyString":
    case "App::PropertyFont":
    case "App::PropertyFile":
    case "App::PropertyPath":
      if (typeof v === "string") return v;
      if (typeof v === "number") return String(v);
      throw fail("a string");
    case "App::PropertyBool":
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      throw fail("a bool");
    case "App::PropertyInteger":
      if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
      throw fail("an integer");
    case "App::PropertyFloat":
      if (typeof v === "number" && Number.isFinite(v)) return v;
      throw fail("a float");
    case "App::PropertyPercent":
      if (typeof v === "number" && v >= 0 && v <= 100) return Math.trunc(v);
      throw fail("an integer in [0, 100]");
    case "App::PropertyVector":
    case "App::PropertyVectorDistance":
      if (isTaggedAs(v, "Vector")) return { $type: "Vector", x: v.x, y: v.y, z: v.z };
      if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number"))
        return { $type: "Vector", x: v[0] as number, y: v[1] as number, z: v[2] as number };
      throw fail("a Vector");
    case "App::PropertyPlacement": {
      if (!isTaggedAs(v, "Placement")) throw fail("a Placement");
      const raw = v as unknown as { base?: unknown; rotation?: unknown; axis?: unknown; angle?: unknown };
      const base =
        raw.base === undefined
          ? [0, 0, 0]
          : Array.isArray(raw.base)
            ? raw.base
            : isTaggedAs(raw.base, "Vector")
              ? [raw.base.x, raw.base.y, raw.base.z]
              : undefined;
      if (!base || base.length !== 3 || base.some((x) => typeof x !== "number")) throw fail("a Placement with a base [x, y, z]");
      let rot: Rotation;
      const r = raw.rotation;
      if (Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number")) rot = Rotation.fromQuaternion(r as number[]);
      else if (typeof r === "object" && r !== null && ("q" in r || "axis" in r)) rot = Rotation.fromWire(r as never);
      else if (r === undefined && Array.isArray(raw.axis))
        rot = Rotation.fromAxisAngle(raw.axis as number[], typeof raw.angle === "number" ? raw.angle : 0);
      else if (r === undefined) rot = Rotation.identity();
      else throw fail("a Placement with a rotation [x, y, z, w], {q} or {axis, angle}");
      return placementOut({ $type: "Placement", base: base as [number, number, number], rotation: rot.q });
    }
    case "App::PropertyLink":
      if (v === null) return null;
      if (isTaggedAs(v, "Object")) {
        if (!d.objects.has(v.name)) throw notFound(`No object '${v.name}' in document '${d.name}'`);
        return { $type: "Object", doc: d.name, name: v.name };
      }
      throw fail("an object or null");
    case "App::PropertyLinkList": {
      if (!Array.isArray(v)) throw fail("a list of objects");
      return v.map((x) => {
        if (!isTaggedAs(x, "Object")) throw fail("a list of objects");
        if (!d.objects.has(x.name)) throw notFound(`No object '${x.name}' in document '${d.name}'`);
        return { $type: "Object", doc: d.name, name: x.name } satisfies WireObjectRef;
      });
    }
    case "App::PropertyStringList":
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
      throw fail("a list of strings");
    case "App::PropertyIntegerList":
    case "App::PropertyFloatList":
      if (Array.isArray(v) && v.every((x) => typeof x === "number"))
        return prop.type === "App::PropertyIntegerList" ? v.map((x) => Math.trunc(x as number)) : v;
      throw fail("a list of numbers");
    case "App::PropertyEnumeration": {
      const choices = prop.enum ?? [];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        // Assigning a list sets the choices, as in Python.
        prop.enum = v as string[];
        return (v[0] as string | undefined) ?? "";
      }
      if (typeof v === "string" && choices.includes(v)) return v;
      if (typeof v === "number" && choices[v] !== undefined) return choices[v]!;
      throw fail(`one of ${JSON.stringify(choices)}`);
    }
    case "App::PropertyMap":
      if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)) return v;
      throw fail("a dict");
    default:
      return v;
  }
}

function describe(v: WireValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (v instanceof Uint8Array) return "bytes";
  if (typeof v === "object") return typeof (v as { $type?: unknown }).$type === "string" ? `a ${(v as { $type: string }).$type}` : "a dict";
  return `${typeof v} ${JSON.stringify(v)}`;
}

export type { BoundBox };

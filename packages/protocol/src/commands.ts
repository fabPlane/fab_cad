/**
 * Every command and event of FreeCAD API protocol version 1, typed.
 *
 * Source of truth: `src/Api/PROTOCOL.md` in the FreeCAD fork (the commit is pinned in
 * `FREECAD_COMMIT`). Where the spec leaves a shape open, the choice made here is marked
 * **Assumed** and listed in this package's README so the server can be matched to it.
 */
import type { PropertyInput, WireObjectRef, WirePlacement, WireValue } from "./values";

/** Version of PROTOCOL.md this package implements (`GetVersion().api`). */
export const PROTOCOL_VERSION = 1;

export type Vec3 = [number, number, number];

// ------------------------------------------------------------------------------ result shapes

export interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
  revision: string;
  full: string;
  /** Protocol version. */
  api: number;
}

export interface ServerInfo {
  token: string;
  /** `websocket`, `stdio` or `wasm`. */
  transport: string;
  /** Listen URL for the WebSocket transport, else `""`. */
  url: string;
  /** Whether `RunPython` is enabled. */
  python: boolean;
  /** Whether events are published. */
  events: boolean;
  pid: number;
  platform: string;
  homePath: string;
  userDataPath: string;
}

export interface CommandDescription {
  name: string;
  description: string;
}

export interface DocumentInfo {
  /** Internal name. */
  name: string;
  label: string;
  fileName: string;
  modified: boolean;
  active: boolean;
  transient: boolean;
  objectCount: number;
  undoCount: number;
  redoCount: number;
}

export interface UndoStack {
  /** Transaction names, most recent first. */
  undo: string[];
  redo: string[];
}

export interface RecomputeResult {
  /** **Assumed**: the number of objects recomputed. */
  recomputed: number;
  errors: { object: string; message: string }[];
}

export interface BoundBox {
  min: Vec3;
  max: Vec3;
}

export interface ObjectInfo {
  /** Internal name. */
  name: string;
  label: string;
  type: string;
  /** **Assumed**: most derived first, ending at `App::DocumentObject`. */
  typeHierarchy: string[];
  isGeo: boolean;
  isValid: boolean;
  isTouched: boolean;
  isError: boolean;
  /** **Assumed**: status flag names (`Touched`, `Error`, `Recompute`, ...). */
  status: string[];
  /** **Assumed**: internal names of the objects linking to this one. */
  inList: string[];
  /** **Assumed**: internal names of the objects this one links to. */
  outList: string[];
  /** Claimed children (internal names), what the tree view nests under the object. */
  children: string[];
  /** **Assumed**: internal names of the objects claiming this one as a child. */
  parents: string[];
  visibility: boolean;
  bbox?: BoundBox;
}

export type PropertyStatus = "ReadOnly" | "Hidden" | "Output" | "Transient" | "NoRecompute" | "Dynamic" | (string & {});

export interface PropertyInfo {
  name: string;
  /** FreeCAD property type, e.g. `App::PropertyLength`. */
  type: string;
  group: string;
  /** Tooltip. */
  doc: string;
  status: PropertyStatus[];
  value: WireValue;
  expression?: string;
  enum?: string[];
  unit?: string;
}

export interface ObjectWithProperties extends ObjectInfo {
  properties?: PropertyInfo[];
}

/**
 * One object's mesh as it travels. The byte fields are little-endian arrays; turn them into typed
 * views with `decodeTessellation()` from `./tessellation`.
 */
export interface WireTessellation {
  object: string;
  placement: WirePlacement;
  /** Changes whenever the shape changes. **Assumed**: a number (a string would work the same as a cache key). */
  revision: number | string;
  /** float32 x,y,z triples, global frame. */
  positions: Uint8Array;
  /** float32 per-vertex normals. */
  normals?: Uint8Array;
  /** uint32 triangle indices. */
  indices: Uint8Array;
  /** Per face `[firstTriangle, triangleCount]`; face `i` is `Face{i+1}`. */
  faces: [number, number][];
  /** Per edge `[firstPoint, pointCount]` into `edgePositions`; edge `i` is `Edge{i+1}`. */
  edges: [number, number][];
  /** float32 polyline points. */
  edgePositions: Uint8Array;
  /** float32 points; vertex `i` is `Vertex{i+1}`. */
  vertices: Uint8Array;
}

export interface FileBytes {
  data: Uint8Array;
  fileName: string;
}

export interface PythonResult {
  stdout: string;
  stderr: string;
  result?: WireValue;
}

export type ExportFormat = "step" | "iges" | "brep" | "stl" | "obj";

// ------------------------------------------------------------------------------------ commands

type Empty = Record<string, never>;

export interface DocParams {
  doc: string;
}

export interface ObjectParams {
  doc: string;
  object: string;
}

/** Command name -> `{params, result}`. The single source every typed wrapper derives from. */
export interface Commands {
  // Server
  Ping: { params: Empty; result: null };
  GetVersion: { params: Empty; result: VersionInfo };
  GetServerInfo: { params: Empty; result: ServerInfo };
  GetCommands: { params: Empty; result: CommandDescription[] };
  GetTypes: { params: { base?: string }; result: string[] };
  LoadModule: { params: { name: string }; result: null };

  // Documents
  ListDocuments: { params: Empty; result: DocumentInfo[] };
  NewDocument: { params: { name?: string; label?: string }; result: DocumentInfo };
  OpenDocument: { params: { path: string }; result: DocumentInfo };
  OpenDocumentBytes: { params: { data: Uint8Array; fileName?: string }; result: DocumentInfo };
  SaveDocument: { params: DocParams; result: DocumentInfo };
  SaveDocumentAs: { params: DocParams & { path: string }; result: DocumentInfo };
  SaveDocumentBytes: { params: DocParams; result: FileBytes };
  CloseDocument: { params: DocParams; result: null };
  SetActiveDocument: { params: DocParams; result: null };
  Recompute: { params: DocParams & { force?: boolean }; result: RecomputeResult };
  Undo: { params: DocParams; result: UndoStack };
  Redo: { params: DocParams; result: UndoStack };
  GetUndoStack: { params: DocParams; result: UndoStack };
  OpenTransaction: { params: DocParams & { name: string }; result: null };
  CommitTransaction: { params: DocParams; result: null };
  AbortTransaction: { params: DocParams; result: null };

  // Objects
  GetObjects: { params: DocParams; result: ObjectInfo[] };
  /** **Assumed**: `properties: true` adds every property. */
  GetObject: { params: ObjectParams & { properties?: boolean }; result: ObjectWithProperties };
  GetProperties: { params: ObjectParams & { names?: string[] }; result: PropertyInfo[] };
  SetProperties: { params: ObjectParams & { values: Record<string, PropertyInput> }; result: PropertyInfo[] };
  /** `expression: null` clears it. */
  SetExpression: { params: ObjectParams & { path: string; expression: string | null }; result: null };
  AddObject: {
    params: DocParams & { type: string; name?: string; label?: string; properties?: Record<string, PropertyInput>; group?: string };
    result: ObjectInfo;
  };
  RemoveObject: { params: ObjectParams & { recursive?: boolean }; result: null };
  /**
   * PROTOCOL.md lists `{doc, object, type, name, group?, doc?}`: `doc` twice. **Assumed**: the first is
   * the document and the property's tooltip travels as `documentation`.
   */
  AddProperty: { params: ObjectParams & { type: string; name: string; group?: string; documentation?: string }; result: PropertyInfo };
  RemoveProperty: { params: ObjectParams & { name: string }; result: null };

  // Geometry
  /** **Assumed**: `edges` defaults to true; `deflection` is absolute (mm), `angularDeflection` in degrees. */
  Tessellate: {
    params: DocParams & { objects?: string[]; deflection?: number; angularDeflection?: number; edges?: boolean };
    result: WireTessellation[];
  };
  /** **Assumed**: `null` when nothing in the selection has geometry. */
  GetBoundingBox: { params: DocParams & { objects?: string[] }; result: BoundBox | null };

  // Import / export / scripting
  /** **Assumed**: the result lists the internal names of the objects created. */
  Import: { params: DocParams & { path?: string; data?: Uint8Array; fileName: string }; result: string[] };
  Export: { params: DocParams & { objects: string[]; format: ExportFormat }; result: FileBytes };
  RunPython: { params: { code: string; mode?: "exec" | "eval" }; result: PythonResult };
}

export type CommandName = keyof Commands;
export type ParamsOf<K extends CommandName> = Commands[K]["params"];
export type ResultOf<K extends CommandName> = Commands[K]["result"];

/** Every command, in PROTOCOL.md order (runtime list for tooling and the mock server). */
export const COMMAND_NAMES = [
  "Ping",
  "GetVersion",
  "GetServerInfo",
  "GetCommands",
  "GetTypes",
  "LoadModule",
  "ListDocuments",
  "NewDocument",
  "OpenDocument",
  "OpenDocumentBytes",
  "SaveDocument",
  "SaveDocumentAs",
  "SaveDocumentBytes",
  "CloseDocument",
  "SetActiveDocument",
  "Recompute",
  "Undo",
  "Redo",
  "GetUndoStack",
  "OpenTransaction",
  "CommitTransaction",
  "AbortTransaction",
  "GetObjects",
  "GetObject",
  "GetProperties",
  "SetProperties",
  "SetExpression",
  "AddObject",
  "RemoveObject",
  "AddProperty",
  "RemoveProperty",
  "Tessellate",
  "GetBoundingBox",
  "Import",
  "Export",
  "RunPython",
] as const satisfies readonly CommandName[];

// Compile-time check that COMMAND_NAMES covers `Commands` exactly.
type _MissingCommands = Exclude<CommandName, (typeof COMMAND_NAMES)[number]>;
const _allCommandsListed: _MissingCommands extends never ? true : _MissingCommands = true;
void _allCommandsListed;

// -------------------------------------------------------------------------------------- events

interface WithClient {
  /** The client whose request caused the event, when there was one. */
  client?: string;
}

/** Event name -> `data`. */
export interface Events {
  DocumentCreated: { doc: string; label: string } & WithClient;
  DocumentDeleted: { doc: string } & WithClient;
  DocumentRenamed: { doc: string; label: string } & WithClient;
  ActiveDocumentChanged: { doc: string } & WithClient;
  DocumentSaved: { doc: string; fileName: string } & WithClient;
  DocumentRestored: { doc: string } & WithClient;
  ObjectCreated: { doc: string; object: string; type: string } & WithClient;
  ObjectDeleted: { doc: string; object: string } & WithClient;
  ObjectChanged: { doc: string; object: string; property: string } & WithClient;
  ObjectRecomputed: { doc: string; object: string } & WithClient;
  Recomputed: { doc: string } & WithClient;
  TransactionOpened: { doc: string; name: string } & WithClient;
  TransactionCommitted: { doc: string } & WithClient;
  TransactionAborted: { doc: string } & WithClient;
  Undo: { doc: string } & WithClient;
  Redo: { doc: string } & WithClient;
}

export type EventName = keyof Events;

export const EVENT_NAMES = [
  "DocumentCreated",
  "DocumentDeleted",
  "DocumentRenamed",
  "ActiveDocumentChanged",
  "DocumentSaved",
  "DocumentRestored",
  "ObjectCreated",
  "ObjectDeleted",
  "ObjectChanged",
  "ObjectRecomputed",
  "Recomputed",
  "TransactionOpened",
  "TransactionCommitted",
  "TransactionAborted",
  "Undo",
  "Redo",
] as const satisfies readonly EventName[];

type _MissingEvents = Exclude<EventName, (typeof EVENT_NAMES)[number]>;
const _allEventsListed: _MissingEvents extends never ? true : _MissingEvents = true;
void _allEventsListed;

export function isCommandName(s: string): s is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(s);
}

export function isEventName(s: string): s is EventName {
  return (EVENT_NAMES as readonly string[]).includes(s);
}

export type { WireObjectRef };

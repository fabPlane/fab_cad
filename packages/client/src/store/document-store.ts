/**
 * Layer 3 — `DocumentStore`: a client-side mirror of the server's documents, objects and
 * properties, kept current by events.
 *
 * `load()` reads everything once (`ListDocuments`, then `GetObjects` and `GetProperties` per
 * object). After that, events mark what went stale and a debounced flush refetches just that:
 * `ObjectChanged` refetches the changed properties and the object's info, `ObjectCreated` the new
 * object, document-level events the document list, and so on. A server request's events arrive in
 * one burst after its reply, so the debounce turns them into one refetch per object.
 *
 * Tessellations are cached by `(object, revision)`; `ObjectRecomputed` and placement or shape
 * changes mark an object's mesh stale, and `tessellate()` fetches only the stale ones.
 */
import type { DocumentInfo, EventName, Events, ObjectInfo, PropertyInfo, Tessellation } from "@fab-cad/protocol";
import type { FreeCADClient } from "../client";
import { FreeCADApiError } from "../errors";
import { Listeners, errorMessage } from "../transport/types";
import { TessellationCache, type TessellationCacheOptions } from "./tessellation-cache";

export interface DocumentState {
  info: DocumentInfo;
  /** Internal names in document order. */
  order: string[];
  objects: Map<string, ObjectInfo>;
  properties: Map<string, Map<string, PropertyInfo>>;
}

export type StoreChange =
  | { kind: "documents" }
  | { kind: "document"; doc: string }
  | { kind: "documentRemoved"; doc: string }
  | { kind: "objects"; doc: string }
  | { kind: "object"; doc: string; object: string; properties?: string[] }
  | { kind: "objectRemoved"; doc: string; object: string }
  | { kind: "tessellation"; doc: string; object: string }
  | { kind: "reloaded" };

export interface DocumentStoreOptions {
  /** How long to gather events before refetching. Default 10 ms. */
  debounceMs?: number;
  /** Load properties of every object on `load()` and on `ObjectCreated`. Default true. */
  loadProperties?: boolean;
  /** Tessellation defaults for `tessellate()`. */
  deflection?: number;
  cache?: TessellationCacheOptions;
  log?: (message: string) => void;
}

interface DirtyObject {
  info: boolean;
  /** `"all"` or specific property names. */
  props: Set<string> | "all" | null;
}

interface DirtyDoc {
  objectList: boolean;
  objects: Map<string, DirtyObject>;
}

/** Properties whose change moves or changes the mesh without an `ObjectRecomputed`. */
const SHAPE_PROPERTIES = new Set(["Placement", "Shape"]);

export class DocumentStore {
  readonly cache: TessellationCache;
  private readonly docs = new Map<string, DocumentState>();
  private readonly listeners: Listeners<[StoreChange]>;
  private readonly staleMeshes = new Set<string>();
  private readonly debounceMs: number;
  private readonly loadProps: boolean;
  private readonly deflection: number | undefined;
  private readonly log: (message: string) => void;
  private readonly offs: (() => void)[] = [];
  private dirtyDocuments = false;
  private readonly dirty = new Map<string, DirtyDoc>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private _version = 0;
  private disposed = false;

  constructor(
    readonly client: FreeCADClient,
    opts: DocumentStoreOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 10;
    this.loadProps = opts.loadProperties ?? true;
    this.deflection = opts.deflection;
    this.log = opts.log ?? (() => {});
    this.listeners = new Listeners(this.log);
    this.cache = new TessellationCache(opts.cache);
    this.offs.push(client.on("*", (data, msg) => this.onEvent(msg.event, data)));
    this.offs.push(client.onRestarted(() => void this.reload()));
    this.offs.push(client.onGap(() => void this.reload()));
  }

  /** Bumped on every change notification; cheap "did anything change" check for a UI. */
  get version(): number {
    return this._version;
  }

  // ------------------------------------------------------------------------------ queries

  documents(): DocumentInfo[] {
    return [...this.docs.values()].map((d) => d.info);
  }

  document(doc: string): DocumentState | undefined {
    return this.docs.get(doc);
  }

  activeDocument(): DocumentInfo | undefined {
    return this.documents().find((d) => d.active);
  }

  objects(doc: string): ObjectInfo[] {
    const d = this.docs.get(doc);
    return d ? d.order.map((n) => d.objects.get(n)).filter((o): o is ObjectInfo => !!o) : [];
  }

  object(doc: string, object: string): ObjectInfo | undefined {
    return this.docs.get(doc)?.objects.get(object);
  }

  properties(doc: string, object: string): PropertyInfo[] {
    return [...(this.docs.get(doc)?.properties.get(object)?.values() ?? [])];
  }

  property(doc: string, object: string, name: string): PropertyInfo | undefined {
    return this.docs.get(doc)?.properties.get(object)?.get(name);
  }

  /** Top-level objects (no parent) — the roots of a tree view. */
  roots(doc: string): ObjectInfo[] {
    return this.objects(doc).filter((o) => o.parents.length === 0);
  }

  subscribe(cb: (change: StoreChange) => void): () => void {
    return this.listeners.add(cb);
  }

  // ------------------------------------------------------------------------------ loading

  /** Read every document, object and property. */
  async load(): Promise<void> {
    const infos = await this.client.listDocuments();
    this.docs.clear();
    await Promise.all(infos.map((info) => this.loadDocument(info)));
    this.emit({ kind: "reloaded" });
  }

  /** Forget everything (and the meshes) and load again: after a restart or missed events. */
  async reload(): Promise<void> {
    this.dirty.clear();
    this.dirtyDocuments = false;
    this.cache.clear();
    this.staleMeshes.clear();
    try {
      await this.load();
    } catch (e) {
      this.log(`reload failed: ${errorMessage(e)}`);
    }
  }

  private async loadDocument(info: DocumentInfo): Promise<void> {
    const objects = await this.client.getObjects(info.name);
    const state: DocumentState = {
      info,
      order: objects.map((o) => o.name),
      objects: new Map(objects.map((o) => [o.name, o])),
      properties: new Map(),
    };
    this.docs.set(info.name, state);
    if (this.loadProps) {
      await Promise.all(
        objects.map(async (o) => {
          const props = await this.client.getProperties(info.name, o.name).catch(ignoreNotFound);
          if (props) state.properties.set(o.name, new Map(props.map((p) => [p.name, p])));
        }),
      );
    }
  }

  // ------------------------------------------------------------------------------ events

  private onEvent(name: EventName, data: Events[EventName]): void {
    if (this.disposed) return;
    const d = data as { doc?: string; object?: string; property?: string };
    switch (name) {
      case "DocumentCreated":
      case "DocumentRestored":
        this.dirtyDocuments = true;
        this.markObjectList(d.doc!);
        break;
      case "DocumentDeleted":
        this.removeDocument(d.doc!);
        this.dirtyDocuments = true;
        break;
      case "DocumentRenamed":
      case "ActiveDocumentChanged":
      case "DocumentSaved":
      case "TransactionOpened":
      case "TransactionCommitted":
      case "TransactionAborted":
      case "Recomputed":
        this.dirtyDocuments = true;
        break;
      case "Undo":
      case "Redo":
        this.dirtyDocuments = true;
        this.markObjectList(d.doc!);
        break;
      case "ObjectCreated":
        this.markObject(d.doc!, d.object!, true, "all");
        this.markObjectList(d.doc!);
        this.dirtyDocuments = true;
        break;
      case "ObjectDeleted":
        this.removeObject(d.doc!, d.object!);
        this.markObjectList(d.doc!);
        this.dirtyDocuments = true;
        break;
      case "ObjectChanged":
        this.markObject(d.doc!, d.object!, true, d.property!);
        if (SHAPE_PROPERTIES.has(d.property!)) this.invalidateMesh(d.doc!, d.object!);
        break;
      case "ObjectRecomputed":
        this.markObject(d.doc!, d.object!, true, null);
        this.invalidateMesh(d.doc!, d.object!);
        break;
    }
    this.schedule();
  }

  private dirtyDoc(doc: string): DirtyDoc {
    let dd = this.dirty.get(doc);
    if (!dd) this.dirty.set(doc, (dd = { objectList: false, objects: new Map() }));
    return dd;
  }

  private markObjectList(doc: string): void {
    this.dirtyDoc(doc).objectList = true;
  }

  private markObject(doc: string, object: string, info: boolean, prop: string | "all" | null): void {
    const dd = this.dirtyDoc(doc);
    let o = dd.objects.get(object);
    if (!o) dd.objects.set(object, (o = { info: false, props: null }));
    o.info ||= info;
    if (prop === "all") o.props = "all";
    else if (prop !== null && o.props !== "all") {
      o.props ??= new Set();
      o.props.add(prop);
    }
  }

  private removeDocument(doc: string): void {
    this.dirty.delete(doc);
    this.cache.evictDocument(doc);
    for (const k of [...this.staleMeshes]) if (k.startsWith(`${doc}\u0000`)) this.staleMeshes.delete(k);
    if (this.docs.delete(doc)) this.emit({ kind: "documentRemoved", doc });
  }

  private removeObject(doc: string, object: string): void {
    this.dirty.get(doc)?.objects.delete(object);
    this.cache.evictObject(doc, object);
    this.staleMeshes.delete(`${doc}\u0000${object}`);
    const d = this.docs.get(doc);
    if (!d) return;
    const had = d.objects.delete(object);
    d.properties.delete(object);
    d.order = d.order.filter((n) => n !== object);
    if (had) this.emit({ kind: "objectRemoved", doc, object });
  }

  private invalidateMesh(doc: string, object: string): void {
    const k = `${doc}\u0000${object}`;
    if (this.staleMeshes.has(k)) return;
    this.staleMeshes.add(k);
    this.emit({ kind: "tessellation", doc, object });
  }

  private schedule(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /**
   * Refetch everything marked stale now. Resolves when the store is current with every event
   * received so far (tests and "wait until settled" UIs use it).
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) await this.flushing;
    if (!this.dirtyDocuments && this.dirty.size === 0) return;
    this.flushing = this.runFlush().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
    if (this.dirtyDocuments || this.dirty.size > 0) await this.flush();
  }

  private async runFlush(): Promise<void> {
    const docsDirty = this.dirtyDocuments;
    const dirty = new Map(this.dirty);
    this.dirtyDocuments = false;
    this.dirty.clear();

    if (docsDirty) {
      try {
        const infos = await this.client.listDocuments();
        const seen = new Set<string>();
        for (const info of infos) {
          seen.add(info.name);
          const d = this.docs.get(info.name);
          if (d) {
            if (JSON.stringify(d.info) !== JSON.stringify(info)) {
              d.info = info;
              this.emit({ kind: "document", doc: info.name });
            }
          } else {
            this.docs.set(info.name, { info, order: [], objects: new Map(), properties: new Map() });
            if (!dirty.has(info.name)) dirty.set(info.name, { objectList: true, objects: new Map() });
          }
        }
        for (const name of [...this.docs.keys()]) if (!seen.has(name)) this.removeDocument(name);
        this.emit({ kind: "documents" });
      } catch (e) {
        this.log(`ListDocuments failed: ${errorMessage(e)}`);
      }
    }

    await Promise.all([...dirty].map(([doc, dd]) => this.refreshDocument(doc, dd)));
  }

  private async refreshDocument(doc: string, dd: DirtyDoc): Promise<void> {
    const state = this.docs.get(doc);
    if (!state) return;
    let listed: Set<string> | undefined;
    if (dd.objectList) {
      try {
        const infos = await this.client.getObjects(doc);
        listed = new Set(infos.map((o) => o.name));
        for (const name of state.order) {
          if (!listed.has(name)) this.removeObject(doc, name);
        }
        for (const info of infos) {
          const known = state.objects.has(info.name);
          state.objects.set(info.name, info);
          if (!known && this.loadProps && !dd.objects.has(info.name)) dd.objects.set(info.name, { info: false, props: "all" });
          // Every object's info can change on a list refresh (inList, children, ...).
          if (known && !dd.objects.has(info.name)) this.emit({ kind: "object", doc, object: info.name });
        }
        state.order = infos.map((o) => o.name);
        this.emit({ kind: "objects", doc });
      } catch (e) {
        if (FreeCADApiError.is(e, "NOT_FOUND")) {
          this.removeDocument(doc);
          return;
        }
        this.log(`GetObjects(${doc}) failed: ${errorMessage(e)}`);
      }
    }

    await Promise.all(
      [...dd.objects].map(async ([object, what]) => {
        try {
          if (what.info && !listed?.has(object)) {
            const info = await this.client.getObject(doc, object);
            state.objects.set(object, info);
            if (!state.order.includes(object)) state.order.push(object);
          }
          let changedProps: string[] | undefined;
          if (what.props && (this.loadProps || state.properties.has(object))) {
            const names = what.props === "all" ? undefined : [...what.props];
            const props = await this.client.getProperties(doc, object, names).catch((e) => {
              // a dynamic property removed: fall back to the full list
              if (names && FreeCADApiError.is(e, "NOT_FOUND")) return this.client.getProperties(doc, object);
              throw e;
            });
            let map = state.properties.get(object);
            if (!map || what.props === "all" || props.length !== names?.length) state.properties.set(object, (map = new Map()));
            for (const p of props) map.set(p.name, p);
            changedProps = names ?? props.map((p) => p.name);
          }
          if (state.objects.has(object))
            this.emit(changedProps ? { kind: "object", doc, object, properties: changedProps } : { kind: "object", doc, object });
        } catch (e) {
          if (FreeCADApiError.is(e, "NOT_FOUND")) this.removeObject(doc, object);
          else this.log(`refreshing ${doc}#${object} failed: ${errorMessage(e)}`);
        }
      }),
    );
  }

  // ------------------------------------------------------------------------------ meshes

  /** Is the cached mesh of an object known to be out of date (or missing)? */
  isMeshStale(doc: string, object: string): boolean {
    return this.staleMeshes.has(`${doc}\u0000${object}`) || !this.cache.latest(doc, object);
  }

  /**
   * Meshes for `objects` (default: every object with geometry), fetching only those not cached or
   * marked stale, in one `Tessellate` request.
   */
  async tessellate(doc: string, objects?: string[]): Promise<Tessellation[]> {
    const wanted =
      objects ??
      this.objects(doc)
        .filter((o) => o.isGeo)
        .map((o) => o.name);
    const fetch = wanted.filter((o) => this.isMeshStale(doc, o));
    if (fetch.length > 0) {
      const opts: { objects: string[]; deflection?: number } = { objects: fetch };
      if (this.deflection !== undefined) opts.deflection = this.deflection;
      const meshes = await this.client.tessellate(doc, opts);
      const got = new Set<string>();
      for (const t of meshes) {
        this.cache.put(doc, t);
        got.add(t.object);
      }
      for (const o of fetch) {
        this.staleMeshes.delete(`${doc}\u0000${o}`);
        if (!got.has(o)) this.cache.evictObject(doc, o); // no shape (any more)
      }
    }
    return wanted.map((o) => this.cache.latest(doc, o)).filter((t): t is Tessellation => !!t);
  }

  /** Stop listening to the client. The store keeps its last state. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs) off();
    this.listeners.clear();
  }

  private emit(change: StoreChange): void {
    this._version++;
    this.listeners.emit(change);
  }
}

function ignoreNotFound(e: unknown): undefined {
  if (FreeCADApiError.is(e, "NOT_FOUND")) return undefined;
  throw e;
}

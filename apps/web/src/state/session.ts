/**
 * The connection to FreeCAD and the live model mirror (`DocumentStore` from `@fab-cad/client`).
 *
 * React reads the model through `useModel()`, which re-renders on a `version` counter bumped
 * (once per microtask) whenever the store reports a change. Undo stacks, the active document and
 * server restarts are handled here.
 */
import type { DocumentInfo, DocumentStore, FreeCADClient, ObjectInfo, PropertyInfo, StoreChange, UndoStack } from "@fab-cad/client";
import { create } from "zustand";
import type { BackendChoice, Connection } from "../backend/connect";
import { useApp } from "./app";
import { log } from "./console";
import { useSelection } from "./selection";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

interface SessionState {
  status: ConnectionStatus;
  error: string | null;
  conn: Connection | null;
  choice: BackendChoice | null;
  /** Bumped whenever the model changes. */
  version: number;
  /** Last change kinds seen, for listeners that care (the 3D view). */
  undo: Record<string, UndoStack>;
  /** Commands in flight (a busy cursor / disabled toolbar). */
  busy: number;
}

export const useSession = create<SessionState>(() => ({
  status: "idle",
  error: null,
  conn: null,
  choice: null,
  version: 0,
  undo: {},
  busy: 0,
}));

type ChangeListener = (c: StoreChange) => void;
const changeListeners = new Set<ChangeListener>();

/** Subscribe to raw store changes (the 3D view uses this for incremental mesh updates). */
export function onModelChange(cb: ChangeListener): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

let bumpQueued = false;
function bump(): void {
  if (bumpQueued) return;
  bumpQueued = true;
  queueMicrotask(() => {
    bumpQueued = false;
    useSession.setState((s) => ({ version: s.version + 1 }));
  });
}

export function conn(): Connection | null {
  return useSession.getState().conn;
}

export function client(): FreeCADClient {
  const c = conn();
  if (!c) throw new Error("not connected to FreeCAD");
  return c.client;
}

export function store(): DocumentStore | null {
  return conn()?.store ?? null;
}

// ------------------------------------------------------------------------------ queries

export function documents(): DocumentInfo[] {
  return store()?.documents() ?? [];
}

export function docInfo(doc: string | null | undefined): DocumentInfo | undefined {
  return doc ? store()?.document(doc)?.info : undefined;
}

export function objects(doc: string | null | undefined): ObjectInfo[] {
  return doc ? (store()?.objects(doc) ?? []) : [];
}

export function object(doc: string | null | undefined, name: string): ObjectInfo | undefined {
  return doc ? store()?.object(doc, name) : undefined;
}

export function properties(doc: string, name: string): PropertyInfo[] {
  return store()?.properties(doc, name) ?? [];
}

export function property(doc: string, name: string, prop: string): PropertyInfo | undefined {
  return store()?.property(doc, name, prop);
}

export function labelOf(doc: string, name: string): string {
  return object(doc, name)?.label ?? name;
}

/** Re-render on model changes; returns the version. */
export function useModel(): number {
  return useSession((s) => s.version);
}

// ------------------------------------------------------------------------------ undo stacks

const undoTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function refreshUndo(doc: string): Promise<void> {
  const c = conn();
  if (!c) return;
  try {
    const stack = await c.client.getUndoStack(doc);
    useSession.setState((s) => ({ undo: { ...s.undo, [doc]: stack } }));
  } catch {
    // document gone
  }
}

function scheduleUndo(doc: string): void {
  if (undoTimers.has(doc)) return;
  undoTimers.set(
    doc,
    setTimeout(() => {
      undoTimers.delete(doc);
      void refreshUndo(doc);
    }, 30),
  );
}

// ------------------------------------------------------------------------------ attach

/** Make the UI follow the documents: MDI tabs for new documents, the server's active document. */
function syncDocuments(): void {
  const s = store();
  if (!s) return;
  const docs = s.documents();
  const names = new Set(docs.map((d) => d.name));
  const app = useApp.getState();
  for (const t of app.openTabs) if (!names.has(t)) useApp.getState().closeTab(t);
  for (const d of docs) if (!useApp.getState().openTabs.includes(d.name)) useApp.getState().openTab(d.name);
  const cur = useApp.getState().activeDoc;
  if (cur && !names.has(cur)) useApp.getState().setActiveDoc(docs.find((d) => d.active)?.name ?? docs[0]?.name ?? null);
  if (!useApp.getState().activeDoc && !useApp.getState().startTab && docs.length) {
    useApp.getState().setActiveDoc(docs.find((d) => d.active)?.name ?? docs[0]!.name);
  }
  const editing = useApp.getState().editing;
  if (editing && !s.object(editing.doc, editing.object)) useApp.getState().setEditing(null);
  useSelection.getState().prune((doc, obj) => !!s.object(doc, obj));
}

let detach: (() => void) | null = null;

export function attachConnection(c: Connection, choice: BackendChoice): void {
  detach?.();
  const offs: (() => void)[] = [];
  offs.push(
    c.store.subscribe((change) => {
      for (const l of changeListeners) l(change);
      if (change.kind === "documents" || change.kind === "documentRemoved" || change.kind === "reloaded") syncDocuments();
      if (change.kind === "objectRemoved" || change.kind === "objects") syncDocuments();
      if (change.kind === "document") scheduleUndo(change.doc);
      if (change.kind === "reloaded") for (const d of c.store.documents()) scheduleUndo(d.name);
      bump();
    }),
  );
  offs.push(
    c.client.onRestarted((info) => {
      log.warning(`FreeCAD restarted (token ${info.previousToken.slice(0, 8)} -> ${info.newToken.slice(0, 8)}); reloading the documents.`);
      useSelection.getState().clear();
      const app = useApp.getState();
      if (app.task) app.closeTask();
      if (app.editing) app.setEditing(null);
    }),
  );
  offs.push(
    c.client.transport.onStateChange((st) => {
      if (st === "closed") {
        useSession.setState({ status: "disconnected", error: "The connection to FreeCAD was closed." });
        log.error("The connection to FreeCAD was closed.");
      }
    }),
  );
  detach = () => offs.forEach((o) => o());
  useSession.setState({ conn: c, choice, status: "connected", error: null });
  syncDocuments();
  for (const d of c.store.documents()) scheduleUndo(d.name);
  bump();
}

export async function disconnect(): Promise<void> {
  const c = conn();
  detach?.();
  detach = null;
  useSession.setState({ conn: null, status: "idle" });
  if (c) await c.close().catch(() => undefined);
}

/** Run an async action with the busy counter held. */
export async function busy<T>(fn: () => Promise<T>): Promise<T> {
  useSession.setState((s) => ({ busy: s.busy + 1 }));
  try {
    return await fn();
  } finally {
    useSession.setState((s) => ({ busy: s.busy - 1 }));
  }
}

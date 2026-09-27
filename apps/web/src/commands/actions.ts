/**
 * The document operations behind the commands, each one FreeCAD API call (or a few inside one
 * transaction) plus the Python line FreeCAD's GUI would echo for it.
 */
import { FreeCADApiError, type ExportFormat, type PropertyInput } from "@fab-cad/client";
import { download, extensionOf, fileBytes, IMPORT_EXTENSIONS } from "../lib/files";
import { pyStr } from "../lib/format";
import { useApp } from "../state/app";
import { echo, log } from "../state/console";
import { useSelection } from "../state/selection";
import { client, conn, docInfo, labelOf, object, objects, refreshUndo, store, useSession } from "../state/session";
import { viewer } from "../state/view3d";
import { useViewProps } from "../state/viewprops";

export function errorText(e: unknown): string {
  if (e instanceof FreeCADApiError) return e.serverMessage || e.message;
  return e instanceof Error ? e.message : String(e);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Wait until the model mirror has applied the events of the last request. The server sends a
 * request's events right after its reply, so they may still be in the socket's buffer when the
 * reply resolves: let them in, then flush.
 */
export async function settle(): Promise<void> {
  await tick();
  await tick();
  await store()?.flush();
}

/** Wait (up to `ms`) until `pred` holds for the model mirror. */
export async function waitForModel(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const s = store();
  if (!s) return false;
  await settle();
  if (pred()) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => (off(), resolve(pred())), ms);
    const off = s.subscribe(() => {
      if (!pred()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

// ------------------------------------------------------------------------------ documents

export async function newDocument(): Promise<string> {
  echo("App.newDocument()");
  const info = await client().newDocument();
  await waitForModel(() => !!store()?.document(info.name));
  useApp.getState().setActiveDoc(info.name);
  return info.name;
}

export async function activateDocument(doc: string): Promise<void> {
  useApp.getState().setActiveDoc(doc);
  if (!docInfo(doc)?.active)
    await client()
      .setActiveDocument(doc)
      .catch(() => undefined);
}

/** Open a file: `.FCStd` as a document, anything importable into a new one (FreeCAD's File > Open). */
export async function openFile(file: File): Promise<void> {
  const ext = extensionOf(file.name);
  const data = await fileBytes(file);
  if (ext === "fcstd") {
    echo(`FreeCAD.openDocument(${pyStr(file.name)})`);
    const info = await client().openDocumentBytes(data, file.name);
    uploaded.add(info.name);
    await waitForModel(() => !!store()?.document(info.name));
    useApp.getState().setActiveDoc(info.name);
    await recompute(info.name, { quiet: true, onlyIfTouched: true });
    setTimeout(() => viewer()?.fitAll(), 50);
    log.message(`Opened ${file.name}`);
    return;
  }
  if (IMPORT_EXTENSIONS.includes(ext)) {
    const stem = file.name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_]/g, "_") || "Unnamed";
    const info = await client().newDocument({ name: stem, label: file.name.replace(/\.[^.]*$/, "") });
    await waitForModel(() => !!store()?.document(info.name));
    useApp.getState().setActiveDoc(info.name);
    await importInto(info.name, file.name, data);
    return;
  }
  throw new Error(`Cannot open ${file.name}: unknown file type`);
}

export async function importInto(doc: string, fileName: string, data: Uint8Array): Promise<string[]> {
  const ext = extensionOf(fileName);
  if (ext === "stl" || ext === "obj") echo(["import Mesh", `Mesh.insert(${pyStr(fileName)},${pyStr(doc)})`]);
  else echo(["import ImportGui", `ImportGui.insert(${pyStr(fileName)},${pyStr(doc)})`]);
  const created = await client().importFile(doc, { data, fileName });
  await settle();
  await recompute(doc, { quiet: true, onlyIfTouched: true });
  log.message(`Imported ${fileName}: ${created.length} object${created.length === 1 ? "" : "s"}`);
  setTimeout(() => viewer()?.fitAll(), 50);
  return created;
}

/** Is the server's file system the user's (native server, bridge)? Then paths mean something. */
export function serverHasFiles(): boolean {
  const k = conn()?.kind;
  return k === "ws" || k === "bridge";
}

/** Documents that came in as bytes: their server path is a temporary upload, not the user's file. */
const uploaded = new Set<string>();

/** The document's path on the server when it is a real file the user chose (not an upload). */
export function serverPath(doc: string): string | null {
  const f = docInfo(doc)?.fileName ?? "";
  if (!f || uploaded.has(doc) || /[\\/]fcapi-upload-[^\\/]*[\\/]/.test(f)) return null;
  return serverHasFiles() ? f : null;
}

export async function saveDocument(doc: string, opts: { as?: "download" | { path: string }; copy?: boolean } = {}): Promise<void> {
  const info = docInfo(doc);
  if (!info) return;
  const path = serverPath(doc);
  const target = opts.as ?? (path ? { path } : "download");
  if (target !== "download") {
    if (target.path === path && !opts.as) {
      echo(`App.getDocument(${pyStr(doc)}).save()`);
      await client().saveDocument(doc);
    } else {
      echo(`App.getDocument(${pyStr(doc)}).saveAs(${pyStr(target.path)})`);
      await client().saveDocumentAs(doc, target.path);
      uploaded.delete(doc);
    }
    log.message(`Saved ${target.path}`);
    await settle();
    return;
  }
  const bytes = await client().saveDocumentBytes(doc);
  const name = bytes.fileName ? bytes.fileName.split(/[\\/]/).pop()! : `${info.label}.FCStd`;
  echo(`App.getDocument(${pyStr(doc)}).saveAs(${pyStr(name)})`);
  download(bytes.data, name.toLowerCase().endsWith(".fcstd") ? name : `${name}.FCStd`, "application/zip");
  log.message(`Saved ${name} (download)`);
  await settle();
}

export async function closeDocument(doc: string): Promise<void> {
  echo(`App.closeDocument(${pyStr(doc)})`);
  if (useApp.getState().editing?.doc === doc) useApp.getState().setEditing(null);
  await client().closeDocument(doc);
  useSelection.getState().clear(doc);
  useViewProps.getState().forget(doc);
  useApp.getState().closeTab(doc);
  await settle();
}

export const EXPORT_FORMATS: { format: ExportFormat; ext: string; label: string }[] = [
  { format: "step", ext: "step", label: "STEP with colors (*.step *.stp)" },
  { format: "iges", ext: "iges", label: "IGES format (*.iges *.igs)" },
  { format: "brep", ext: "brep", label: "BREP format (*.brep *.brp)" },
  { format: "stl", ext: "stl", label: "STL Mesh (*.stl)" },
  { format: "obj", ext: "obj", label: "Alias Mesh (*.obj)" },
];

export async function exportObjects(doc: string, names: string[], format: ExportFormat, fileName?: string): Promise<void> {
  const ext = EXPORT_FORMATS.find((f) => f.format === format)?.ext ?? format;
  const name = fileName ?? `${labelOf(doc, names[0] ?? doc)}.${ext}`;
  const objs = names.map((n) => `FreeCAD.getDocument(${pyStr(doc)}).getObject(${pyStr(n)})`);
  const mod = format === "stl" || format === "obj" ? "Mesh" : "ImportGui";
  echo([
    "__objs__ = []",
    ...objs.map((o) => `__objs__.append(${o})`),
    `import ${mod}`,
    `${mod}.export(__objs__, ${pyStr(name)})`,
    "del __objs__",
  ]);
  const r = await client().exportObjects(doc, names, format);
  download(r.data, name);
  log.message(`Exported ${names.length} object${names.length === 1 ? "" : "s"} to ${name}`);
}

// ------------------------------------------------------------------------------ recompute

export async function recompute(doc: string, opts: { quiet?: boolean; onlyIfTouched?: boolean; force?: boolean } = {}): Promise<boolean> {
  if (opts.onlyIfTouched && !objects(doc).some((o) => o.isTouched || o.isError)) return true;
  if (!opts.quiet) echo(`App.getDocument(${pyStr(doc)}).recompute()`);
  const r = await client().recompute(doc, opts.force);
  for (const e of r.errors) log.error(`${labelOf(doc, e.object)}: ${e.message}`);
  if (r.errors.length) log.error("Recompute failed! Please check report view.");
  await settle();
  return r.errors.length === 0;
}

// ------------------------------------------------------------------------------ transactions

/**
 * FreeCAD's `openCommand` / `commitCommand` / `abortCommand` around `body`: one undo step named
 * `name`, recomputed at the end (`updateActive`), aborted when `body` throws.
 */
export async function command<T>(doc: string, name: string, body: () => Promise<T>, opts: { recompute?: boolean } = {}): Promise<T> {
  const c = client();
  await c.openTransaction(doc, name);
  let result: T;
  try {
    result = await body();
    if (opts.recompute !== false) {
      const r = await c.recompute(doc);
      for (const e of r.errors) log.error(`${labelOf(doc, e.object)}: ${e.message}`);
    }
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    await settle();
    throw e;
  }
  await c.commitTransaction(doc);
  await settle();
  void refreshUndo(doc);
  return result;
}

export interface CreateOptions {
  label?: string;
  properties?: Record<string, PropertyInput>;
  /** Echo lines instead of the default `App.ActiveDocument.addObject(...)`. */
  echo?: string[];
  fit?: boolean;
}

/** `App.ActiveDocument.addObject(type, name)` in its own transaction, then recompute. */
export async function createObject(doc: string, type: string, name: string, txName: string, opts: CreateOptions = {}): Promise<string> {
  echo(opts.echo ?? [`App.ActiveDocument.addObject(${pyStr(type)},${pyStr(name)})`]);
  const created = await command(doc, txName, async () => {
    const params: { name: string; label?: string; properties?: Record<string, PropertyInput> } = { name };
    if (opts.label) params.label = opts.label;
    if (opts.properties) params.properties = opts.properties;
    return client().addObject(doc, type, params);
  });
  await waitForModel(() => !!object(doc, created.name));
  useSelection.getState().select({ doc, object: created.name, sub: "" }, { echo: false });
  if (opts.fit !== false) setTimeout(() => viewer()?.fitAll(), 30);
  return created.name;
}

/** Run Python for a GUI command (echoed) and report its output and exceptions. */
export async function python(code: string, opts: { echo?: boolean; mode?: "exec" | "eval" | "auto" } = {}): Promise<string | undefined> {
  if (opts.echo !== false) echo(code);
  const r = await client().runPython(code, opts.mode ?? "exec");
  if (r.stdout) log.message(r.stdout);
  if (r.stderr) log.warning(r.stderr);
  if (r.exception) throw new Error(r.exception.trim().split("\n").pop() ?? r.exception);
  return r.repr;
}

/** Evaluate a Python expression that returns JSON (`json.dumps(...)`), without echo. */
export async function pythonJson<T>(code: string, expr: string): Promise<T> {
  const c = client();
  if (code) {
    const r = await c.runPython(code, "exec");
    if (r.exception) throw new Error(r.exception.trim().split("\n").pop() ?? r.exception);
  }
  const r = await c.runPython(expr, "eval");
  if (r.exception) throw new Error(r.exception.trim().split("\n").pop() ?? r.exception);
  if (typeof r.result !== "string") throw new Error(`expected a JSON string from ${expr}`);
  return JSON.parse(r.result) as T;
}

// ------------------------------------------------------------------------------ objects

export async function deleteObjects(doc: string, names: string[]): Promise<void> {
  if (!names.length) return;
  echo(names.map((n) => `App.getDocument(${pyStr(doc)}).removeObject(${pyStr(n)})`));
  await command(
    doc,
    "Delete",
    async () => {
      // Children first so a group's members are not orphaned mid-way.
      for (const n of names) if (object(doc, n)) await client().removeObject(doc, n);
    },
    { recompute: false },
  );
  useSelection.getState().clear(doc);
  await recompute(doc, { quiet: true, onlyIfTouched: true });
}

export async function setVisibility(doc: string, names: string[], visible: boolean | "toggle"): Promise<void> {
  if (!names.length) return;
  const lines: string[] = [];
  await command(
    doc,
    "Toggle visibility",
    async () => {
      for (const n of names) {
        const o = object(doc, n);
        if (!o) continue;
        const v = visible === "toggle" ? !o.visibility : visible;
        lines.push(`Gui.getDocument(${pyStr(doc)}).getObject(${pyStr(n)}).Visibility = ${v ? "True" : "False"}`);
        await client().setProperties(doc, n, { Visibility: v });
      }
    },
    { recompute: false },
  );
  echo(lines);
}

export async function renameObject(doc: string, name: string, label: string): Promise<void> {
  if (!label || label === object(doc, name)?.label) return;
  echo(`App.getDocument(${pyStr(doc)}).getObject(${pyStr(name)}).Label = ${pyStr(label)}`);
  await command(doc, "Rename", () => client().setProperties(doc, name, { Label: label }), { recompute: false });
}

export async function undo(doc: string): Promise<void> {
  await client().undo(doc);
  await settle();
  await refreshUndo(doc);
}

export async function redo(doc: string): Promise<void> {
  await client().redo(doc);
  await settle();
  await refreshUndo(doc);
}

export function busyWrap<T>(fn: () => Promise<T>): Promise<T> {
  useSession.setState((s) => ({ busy: s.busy + 1 }));
  return fn().finally(() => useSession.setState((s) => ({ busy: s.busy - 1 })));
}

// ------------------------------------------------------------------------------ property editing

/**
 * One property edit from the property view, the way `PropertyEditor` does it: a transaction named
 * `Edit <Object>.<Property>`, the assignment FreeCAD runs (echoed), a recompute, commit.
 */
export async function editProperty(doc: string, name: string, prop: string, value: PropertyInput, python: string): Promise<void> {
  echo(`FreeCAD.getDocument(${pyStr(doc)}).getObject(${pyStr(name)}).${prop} = ${python}`);
  await command(doc, `Edit ${name}.${prop}`, () => client().setProperties(doc, name, { [prop]: value }));
}

/** Bind (or with `null` clear) an expression: `obj.setExpression('Length', u'Width * 2')`. */
export async function editExpression(doc: string, name: string, path: string, expression: string | null): Promise<void> {
  echo(
    `FreeCAD.getDocument(${pyStr(doc)}).getObject(${pyStr(name)}).setExpression(${pyStr(path)}, ${expression === null ? "None" : `u${pyStr(expression)}`})`,
  );
  await command(doc, `Edit ${name}.${path.split(".")[0]}`, () => client().setExpression(doc, name, path, expression));
}

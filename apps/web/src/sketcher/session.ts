/**
 * Sketch edit mode (`ViewProviderSketch::setEdit`): the sketch being edited, its geometry and
 * constraints (re-read with Python after every change), the active drawing tool, and the
 * selection inside the sketch. Every change is one transaction named like FreeCAD's
 * (`Add sketch line`, `Add coincident constraint`, ...) running on `ActiveSketch`.
 */
import * as THREE from "three";
import { create } from "zustand";
import { errorText, recompute, settle } from "../commands/actions";
import { pyStr } from "../lib/format";
import { useApp } from "../state/app";
import { echo, log } from "../state/console";
import { useSelection } from "../state/selection";
import { client, conn, object, refreshUndo } from "../state/session";
import { currentViewer } from "../ui/View3D";
import { SKETCH_READER_PY, type SketchData } from "./model";

export type SketchTool = "point" | "line" | "polyline" | "rectangle" | "circle" | "arc";

export type SketchSel =
  | { kind: "edge"; geo: number }
  | { kind: "vertex"; n: number }
  | { kind: "root" }
  | { kind: "hAxis" }
  | { kind: "vAxis" }
  | { kind: "constraint"; i: number };

export function selKey(s: SketchSel): string {
  switch (s.kind) {
    case "edge":
      return `Edge${s.geo + 1}`;
    case "vertex":
      return `Vertex${s.n}`;
    case "root":
      return "RootPoint";
    case "hAxis":
      return "H_Axis";
    case "vAxis":
      return "V_Axis";
    case "constraint":
      return `Constraint${s.i + 1}`;
  }
}

interface SketchState {
  doc: string | null;
  name: string | null;
  data: SketchData | null;
  tool: SketchTool | null;
  selected: SketchSel[];
  pre: SketchSel | null;
  busy: boolean;
  setTool: (t: SketchTool | null) => void;
  setSelected: (s: SketchSel[]) => void;
  setPre: (s: SketchSel | null) => void;
}

export const useSketch = create<SketchState>((set) => ({
  doc: null,
  name: null,
  data: null,
  tool: null,
  selected: [],
  pre: null,
  busy: false,
  setTool: (t) => set({ tool: t }),
  setSelected: (s) => set({ selected: s }),
  setPre: (s) => set({ pre: s }),
}));

let savedCamera: { quat: THREE.Quaternion; target: THREE.Vector3; height: number } | null = null;
let readerDefined = false;

export async function readSketch(doc: string, name: string): Promise<SketchData> {
  const c = client();
  if (!readerDefined) {
    const r = await c.runPython(SKETCH_READER_PY, "exec");
    if (r.exception) throw new Error(r.exception);
    readerDefined = true;
  }
  const r = await c.runPython(`_fabcad_sketch_json(${pyStr(doc)}, ${pyStr(name)})`, "eval");
  if (r.exception) {
    // the reader is gone (server restarted): define it again once
    if (/NameError/.test(r.exception) && readerDefined) {
      readerDefined = false;
      return readSketch(doc, name);
    }
    throw new Error(r.exception.trim().split("\n").pop() ?? r.exception);
  }
  return JSON.parse(String(r.result)) as SketchData;
}

export async function refreshSketch(): Promise<void> {
  const { doc, name } = useSketch.getState();
  if (!doc || !name) return;
  try {
    const data = await readSketch(doc, name);
    useSketch.setState({ data });
  } catch (e) {
    log.error(`Reading the sketch failed: ${errorText(e)}`);
  }
}

export async function startSketchEdit(doc: string, name: string): Promise<void> {
  if (!conn()) return;
  const app = useApp.getState();
  if (app.editing) await leaveSketchEdit(false);
  if (app.task) {
    log.warning("Close the open task dialog first.");
    return;
  }
  if (object(doc, name)?.type !== "Sketcher::SketchObject") return;
  readerDefined = false;
  try {
    await client().runPython(`ActiveSketch = App.getDocument(${pyStr(doc)}).getObject(${pyStr(name)})`, "exec");
    echo([
      `ActiveSketch = App.getDocument(${pyStr(doc)}).getObject(${pyStr(name)})`,
      `Gui.getDocument(${pyStr(doc)}).setEdit(ActiveSketch, 0)`,
    ]);
    const data = await readSketch(doc, name);
    useSketch.setState({ doc, name, data, tool: null, selected: [], pre: null });
  } catch (e) {
    log.error(`Cannot edit ${name}: ${errorText(e)} (sketch editing needs RunPython on the server)`);
    return;
  }
  useSelection.getState().clear();
  useApp.getState().setActiveDoc(doc);
  useApp.getState().setEditing({ doc, object: name, kind: "sketch" });
  useApp.getState().setComboTab("tasks");
  // Camera: look at the sketch plane (FreeCAD's `ViewProviderSketch` aligns the view on edit).
  const v = currentViewer();
  if (v) {
    savedCamera = { quat: v.cameraState.quat.clone(), target: v.cameraState.target.clone(), height: v.cameraState.height };
    const { SketchLayer } = await import("./SketchLayer");
    v.edit?.dispose();
    const layer = new SketchLayer(v);
    v.edit = layer;
    const d = useSketch.getState().data!;
    const q = new THREE.Quaternion(...d.placement.q);
    const center = new THREE.Vector3(...d.placement.base);
    const pts = d.geo.flatMap((g) => ("start" in g ? [g.start, g.end] : "center" in g ? [g.center] : "point" in g ? [g.point] : g.points));
    if (pts.length) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      center.add(new THREE.Vector3(cx, cy, 0).applyQuaternion(q));
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 10);
      v.cameraState.height = span * 1.8;
    } else {
      v.cameraState.height = Math.max(v.cameraState.height, 60);
    }
    v.lookAlong(q, center);
    v.invalidate();
  }
}

export async function leaveSketchEdit(recomputeDoc = true): Promise<void> {
  const { doc, name } = useSketch.getState();
  useSketch.setState({ doc: null, name: null, data: null, tool: null, selected: [], pre: null });
  const v = currentViewer();
  if (v?.edit) {
    v.edit.dispose();
    v.edit = null;
  }
  useApp.getState().setEditing(null);
  useApp.getState().setComboTab("model");
  if (v && savedCamera) {
    v.cameraState.target.copy(savedCamera.target);
    v.cameraState.height = savedCamera.height;
    v.setOrientation(savedCamera.quat);
    savedCamera = null;
  }
  if (doc && name) {
    echo([`Gui.getDocument(${pyStr(doc)}).resetEdit()`, `App.getDocument(${pyStr(doc)}).recompute()`]);
    if (recomputeDoc) await recompute(doc, { quiet: true }).catch((e) => log.error(errorText(e)));
    useSelection.getState().select({ doc, object: name, sub: "" }, { echo: false });
  }
}

/** Run Sketcher Python on `ActiveSketch` as one undo step, then re-read the sketch. */
export async function sketchOp(txName: string, lines: string[]): Promise<boolean> {
  const { doc, name } = useSketch.getState();
  if (!doc || !name) return false;
  const c = client();
  useSketch.setState({ busy: true });
  echo(lines);
  try {
    await c.openTransaction(doc, txName);
    const code = [
      `ActiveSketch = App.getDocument(${pyStr(doc)}).getObject(${pyStr(name)})`,
      "import Part, Sketcher",
      ...lines,
      "ActiveSketch.solve()",
    ].join("\n");
    const r = await c.runPython(code, "exec");
    if (r.exception) {
      await c.abortTransaction(doc).catch(() => undefined);
      log.error(r.exception.trim());
      return false;
    }
    await c.commitTransaction(doc);
    return true;
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    log.error(`${txName}: ${errorText(e)}`);
    return false;
  } finally {
    await refreshSketch();
    useSketch.setState({ busy: false });
    await settle();
    void refreshUndo(doc);
  }
}

/** The next geometry index (what `addGeometry` returns). */
export function nextGeoIndex(): number {
  return useSketch.getState().data?.geo.length ?? 0;
}

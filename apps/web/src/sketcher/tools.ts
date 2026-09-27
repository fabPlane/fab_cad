/**
 * Sketcher commands that act on the selection inside the sketch: constraints
 * (`CommandConstraints.cpp`), datum editing, construction mode and deletion.
 */
import { parseQuantity } from "@fab-cad/protocol";
import { fixed, formatQuantity, pyNum } from "../lib/format";
import { log } from "../state/console";
import { prompt } from "../state/dialogs";
import { constraintPy, sketchVertices, type SketchGeo } from "./model";
import { sketchOp, useSketch, type SketchSel } from "./session";

interface Resolved {
  geo: SketchGeo[];
  edges: number[];
  lines: number[];
  circles: number[];
  /** Points as (geo, pos); the root point is (-1, 1). */
  points: { geo: number; pos: number; p: [number, number] }[];
  constraints: number[];
}

export function resolveSelection(sel: SketchSel[] = useSketch.getState().selected): Resolved {
  const data = useSketch.getState().data;
  const geo = data?.geo ?? [];
  const verts = sketchVertices(geo);
  const out: Resolved = { geo, edges: [], lines: [], circles: [], points: [], constraints: [] };
  for (const s of sel) {
    if (s.kind === "edge") {
      const g = geo.find((x) => x.i === s.geo);
      if (!g) continue;
      out.edges.push(g.i);
      if (g.type === "LineSegment") out.lines.push(g.i);
      if (g.type === "Circle" || g.type === "ArcOfCircle") out.circles.push(g.i);
      if (g.type === "Point") out.points.push({ geo: g.i, pos: 1, p: g.point });
    } else if (s.kind === "vertex") {
      const v = verts.find((x) => x.n === s.n);
      if (v) out.points.push({ geo: v.geo, pos: v.pos, p: v.p });
    } else if (s.kind === "root") out.points.push({ geo: -1, pos: 1, p: [0, 0] });
    else if (s.kind === "hAxis") out.lines.push(-1);
    else if (s.kind === "vAxis") out.lines.push(-2);
    else if (s.kind === "constraint") out.constraints.push(s.i);
  }
  return out;
}

async function askLength(title: string, label: string, value: number, unit = "mm"): Promise<number | null> {
  const text = await prompt(title, label, formatQuantity(value, unit), (t) => {
    try {
      parseQuantity(t);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  if (text === null) return null;
  return parseQuantity(text).value;
}

const add = (...lines: string[]) => lines.map((l) => `ActiveSketch.addConstraint(${l})`);

function lineLength(geo: SketchGeo[], g: number): number {
  const x = geo.find((e) => e.i === g);
  return x && x.type === "LineSegment" ? Math.hypot(x.end[0] - x.start[0], x.end[1] - x.start[1]) : 0;
}

function done(): void {
  useSketch.getState().setSelected([]);
}

function warn(text: string): false {
  log.warning(text);
  return false;
}

export async function constrain(kind: string): Promise<boolean> {
  const r = resolveSelection();
  const { points: P, lines: L, edges: E, circles: C } = r;
  let lines: string[] = [];
  let tx = `Add ${kind.toLowerCase()} constraint`;
  switch (kind) {
    case "Coincident": {
      if (P.length >= 2) lines = add(...P.slice(1).map((p) => constraintPy("Coincident", P[0]!.geo, P[0]!.pos, p.geo, p.pos)));
      else if (P.length === 1 && E.length >= 1) lines = add(...E.map((g) => constraintPy("PointOnObject", P[0]!.geo, P[0]!.pos, g)));
      else return warn("Select two or more vertices, or a vertex and an edge.");
      tx = "Add coincident constraint";
      break;
    }
    case "Horizontal":
    case "Vertical": {
      const own = L.filter((g) => g >= 0);
      if (own.length) lines = add(...own.map((g) => constraintPy(kind, g)));
      else if (P.length === 2) lines = add(constraintPy(kind, P[0]!.geo, P[0]!.pos, P[1]!.geo, P[1]!.pos));
      else return warn(`Select one or more lines, or two vertices, for a ${kind.toLowerCase()} constraint.`);
      break;
    }
    case "Parallel":
    case "Perpendicular":
    case "Tangent": {
      if (E.length < 2 && !(kind !== "Tangent" && L.length >= 2)) return warn(`Select two edges for a ${kind.toLowerCase()} constraint.`);
      const ids = kind === "Tangent" ? E : L;
      lines = add(...ids.slice(1).map((g) => constraintPy(kind, ids[0]!, g)));
      break;
    }
    case "Equal": {
      if (E.length < 2) return warn("Select two or more edges of the same kind for an equality constraint.");
      lines = add(...E.slice(1).map((g) => constraintPy("Equal", E[0]!, g)));
      break;
    }
    case "Distance": {
      if (L.length === 1 && L[0]! >= 0 && P.length === 0) {
        const v = await askLength("Insert length", "Length:", lineLength(r.geo, L[0]!));
        if (v === null) return false;
        lines = add(constraintPy("Distance", L[0]!, v));
      } else if (P.length === 2) {
        const d = Math.hypot(P[1]!.p[0] - P[0]!.p[0], P[1]!.p[1] - P[0]!.p[1]);
        const v = await askLength("Insert length", "Length:", d);
        if (v === null) return false;
        lines = add(constraintPy("Distance", P[0]!.geo, P[0]!.pos, P[1]!.geo, P[1]!.pos, v));
      } else return warn("Select a line, or two vertices, for a distance constraint.");
      break;
    }
    case "DistanceX":
    case "DistanceY": {
      const k = kind === "DistanceX" ? 0 : 1;
      let a: { geo: number; pos: number; p: [number, number] } | undefined;
      let b: { geo: number; pos: number; p: [number, number] } | undefined;
      if (L.length === 1 && L[0]! >= 0 && P.length === 0) {
        const g = r.geo.find((x) => x.i === L[0]) as Extract<SketchGeo, { type: "LineSegment" }>;
        a = { geo: g.i, pos: 1, p: g.start };
        b = { geo: g.i, pos: 2, p: g.end };
      } else if (P.length === 2) [a, b] = [P[0]!, P[1]!];
      else if (P.length === 1) [a, b] = [{ geo: -1, pos: 1, p: [0, 0] }, P[0]!];
      else return warn(`Select a line, or one or two vertices, for a ${kind === "DistanceX" ? "horizontal" : "vertical"} distance.`);
      const v = await askLength(`Insert ${kind === "DistanceX" ? "horizontal" : "vertical"} distance`, "Distance:", b.p[k]! - a.p[k]!);
      if (v === null) return false;
      lines = add(constraintPy(kind, a.geo, a.pos, b.geo, b.pos, v));
      tx = `Add ${kind === "DistanceX" ? "distance X" : "distance Y"} constraint`;
      break;
    }
    case "Radius":
    case "Diameter": {
      if (!C.length) return warn(`Select circles or arcs for a ${kind.toLowerCase()} constraint.`);
      const g = r.geo.find((x) => x.i === C[0]) as Extract<SketchGeo, { type: "Circle" | "ArcOfCircle" }>;
      const v = await askLength(`Change ${kind.toLowerCase()}`, `${kind}:`, kind === "Radius" ? g.radius : 2 * g.radius);
      if (v === null) return false;
      lines = add(...C.map((c) => constraintPy(kind, c, v)));
      break;
    }
    case "Lock": {
      if (!P.length) return warn("Select vertices to lock.");
      lines = add(
        ...P.flatMap((p) => [
          constraintPy("DistanceX", -1, 1, p.geo, p.pos, p.p[0]),
          constraintPy("DistanceY", -1, 1, p.geo, p.pos, p.p[1]),
        ]),
      );
      tx = "Add 'Lock' constraint";
      break;
    }
    case "Block": {
      if (!E.length) return warn("Select edges to block.");
      lines = add(...E.map((g) => constraintPy("Block", g)));
      break;
    }
    default:
      return warn(`${kind} constraints are not available yet.`);
  }
  const ok = await sketchOp(tx, lines);
  if (ok) done();
  return ok;
}

/** Double-click on a dimension: `ActiveSketch.setDatum(i, App.Units.Quantity('12.00 mm'))`. */
export async function editDatum(i: number): Promise<void> {
  const c = useSketch.getState().data?.cons.find((x) => x.i === i);
  if (!c) return;
  const angle = c.type === "Angle";
  const unit = angle ? "deg" : "mm";
  const current = angle ? (c.value * 180) / Math.PI : c.value;
  const v = await askLength("Insert datum", `${c.type}:`, current, unit);
  if (v === null) return;
  await sketchOp("Modify sketch constraints", [`ActiveSketch.setDatum(${i},App.Units.Quantity('${fixed(v)} ${angle ? "deg" : "mm"}'))`]);
}

export async function deleteSketchSelection(): Promise<void> {
  const r = resolveSelection();
  const lines: string[] = [];
  if (r.constraints.length) for (const i of [...r.constraints].sort((a, b) => b - a)) lines.push(`ActiveSketch.delConstraint(${i})`);
  if (r.edges.length) lines.push(`ActiveSketch.delGeometries([${[...r.edges].sort((a, b) => a - b).join(",")}])`);
  if (!lines.length) return;
  await sketchOp("Delete sketch geometry", lines);
  done();
}

export async function toggleConstruction(): Promise<void> {
  const r = resolveSelection();
  if (!r.edges.length) {
    log.warning("Select edges to toggle between normal and construction geometry.");
    return;
  }
  await sketchOp(
    "Toggle draft from/to draft",
    r.edges.map((g) => `ActiveSketch.toggleConstruction(${g})`),
  );
  done();
}

export { pyNum };

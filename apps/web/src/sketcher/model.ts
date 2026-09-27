/**
 * The Sketcher's data as the web UI sees it (read with Python from `SketchObject.Geometry` and
 * `.Constraints`), FreeCAD's element naming in edit mode (`Edge{geo+1}`, `Vertex{n}` over the
 * geometries' points, `RootPoint`, `H_Axis`, `V_Axis`) and the Python the tools run
 * (`ActiveSketch.addGeometry(Part.LineSegment(...))`, `ActiveSketch.addConstraint(Sketcher.Constraint(...))`).
 */
import { pyNum, pyStr } from "../lib/format";

export type Vec2 = [number, number];

export type SketchGeo =
  | { i: number; type: "LineSegment"; construction: boolean; start: Vec2; end: Vec2 }
  | { i: number; type: "Circle"; construction: boolean; center: Vec2; radius: number }
  | { i: number; type: "ArcOfCircle"; construction: boolean; center: Vec2; radius: number; start: Vec2; end: Vec2; a1: number; a2: number }
  | { i: number; type: "Point"; construction: boolean; point: Vec2 }
  | { i: number; type: "Other"; construction: boolean; points: Vec2[]; name: string };

export interface SketchConstraint {
  i: number;
  type: string;
  first: number;
  firstPos: number;
  second: number;
  secondPos: number;
  third: number;
  value: number;
  name: string;
  driving: boolean;
}

export interface SketchData {
  geo: SketchGeo[];
  cons: SketchConstraint[];
  /** Global placement of the sketch: base and quaternion (x, y, z, w). */
  placement: { base: [number, number, number]; q: [number, number, number, number] };
  fully: boolean;
  /** Degrees of freedom from the solver, -1 when unknown. */
  dof: number;
  /** Solver messages: conflicting / redundant constraints. */
  conflicting: number[];
  redundant: number[];
}

/** Point position ids of `Sketcher.Constraint`: none, start, end, mid (centre). */
export const POS = { none: 0, start: 1, end: 2, mid: 3 } as const;

export interface VertexRef {
  /** FreeCAD's `Vertex{n}` index (1-based). */
  n: number;
  geo: number;
  pos: 1 | 2 | 3;
  p: Vec2;
}

/** Every selectable point, numbered the way `SketchObject::getGeoVertexIndex` numbers them. */
export function sketchVertices(geo: SketchGeo[]): VertexRef[] {
  const out: VertexRef[] = [];
  const add = (g: number, pos: 1 | 2 | 3, p: Vec2) => out.push({ n: out.length + 1, geo: g, pos, p });
  for (const g of geo) {
    if (g.type === "Point") add(g.i, 1, g.point);
    else if (g.type === "LineSegment") (add(g.i, 1, g.start), add(g.i, 2, g.end));
    else if (g.type === "Circle") add(g.i, 3, g.center);
    else if (g.type === "ArcOfCircle") (add(g.i, 1, g.start), add(g.i, 2, g.end), add(g.i, 3, g.center));
    else if (g.type === "Other" && g.points.length > 1) (add(g.i, 1, g.points[0]!), add(g.i, 2, g.points[g.points.length - 1]!));
  }
  return out;
}

/** Polyline of a geometry for drawing and picking. */
export function geoPolyline(g: SketchGeo, segments = 64): Vec2[] {
  switch (g.type) {
    case "LineSegment":
      return [g.start, g.end];
    case "Circle": {
      const out: Vec2[] = [];
      for (let k = 0; k <= segments; k++) {
        const a = (2 * Math.PI * k) / segments;
        out.push([g.center[0] + g.radius * Math.cos(a), g.center[1] + g.radius * Math.sin(a)]);
      }
      return out;
    }
    case "ArcOfCircle": {
      const out: Vec2[] = [];
      let a2 = g.a2;
      while (a2 < g.a1) a2 += 2 * Math.PI;
      const n = Math.max(4, Math.ceil((segments * (a2 - g.a1)) / (2 * Math.PI)));
      for (let k = 0; k <= n; k++) {
        const a = g.a1 + ((a2 - g.a1) * k) / n;
        out.push([g.center[0] + g.radius * Math.cos(a), g.center[1] + g.radius * Math.sin(a)]);
      }
      return out;
    }
    case "Point":
      return [g.point];
    case "Other":
      return g.points;
  }
}

// ------------------------------------------------------------------------------ python

const v = (p: Vec2) => `App.Vector(${pyNum(p[0])},${pyNum(p[1])},0)`;

export function lineSegmentPy(a: Vec2, b: Vec2): string {
  return `Part.LineSegment(${v(a)},${v(b)})`;
}

export function circlePy(c: Vec2, r: number): string {
  return `Part.Circle(${v(c)},App.Vector(0,0,1),${pyNum(r)})`;
}

export function arcPy(c: Vec2, r: number, a1: number, a2: number): string {
  return `Part.ArcOfCircle(Part.Circle(${v(c)},App.Vector(0,0,1),${pyNum(r)}),${pyNum(a1)},${pyNum(a2)})`;
}

export function pointPy(p: Vec2): string {
  return `Part.Point(${v(p)})`;
}

export function constraintPy(type: string, ...args: (number | string)[]): string {
  return `Sketcher.Constraint(${[pyStr(type), ...args.map((a) => (typeof a === "number" ? (Number.isInteger(a) ? String(a) : pyNum(a)) : a))].join(", ")})`;
}

/**
 * The lines FreeCAD's rectangle tool writes: four segments, four coincidences, two horizontal and
 * two vertical constraints (`DrawSketchHandlerRectangle`). `first` is the index the first new
 * segment gets.
 */
export function rectanglePy(a: Vec2, b: Vec2, first: number): string[] {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const p: Vec2[] = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
  const g = first;
  return [
    "geoList = []",
    ...p.map((pt, k) => `geoList.append(${lineSegmentPy(pt, p[(k + 1) % 4]!)})`),
    "ActiveSketch.addGeometry(geoList,False)",
    "del geoList",
    "constraintList = []",
    `constraintList.append(${constraintPy("Coincident", g, 2, g + 1, 1)})`,
    `constraintList.append(${constraintPy("Coincident", g + 1, 2, g + 2, 1)})`,
    `constraintList.append(${constraintPy("Coincident", g + 2, 2, g + 3, 1)})`,
    `constraintList.append(${constraintPy("Coincident", g + 3, 2, g, 1)})`,
    `constraintList.append(${constraintPy("Horizontal", g)})`,
    `constraintList.append(${constraintPy("Horizontal", g + 2)})`,
    `constraintList.append(${constraintPy("Vertical", g + 1)})`,
    `constraintList.append(${constraintPy("Vertical", g + 3)})`,
    "ActiveSketch.addConstraint(constraintList)",
    "del constraintList",
  ];
}

/** Python that defines `_fabcad_sketch_json(doc, name)` in `__main__` (once per edit session). */
export const SKETCH_READER_PY = `
import json as _fabcad_json
def _fabcad_sketch_json(docname, name):
    sk = App.getDocument(docname).getObject(name)
    geos = []
    for i, g in enumerate(sk.Geometry):
        t = type(g).__name__
        d = {"i": i, "type": t, "construction": bool(sk.getConstruction(i))}
        if t == "LineSegment":
            d["start"] = [g.StartPoint.x, g.StartPoint.y]
            d["end"] = [g.EndPoint.x, g.EndPoint.y]
        elif t == "Circle":
            d["center"] = [g.Center.x, g.Center.y]
            d["radius"] = g.Radius
        elif t == "ArcOfCircle":
            d["center"] = [g.Center.x, g.Center.y]
            d["radius"] = g.Radius
            d["start"] = [g.StartPoint.x, g.StartPoint.y]
            d["end"] = [g.EndPoint.x, g.EndPoint.y]
            d["a1"] = g.FirstParameter
            d["a2"] = g.LastParameter
        elif t == "GeomPoint" or t == "Point":
            d["type"] = "Point"
            d["point"] = [g.X, g.Y]
        else:
            d["type"] = "Other"
            d["name"] = t
            try:
                d["points"] = [[p.x, p.y] for p in g.toShape().discretize(48)]
            except Exception:
                d["points"] = []
        geos.append(d)
    cons = []
    for i, c in enumerate(sk.Constraints):
        cons.append({"i": i, "type": c.Type, "first": c.First, "firstPos": c.FirstPos, "second": c.Second,
                     "secondPos": c.SecondPos, "third": getattr(c, "Third", -2000), "value": c.Value,
                     "name": c.Name, "driving": bool(c.Driving)})
    try:
        pl = sk.getGlobalPlacement()
    except Exception:
        pl = sk.Placement
    try:
        sk.solve()
        dof = int(getattr(sk, "DoF", -1))
    except Exception:
        dof = -1
    return _fabcad_json.dumps({"geo": geos, "cons": cons,
        "placement": {"base": [pl.Base.x, pl.Base.y, pl.Base.z], "q": list(pl.Rotation.Q)},
        "fully": bool(sk.FullyConstrained), "dof": dof,
        "conflicting": list(getattr(sk, "ConflictingConstraints", []) or []),
        "redundant": list(getattr(sk, "RedundantConstraints", []) or [])})
`;

/** Constraint icon (Sketcher's `Constraint_*.svg`), for badges and the constraint list. */
export function constraintIcon(type: string): string {
  const map: Record<string, string> = {
    Coincident: "Constraint_PointOnPoint",
    Horizontal: "Constraint_Horizontal",
    Vertical: "Constraint_Vertical",
    Parallel: "Constraint_Parallel",
    Perpendicular: "Constraint_Perpendicular",
    Tangent: "Constraint_Tangent",
    Equal: "Constraint_EqualLength",
    Distance: "Constraint_Length",
    DistanceX: "Constraint_HorizontalDistance",
    DistanceY: "Constraint_VerticalDistance",
    Radius: "Constraint_Radius",
    Diameter: "Constraint_Diameter",
    Angle: "Constraint_InternalAngle",
    Symmetric: "Constraint_Symmetric",
    PointOnObject: "Constraint_PointOnObject",
    Block: "Constraint_Block",
    Lock: "Constraint_Lock",
  };
  return map[type] ?? "Constraint_PointOnPoint";
}

export function isDimensional(type: string): boolean {
  return ["Distance", "DistanceX", "DistanceY", "Radius", "Diameter", "Angle"].includes(type);
}

/** Point of a geometry at a position id. */
export function pointOf(geo: SketchGeo[], g: number, pos: number): Vec2 | null {
  if (g === -1) return [0, 0];
  const x = geo.find((e) => e.i === g);
  if (!x) return null;
  if (x.type === "Point") return x.point;
  if (x.type === "LineSegment") return pos === 1 ? x.start : pos === 2 ? x.end : [(x.start[0] + x.end[0]) / 2, (x.start[1] + x.end[1]) / 2];
  if (x.type === "Circle") return x.center;
  if (x.type === "ArcOfCircle") return pos === 1 ? x.start : pos === 2 ? x.end : x.center;
  return x.points[0] ?? null;
}

/** Where a constraint's badge goes (sketch coordinates). */
export function constraintAnchor(geo: SketchGeo[], c: SketchConstraint): Vec2 | null {
  const g = geo.find((e) => e.i === c.first);
  if (!g) return c.first === -1 ? [0, 0] : null;
  if (c.firstPos > 0 && c.second < -2 + 1 && c.type !== "Radius" && c.type !== "Diameter") return pointOf(geo, c.first, c.firstPos);
  if (c.firstPos > 0 && c.second >= 0) {
    const a = pointOf(geo, c.first, c.firstPos);
    const b = pointOf(geo, c.second, c.secondPos || 3);
    if (a && b) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  if (g.type === "LineSegment") return [(g.start[0] + g.end[0]) / 2, (g.start[1] + g.end[1]) / 2];
  if (g.type === "Circle" || g.type === "ArcOfCircle") {
    const a = g.type === "ArcOfCircle" ? (g.a1 + g.a2) / 2 : Math.PI / 4;
    return [g.center[0] + g.radius * Math.cos(a), g.center[1] + g.radius * Math.sin(a)];
  }
  return pointOf(geo, c.first, c.firstPos || 1);
}

/** Snap an angle to horizontal / vertical (FreeCAD's auto constraints) within `tolDeg`. */
export function autoHorVer(a: Vec2, b: Vec2, tolDeg = 3): "Horizontal" | "Vertical" | null {
  const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const m = ((ang % 180) + 180) % 180;
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return null;
  if (m < tolDeg || m > 180 - tolDeg) return "Horizontal";
  if (Math.abs(m - 90) < tolDeg) return "Vertical";
  return null;
}

/** A "nice" grid spacing (1, 2, 5 × 10^n mm) giving about `target` cells over `span`. */
export function gridStep(span: number, target = 20): number {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

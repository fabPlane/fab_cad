/**
 * Screen-space picking of edges and vertices (FreeCAD's `PickRadius`, 5 px by default), and the
 * sub-element names FreeCAD uses: `Face{i+1}`, `Edge{i+1}`, `Vertex{i+1}`.
 */

export const PICK_RADIUS = 5;

/** Distance from point p to segment ab (2D), and the parameter t in [0, 1] of the closest point. */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { d: Math.hypot(px - cx, py - cy), t };
}

/**
 * Projects world points with `project` (world → [screen x, screen y, depth]) and returns the edge
 * closest to (x, y) within `radius` px: its index, the picked world point, and its depth.
 * `edges` are `[firstPoint, count]` pairs into `points` (x, y, z triples), as `Tessellation.edges`.
 */
export function pickEdge(
  points: ArrayLike<number>,
  edges: ArrayLike<number>,
  x: number,
  y: number,
  project: (wx: number, wy: number, wz: number) => [number, number, number],
  radius = PICK_RADIUS,
): { edge: number; point: [number, number, number]; depth: number; distance: number } | null {
  let best: { edge: number; point: [number, number, number]; depth: number; distance: number } | null = null;
  const n = edges.length / 2;
  for (let e = 0; e < n; e++) {
    const first = edges[2 * e]!;
    const count = edges[2 * e + 1]!;
    let prev: [number, number, number] | null = null;
    let prevW: [number, number, number] | null = null;
    for (let k = 0; k < count; k++) {
      const i = (first + k) * 3;
      const w: [number, number, number] = [points[i]!, points[i + 1]!, points[i + 2]!];
      const s = project(w[0], w[1], w[2]);
      if (prev && prevW) {
        const { d, t } = pointSegmentDistance(x, y, prev[0], prev[1], s[0], s[1]);
        if (
          d <= radius &&
          (!best || d < best.distance - 1e-6 || (Math.abs(d - best.distance) < 1e-6 && prev[2] + t * (s[2] - prev[2]) < best.depth))
        ) {
          best = {
            edge: e,
            distance: d,
            depth: prev[2] + t * (s[2] - prev[2]),
            point: [prevW[0] + t * (w[0] - prevW[0]), prevW[1] + t * (w[1] - prevW[1]), prevW[2] + t * (w[2] - prevW[2])],
          };
        }
      }
      prev = s;
      prevW = w;
    }
  }
  return best;
}

/** The vertex closest to (x, y) within `radius` px. `vertices` are x, y, z triples. */
export function pickVertex(
  vertices: ArrayLike<number>,
  x: number,
  y: number,
  project: (wx: number, wy: number, wz: number) => [number, number, number],
  radius = PICK_RADIUS,
): { vertex: number; point: [number, number, number]; depth: number; distance: number } | null {
  let best: { vertex: number; point: [number, number, number]; depth: number; distance: number } | null = null;
  for (let v = 0; v < vertices.length / 3; v++) {
    const w: [number, number, number] = [vertices[3 * v]!, vertices[3 * v + 1]!, vertices[3 * v + 2]!];
    const s = project(w[0], w[1], w[2]);
    const d = Math.hypot(s[0] - x, s[1] - y);
    if (d <= radius && (!best || d < best.distance)) best = { vertex: v, point: w, depth: s[2], distance: d };
  }
  return best;
}

export type SubKind = "Face" | "Edge" | "Vertex";

export function subName(kind: SubKind, index: number): string {
  return `${kind}${index + 1}`;
}

/** `Face3` → `{kind: "Face", index: 2}`. */
export function parseSubName(sub: string): { kind: SubKind; index: number } | null {
  const m = /^(Face|Edge|Vertex)(\d+)$/.exec(sub);
  if (!m) return null;
  return { kind: m[1] as SubKind, index: Number(m[2]) - 1 };
}

/**
 * Which candidate wins, the way FreeCAD's picking favours points over lines over faces: a vertex
 * or an edge within the pick radius wins unless it lies behind the picked face (depth test with a
 * tolerance, since an edge on a face's boundary has the face's depth).
 */
export function chooseCandidate<T extends { depth: number }>(face: T | null, edge: T | null, vertex: T | null, tolerance = 1e-3): T | null {
  const visible = (c: T | null) => c && (!face || c.depth <= face.depth + tolerance);
  if (visible(vertex)) return vertex;
  if (visible(edge)) return edge;
  return face;
}

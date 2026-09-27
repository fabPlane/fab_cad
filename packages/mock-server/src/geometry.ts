/**
 * Real (if simple) tessellations for the mock's primitives, laid out the way FreeCAD's
 * `Tessellate` sends them: one triangle list with per-face ranges, polylines per edge, points per
 * vertex. Face / edge / vertex numbering follows OpenCASCADE's for `BRepPrimAPI_MakeBox`,
 * `MakeCylinder` and `MakeSphere` closely enough that `Face1` of a box is its x = 0 side, as in
 * FreeCAD.
 */
import { Placement, Vector } from "@fab-cad/protocol";

export interface Mesh {
  positions: number[];
  normals: number[];
  indices: number[];
  /** `[firstTriangle, triangleCount]` per face. */
  faces: [number, number][];
  /** `[firstPoint, pointCount]` per edge, into `edgePositions`. */
  edges: [number, number][];
  edgePositions: number[];
  vertices: number[];
}

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

function empty(): Mesh {
  return { positions: [], normals: [], indices: [], faces: [], edges: [], edgePositions: [], vertices: [] };
}

type V3 = [number, number, number];

class Builder {
  readonly m = empty();

  get vertexCount(): number {
    return this.m.positions.length / 3;
  }

  get triangleCount(): number {
    return this.m.indices.length / 3;
  }

  vertex(p: V3, n: V3): number {
    this.m.positions.push(p[0], p[1], p[2]);
    this.m.normals.push(n[0], n[1], n[2]);
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.m.indices.push(a, b, c);
  }

  /** Run `body` and record the triangles it adds as the next face. */
  face(body: () => void): void {
    const first = this.triangleCount;
    body();
    this.m.faces.push([first, this.triangleCount - first]);
  }

  edge(points: V3[]): void {
    const first = this.m.edgePositions.length / 3;
    for (const p of points) this.m.edgePositions.push(p[0], p[1], p[2]);
    this.m.edges.push([first, points.length]);
  }

  point(p: V3): void {
    this.m.vertices.push(p[0], p[1], p[2]);
  }
}

/** A planar quad, corners counter-clockwise seen from outside. */
function quad(b: Builder, corners: [V3, V3, V3, V3], n: V3): void {
  b.face(() => {
    const [i0, i1, i2, i3] = corners.map((c) => b.vertex(c, n)) as [number, number, number, number];
    b.tri(i0, i1, i2);
    b.tri(i0, i2, i3);
  });
}

export function boxMesh(l: number, w: number, h: number): Mesh {
  const b = new Builder();
  const P = (x: number, y: number, z: number): V3 => [x * l, y * w, z * h];
  // Face1..6: x=0, x=L, y=0, y=W, z=0, z=H
  quad(b, [P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)], [-1, 0, 0]);
  quad(b, [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)], [1, 0, 0]);
  quad(b, [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)], [0, -1, 0]);
  quad(b, [P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)], [0, 1, 0]);
  quad(b, [P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)], [0, 0, -1]);
  quad(b, [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)], [0, 0, 1]);
  const edges: [V3, V3][] = [
    [P(0, 0, 0), P(0, 0, 1)],
    [P(0, 0, 1), P(0, 1, 1)],
    [P(0, 1, 0), P(0, 1, 1)],
    [P(0, 0, 0), P(0, 1, 0)],
    [P(1, 0, 0), P(1, 0, 1)],
    [P(1, 0, 1), P(1, 1, 1)],
    [P(1, 1, 0), P(1, 1, 1)],
    [P(1, 0, 0), P(1, 1, 0)],
    [P(0, 0, 0), P(1, 0, 0)],
    [P(0, 0, 1), P(1, 0, 1)],
    [P(0, 1, 0), P(1, 1, 0)],
    [P(0, 1, 1), P(1, 1, 1)],
  ];
  for (const e of edges) b.edge(e);
  for (const v of [P(0, 0, 0), P(0, 0, 1), P(0, 1, 0), P(0, 1, 1), P(1, 0, 0), P(1, 0, 1), P(1, 1, 0), P(1, 1, 1)]) b.point(v);
  return b.m;
}

/** Face1 lateral, Face2 top, Face3 bottom; Edge1 top circle, Edge2 seam, Edge3 bottom circle. */
export function cylinderMesh(r: number, h: number, segments: number): Mesh {
  const b = new Builder();
  const n = Math.max(3, segments);
  const ang = (i: number) => (2 * Math.PI * i) / n;
  const ring = (z: number): V3[] => Array.from({ length: n + 1 }, (_, i) => [r * Math.cos(ang(i)), r * Math.sin(ang(i)), z]);
  const top = ring(h);
  const bottom = ring(0);

  b.face(() => {
    const base = b.vertexCount;
    for (let i = 0; i <= n; i++) {
      const nx = Math.cos(ang(i));
      const ny = Math.sin(ang(i));
      b.vertex(bottom[i]!, [nx, ny, 0]);
      b.vertex(top[i]!, [nx, ny, 0]);
    }
    for (let i = 0; i < n; i++) {
      const b0 = base + 2 * i;
      const t0 = b0 + 1;
      const b1 = b0 + 2;
      const t1 = b0 + 3;
      b.tri(b0, b1, t1);
      b.tri(b0, t1, t0);
    }
  });
  const disc = (pts: V3[], z: number, up: boolean) =>
    b.face(() => {
      const nz: V3 = [0, 0, up ? 1 : -1];
      const c = b.vertex([0, 0, z], nz);
      const first = b.vertexCount;
      for (const p of pts) b.vertex(p, nz);
      for (let i = 0; i < n; i++) up ? b.tri(c, first + i, first + i + 1) : b.tri(c, first + i + 1, first + i);
    });
  disc(top, h, true);
  disc(bottom, 0, false);

  b.edge(top);
  b.edge([
    [r, 0, 0],
    [r, 0, h],
  ]);
  b.edge(bottom);
  b.point([r, 0, h]);
  b.point([r, 0, 0]);
  return b.m;
}

/** One face; Edge1 is the seam meridian; Vertex1/2 the poles. */
export function sphereMesh(r: number, segments: number): Mesh {
  const b = new Builder();
  const nu = Math.max(6, segments);
  const nv = Math.max(3, Math.ceil(nu / 2));
  const point = (i: number, j: number): V3 => {
    const theta = (2 * Math.PI * i) / nu;
    const phi = -Math.PI / 2 + (Math.PI * j) / nv;
    return [r * Math.cos(phi) * Math.cos(theta), r * Math.cos(phi) * Math.sin(theta), r * Math.sin(phi)];
  };
  b.face(() => {
    const base = b.vertexCount;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const p = point(i, j);
        b.vertex(p, [p[0] / r, p[1] / r, p[2] / r]);
      }
    }
    const idx = (i: number, j: number) => base + j * (nu + 1) + i;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = idx(i, j);
        const b1 = idx(i + 1, j);
        const c = idx(i + 1, j + 1);
        const d = idx(i, j + 1);
        if (j !== 0) b.tri(a, b1, c); // skip the degenerate triangle at the south pole
        if (j !== nv - 1) b.tri(a, c, d); // ... and at the north pole
      }
    }
  });
  b.edge(Array.from({ length: nv + 1 }, (_, j) => point(0, j)));
  b.point([0, 0, r]);
  b.point([0, 0, -r]);
  return b.m;
}

/**
 * Segment count for a full circle of radius `r`: enough that the chord error stays under
 * `deflection` and each segment under `angularDeflectionDeg`, like OCC's incremental mesher.
 */
export function circleSegments(r: number, deflection: number, angularDeflectionDeg: number): number {
  const byAngle = Math.ceil(360 / Math.max(1, angularDeflectionDeg));
  let byChord = 3;
  if (deflection > 0 && r > deflection) byChord = Math.ceil(Math.PI / Math.acos(1 - deflection / r));
  return Math.min(128, Math.max(8, byAngle, byChord));
}

/** Map a local mesh into the global frame. */
export function transformMesh(m: Mesh, p: Placement): Mesh {
  const mapPoints = (a: number[]): number[] => {
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i += 3) {
      const v = p.apply(new Vector(a[i]!, a[i + 1]!, a[i + 2]!));
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
    return out;
  };
  const normals = new Array<number>(m.normals.length);
  for (let i = 0; i < m.normals.length; i += 3) {
    const v = p.rotation.apply(new Vector(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!));
    normals[i] = v.x;
    normals[i + 1] = v.y;
    normals[i + 2] = v.z;
  }
  return {
    positions: mapPoints(m.positions),
    normals,
    indices: m.indices,
    faces: m.faces,
    edges: m.edges,
    edgePositions: mapPoints(m.edgePositions),
    vertices: mapPoints(m.vertices),
  };
}

export function boundsOf(points: number[]): BBox | undefined {
  if (points.length < 3) return undefined;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

export function unionBounds(boxes: (BBox | undefined)[]): BBox | undefined {
  const present = boxes.filter((b): b is BBox => !!b);
  if (present.length === 0) return undefined;
  return {
    min: [0, 1, 2].map((k) => Math.min(...present.map((b) => b.min[k]!))) as V3,
    max: [0, 1, 2].map((k) => Math.max(...present.map((b) => b.max[k]!))) as V3,
  };
}

export function diagonal(b: BBox): number {
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

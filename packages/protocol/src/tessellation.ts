/**
 * Typed-array views over a `Tessellate` result.
 *
 * The byte fields are little-endian float32 / uint32 arrays. A `Float32Array` view needs a 4-byte
 * aligned offset, which a CBOR byte string sliced out of a larger reply usually does not have, so
 * the bytes are viewed in place when they can be and copied when they cannot. Every platform
 * this runs on is little-endian; a big-endian host would get byte-swapped copies.
 */
import type { WireTessellation } from "./commands";
import { Placement } from "./values";

export interface Tessellation {
  object: string;
  placement: Placement | null;
  revision: number;
  deflection: number;
  /** x,y,z per vertex, global frame. */
  positions: Float32Array;
  /** Per-vertex normals, when asked for (`decodeTessellation(t, {normals: true})`). */
  normals?: Float32Array;
  /** Three per triangle. */
  indices: Uint32Array;
  /** Flat `[firstTriangle, triangleCount]` pairs; face `i` (`Face{i+1}`) is at `2i`. */
  faces: Uint32Array;
  /** Flat `[firstPoint, pointCount]` pairs into `edgePositions`; edge `i` (`Edge{i+1}`) is at `2i`. */
  edges: Uint32Array;
  edgePositions: Float32Array;
  vertices: Float32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly faceCount: number;
  readonly edgeCount: number;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function view<T extends Float32Array | Uint32Array>(
  bytes: Uint8Array | undefined,
  ctor: { new (b: ArrayBufferLike, o: number, l: number): T; new (n: number): T },
  what: string,
): T {
  if (!bytes || bytes.byteLength === 0) return new ctor(0);
  if (bytes.byteLength % 4 !== 0) throw new Error(`${what}: ${bytes.byteLength} bytes is not a multiple of 4`);
  const n = bytes.byteLength / 4;
  if (LITTLE_ENDIAN && bytes.byteOffset % 4 === 0) return new ctor(bytes.buffer, bytes.byteOffset, n);
  const out = new ctor(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isFloat = out instanceof Float32Array;
  for (let i = 0; i < n; i++) out[i] = isFloat ? dv.getFloat32(i * 4, true) : dv.getUint32(i * 4, true);
  return out;
}

export function float32View(bytes: Uint8Array | undefined, what = "float32 data"): Float32Array {
  return view(bytes, Float32Array, what);
}

export function uint32View(bytes: Uint8Array | undefined, what = "uint32 data"): Uint32Array {
  return view(bytes, Uint32Array, what);
}

function pairs(v: Uint8Array | [number, number][] | undefined, what: string): Uint32Array {
  if (!v) return new Uint32Array(0);
  const out = v instanceof Uint8Array ? uint32View(v, what) : Uint32Array.from(v.flat());
  if (out.length % 2 !== 0) throw new Error(`${what}: odd number of values in a list of pairs`);
  return out;
}

export interface DecodeTessellationOptions {
  /** Compute per-vertex normals (see `computeVertexNormals`). Default false. */
  normals?: boolean;
}

/** Wire tessellation -> typed arrays (zero-copy when aligned). */
export function decodeTessellation(t: WireTessellation, opts: DecodeTessellationOptions = {}): Tessellation {
  const positions = float32View(t.positions, "positions");
  const indices = uint32View(t.indices, "indices");
  const faces = pairs(t.faces, "faces");
  const edges = pairs(t.edges, "edges");
  const out: Tessellation = {
    object: t.object,
    placement: t.placement ? Placement.fromWire(t.placement) : null,
    revision: t.revision,
    deflection: t.deflection ?? 0,
    positions,
    indices,
    faces,
    edges,
    edgePositions: float32View(t.edgePositions, "edgePositions"),
    vertices: float32View(t.vertices, "vertices"),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    faceCount: faces.length / 2,
    edgeCount: edges.length / 2,
  };
  if (opts.normals) out.normals = computeVertexNormals(positions, indices);
  return out;
}

/**
 * Area-weighted vertex normals. The server gives every face its own vertices, so averaging over
 * the triangles sharing a vertex smooths within a face and keeps the creases between faces.
 */
export function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] = n[i]! + nx;
      n[i + 1] = n[i + 1]! + ny;
      n[i + 2] = n[i + 2]! + nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
    if (l > 0) {
      n[i] = n[i]! / l;
      n[i + 1] = n[i + 1]! / l;
      n[i + 2] = n[i + 2]! / l;
    }
  }
  return n;
}

/** The inverse, for servers and tests: typed arrays -> little-endian bytes. */
export function float32Bytes(a: ArrayLike<number>): Uint8Array {
  const f = a instanceof Float32Array ? a : Float32Array.from(a);
  if (LITTLE_ENDIAN) return new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
  const out = new Uint8Array(f.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < f.length; i++) dv.setFloat32(i * 4, f[i]!, true);
  return out;
}

export function uint32Bytes(a: ArrayLike<number>): Uint8Array {
  const u = a instanceof Uint32Array ? a : Uint32Array.from(a);
  if (LITTLE_ENDIAN) return new Uint8Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
  const out = new Uint8Array(u.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < u.length; i++) dv.setUint32(i * 4, u[i]!, true);
  return out;
}

/** Triangle range of face `Face{faceIndex+1}` as `[start, end)` into `indices`. */
export function faceIndexRange(t: Pick<Tessellation, "faces">, faceIndex: number): [number, number] | undefined {
  if (faceIndex < 0 || 2 * faceIndex + 1 >= t.faces.length) return undefined;
  const first = t.faces[2 * faceIndex]!;
  const count = t.faces[2 * faceIndex + 1]!;
  return [first * 3, (first + count) * 3];
}

/** Which face (`0`-based) a triangle belongs to, by binary search over `faces`; `-1` if none. */
export function faceOfTriangle(t: Pick<Tessellation, "faces">, triangle: number): number {
  let lo = 0;
  let hi = t.faces.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const first = t.faces[2 * mid]!;
    const count = t.faces[2 * mid + 1]!;
    if (triangle < first) hi = mid - 1;
    else if (triangle >= first + count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Point range of edge `Edge{edgeIndex+1}` as `[start, end)` into `edgePositions` (floats). */
export function edgePointRange(t: Pick<Tessellation, "edges">, edgeIndex: number): [number, number] | undefined {
  if (edgeIndex < 0 || 2 * edgeIndex + 1 >= t.edges.length) return undefined;
  const first = t.edges[2 * edgeIndex]!;
  const count = t.edges[2 * edgeIndex + 1]!;
  return [first * 3, (first + count) * 3];
}

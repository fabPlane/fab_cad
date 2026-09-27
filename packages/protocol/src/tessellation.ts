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
  placement: Placement;
  revision: number | string;
  /** x,y,z per vertex, global frame. */
  positions: Float32Array;
  normals?: Float32Array;
  /** Three per triangle. */
  indices: Uint32Array;
  /** Per face `[firstTriangle, triangleCount]`; face `i` is `Face{i+1}`. */
  faces: [number, number][];
  /** Per edge `[firstPoint, pointCount]` into `edgePositions`; edge `i` is `Edge{i+1}`. */
  edges: [number, number][];
  edgePositions: Float32Array;
  vertices: Float32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
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

/** Wire tessellation -> typed arrays (zero-copy when aligned). */
export function decodeTessellation(t: WireTessellation): Tessellation {
  const positions = float32View(t.positions, "positions");
  const indices = uint32View(t.indices, "indices");
  const out: Tessellation = {
    object: t.object,
    placement: Placement.fromWire(t.placement),
    revision: t.revision,
    positions,
    indices,
    faces: t.faces ?? [],
    edges: t.edges ?? [],
    edgePositions: float32View(t.edgePositions, "edgePositions"),
    vertices: float32View(t.vertices, "vertices"),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
  if (t.normals && t.normals.byteLength > 0) out.normals = float32View(t.normals, "normals");
  return out;
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

/** Triangle index range of face `Face{i+1}` (for picking / highlighting), as `[start, end)` into `indices`. */
export function faceIndexRange(t: Pick<Tessellation, "faces">, faceIndex: number): [number, number] | undefined {
  const f = t.faces[faceIndex];
  if (!f) return undefined;
  return [f[0] * 3, (f[0] + f[1]) * 3];
}

/** Which face (`0`-based) a triangle belongs to, by binary search over `faces`. */
export function faceOfTriangle(t: Pick<Tessellation, "faces">, triangle: number): number {
  let lo = 0;
  let hi = t.faces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, count] = t.faces[mid]!;
    if (triangle < first) hi = mid - 1;
    else if (triangle >= first + count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

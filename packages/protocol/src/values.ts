/**
 * Property values on the wire (PROTOCOL.md, "Values").
 *
 * Plain JSON carries bool/int/float/str/list/dict as is; FreeCAD's own types travel as tagged
 * objects (`{"$type": "Vector", ...}`) and binary data as a CBOR byte string or, in JSON,
 * `{"$bytes": "<base64>"}`. The envelope codecs in `./envelope` already turn `$bytes` into a
 * `Uint8Array` on the way in (and back on the way out), so everything above them sees the same
 * shape whichever encoding the connection uses.
 *
 * Two layers live here:
 *
 * - `Wire*` interfaces: exactly what the server sends. The command and event types in
 *   `./commands` use these, so a result can be passed straight back into `SetProperties`.
 * - Small classes (`Vector`, `Rotation`, `Placement`, `Quantity`, `Matrix`, `ObjectRef`, `Repr`)
 *   with a little arithmetic, for code that wants to compute with values. `fromWire()` turns a
 *   wire value (recursively) into them and `toWire()` turns them back.
 */

// ------------------------------------------------------------------------------------------ wire

export interface WireVector {
  $type: "Vector";
  x: number;
  y: number;
  z: number;
}

/** `q` is the quaternion `[x, y, z, w]`. A client may send `q` alone, or `axis` + `angle` (degrees). */
export interface WireRotation {
  $type: "Rotation";
  q?: [number, number, number, number];
  axis?: [number, number, number];
  angle?: number;
}

export interface WirePlacement {
  $type: "Placement";
  base: [number, number, number];
  /**
   * Quaternion `[x, y, z, w]`. When sending, a `Rotation` object (`{q}` or `{axis, angle}`) is
   * accepted too, and `rotation` may be left out in favour of top-level `axis` + `angle`.
   */
  rotation: [number, number, number, number];
  /** The rotation as axis + angle (degrees); the server sends both forms. */
  axis?: [number, number, number];
  angle?: number;
}

/** 4x4, row major. */
export interface WireMatrix {
  $type: "Matrix";
  a: number[];
}

export interface WireQuantity {
  $type: "Quantity";
  value: number;
  unit: string;
  /** FreeCAD's user string (`"10 mm"`); informational, ignored when sent. */
  text?: string;
}

export interface WireObjectRef {
  $type: "Object";
  doc: string;
  name: string;
}

/** Anything the server cannot express otherwise. Read only. */
export interface WireRepr {
  $type: "Repr";
  type: string;
  repr: string;
}

export type WireTagged = WireVector | WireRotation | WirePlacement | WireMatrix | WireQuantity | WireObjectRef | WireRepr;

/** A link with sub-elements, as Python gives it: `[object, ["Face1", "Edge2"]]`. */
export type WireLinkSub = [WireObjectRef, string[]];

/** Any property value as it travels (after `$bytes` decoding). */
export type WireValue = null | boolean | number | string | Uint8Array | WireTagged | WireValue[] | { [key: string]: WireValue };

/**
 * What `SetProperties` / `AddObject` accept: a wire value, or for a quantity a plain number (in the
 * property's unit) or a string FreeCAD parses (`"25.4 mm"`). Class instances from this module are
 * accepted too; the client runs `toWire()` over the values before sending.
 */
export type PropertyInput = WireValue | ValueClass | PropertyInput[] | { [key: string]: PropertyInput };

export const VALUE_TYPES = ["Vector", "Rotation", "Placement", "Matrix", "Quantity", "Object", "Repr"] as const;
export type ValueTypeName = (typeof VALUE_TYPES)[number];

export function isTagged(v: unknown): v is WireTagged {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { $type?: unknown }).$type === "string";
}

export function isTaggedAs<T extends WireTagged["$type"]>(v: unknown, type: T): v is Extract<WireTagged, { $type: T }> {
  return isTagged(v) && v.$type === type;
}

// -------------------------------------------------------------------------------------- classes

export class Vector {
  constructor(
    readonly x = 0,
    readonly y = 0,
    readonly z = 0,
  ) {}

  static fromWire(w: WireVector): Vector {
    return new Vector(w.x, w.y, w.z);
  }

  static fromArray(a: readonly number[]): Vector {
    return new Vector(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  }

  toWire(): WireVector {
    return { $type: "Vector", x: this.x, y: this.y, z: this.z };
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  add(o: Vector): Vector {
    return new Vector(this.x + o.x, this.y + o.y, this.z + o.z);
  }

  sub(o: Vector): Vector {
    return new Vector(this.x - o.x, this.y - o.y, this.z - o.z);
  }

  scale(s: number): Vector {
    return new Vector(this.x * s, this.y * s, this.z * s);
  }

  dot(o: Vector): number {
    return this.x * o.x + this.y * o.y + this.z * o.z;
  }

  cross(o: Vector): Vector {
    return new Vector(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x);
  }

  get length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  normalize(): Vector {
    const l = this.length;
    return l > 0 ? this.scale(1 / l) : this;
  }

  equals(o: Vector, eps = 1e-9): boolean {
    return Math.abs(this.x - o.x) <= eps && Math.abs(this.y - o.y) <= eps && Math.abs(this.z - o.z) <= eps;
  }
}

/** A unit quaternion `(x, y, z, w)`, FreeCAD's `Base.Rotation`. */
export class Rotation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;

  constructor(x = 0, y = 0, z = 0, w = 1) {
    const n = Math.hypot(x, y, z, w) || 1;
    this.x = x / n;
    this.y = y / n;
    this.z = z / n;
    this.w = w / n;
  }

  static identity(): Rotation {
    return new Rotation();
  }

  static fromQuaternion(q: readonly number[]): Rotation {
    return new Rotation(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1);
  }

  /** `angleDeg` about `axis` (need not be normalised). */
  static fromAxisAngle(axis: readonly number[], angleDeg: number): Rotation {
    const a = Vector.fromArray(axis).normalize();
    if (a.length === 0) return new Rotation();
    const half = (angleDeg * Math.PI) / 360;
    const s = Math.sin(half);
    return new Rotation(a.x * s, a.y * s, a.z * s, Math.cos(half));
  }

  static fromWire(w: WireRotation): Rotation {
    if (w.q) return Rotation.fromQuaternion(w.q);
    if (w.axis && w.angle !== undefined) return Rotation.fromAxisAngle(w.axis, w.angle);
    return new Rotation();
  }

  get q(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }

  /** Rotation angle in degrees, in [0, 360). */
  get angle(): number {
    const w = Math.min(1, Math.max(-1, this.w));
    return (2 * Math.acos(w) * 180) / Math.PI;
  }

  /** Rotation axis; `(0, 0, 1)` for the identity, like FreeCAD. */
  get axis(): [number, number, number] {
    const s = Math.sqrt(Math.max(0, 1 - this.w * this.w));
    if (s < 1e-12) return [0, 0, 1];
    return [this.x / s, this.y / s, this.z / s];
  }

  toWire(): WireRotation {
    return { $type: "Rotation", q: this.q, axis: this.axis, angle: this.angle };
  }

  /** `this * o`: apply `o` first, then `this`. */
  multiply(o: Rotation): Rotation {
    return new Rotation(
      this.w * o.x + this.x * o.w + this.y * o.z - this.z * o.y,
      this.w * o.y - this.x * o.z + this.y * o.w + this.z * o.x,
      this.w * o.z + this.x * o.y - this.y * o.x + this.z * o.w,
      this.w * o.w - this.x * o.x - this.y * o.y - this.z * o.z,
    );
  }

  inverse(): Rotation {
    return new Rotation(-this.x, -this.y, -this.z, this.w);
  }

  apply(v: Vector): Vector {
    const [x, y, z] = [v.x, v.y, v.z];
    const { x: qx, y: qy, z: qz, w: qw } = this;
    // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    return new Vector(x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx));
  }
}

export class Placement {
  constructor(
    readonly base: Vector = new Vector(),
    readonly rotation: Rotation = new Rotation(),
  ) {}

  static identity(): Placement {
    return new Placement();
  }

  static fromWire(w: WirePlacement): Placement {
    const r = w.rotation as unknown;
    let rotation: Rotation;
    if (Array.isArray(r)) rotation = Rotation.fromQuaternion(r as number[]);
    else if (isTaggedAs(r, "Rotation") || (typeof r === "object" && r !== null)) rotation = Rotation.fromWire(r as WireRotation);
    else if (w.axis && w.angle !== undefined) rotation = Rotation.fromAxisAngle(w.axis, w.angle);
    else rotation = new Rotation();
    return new Placement(Vector.fromArray(w.base ?? [0, 0, 0]), rotation);
  }

  toWire(): WirePlacement {
    return {
      $type: "Placement",
      base: this.base.toArray(),
      rotation: this.rotation.q,
      axis: this.rotation.axis,
      angle: this.rotation.angle,
    };
  }

  /** Maps a point from the local frame to the parent frame. */
  apply(v: Vector): Vector {
    return this.rotation.apply(v).add(this.base);
  }

  /** `this * o`: `o` first, then `this` (FreeCAD's `Placement.multiply`). */
  multiply(o: Placement): Placement {
    return new Placement(this.apply(o.base), this.rotation.multiply(o.rotation));
  }

  inverse(): Placement {
    const r = this.rotation.inverse();
    return new Placement(r.apply(this.base).scale(-1), r);
  }

  /** Row-major 4x4. */
  toMatrix(): Matrix {
    const { x, y, z, w } = this.rotation;
    const b = this.base;
    return new Matrix([
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      b.x,
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      b.y,
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
      b.z,
      0,
      0,
      0,
      1,
    ]);
  }
}

export class Matrix {
  readonly a: readonly number[];

  constructor(a?: readonly number[]) {
    this.a = a && a.length === 16 ? [...a] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  static fromWire(w: WireMatrix): Matrix {
    return new Matrix(w.a);
  }

  toWire(): WireMatrix {
    return { $type: "Matrix", a: [...this.a] };
  }

  /** Row-major element `(row, col)`. */
  at(row: number, col: number): number {
    return this.a[row * 4 + col]!;
  }

  /** Column-major copy, what WebGL / three.js `Matrix4.fromArray` expect. */
  toColumnMajor(): Float32Array {
    const out = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = this.at(r, c);
    return out;
  }
}

export class Quantity {
  constructor(
    readonly value: number,
    readonly unit: string = "",
    readonly text: string = formatQuantity(value, unit),
  ) {}

  static fromWire(w: WireQuantity): Quantity {
    return new Quantity(w.value, w.unit, w.text ?? formatQuantity(w.value, w.unit));
  }

  toWire(): WireQuantity {
    return { $type: "Quantity", value: this.value, unit: this.unit, text: this.text };
  }

  toString(): string {
    return this.text;
  }
}

/** FreeCAD-like user string: `10 mm`, `90 °` (FreeCAD's angle unit string is `deg`). */
export function formatQuantity(value: number, unit: string): string {
  const v = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
  if (!unit) return v;
  return unit === "deg" || unit === "°" ? `${v} °` : `${v} ${unit}`;
}

export class ObjectRef {
  constructor(
    readonly doc: string,
    readonly name: string,
  ) {}

  static fromWire(w: WireObjectRef): ObjectRef {
    return new ObjectRef(w.doc, w.name);
  }

  toWire(): WireObjectRef {
    return { $type: "Object", doc: this.doc, name: this.name };
  }

  toString(): string {
    return `${this.doc}#${this.name}`;
  }
}

export class Repr {
  constructor(
    readonly type: string,
    readonly repr: string,
  ) {}

  static fromWire(w: WireRepr): Repr {
    return new Repr(w.type, w.repr);
  }

  toWire(): WireRepr {
    return { $type: "Repr", type: this.type, repr: this.repr };
  }
}

export type ValueClass = Vector | Rotation | Placement | Matrix | Quantity | ObjectRef | Repr;

/** Any value after `fromWire()`: tagged forms become class instances. */
export type Value = null | boolean | number | string | Uint8Array | ValueClass | Value[] | { [key: string]: Value };

function isValueClass(v: unknown): v is ValueClass {
  return (
    v instanceof Vector ||
    v instanceof Rotation ||
    v instanceof Placement ||
    v instanceof Matrix ||
    v instanceof Quantity ||
    v instanceof ObjectRef ||
    v instanceof Repr
  );
}

/** Recursively turn tagged wire forms into the classes above. Unknown `$type`s are left alone. */
export function fromWire(v: WireValue): Value {
  if (v === null || typeof v !== "object" || v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(fromWire);
  if (isTagged(v)) {
    switch (v.$type) {
      case "Vector":
        return Vector.fromWire(v);
      case "Rotation":
        return Rotation.fromWire(v);
      case "Placement":
        return Placement.fromWire(v);
      case "Matrix":
        return Matrix.fromWire(v);
      case "Quantity":
        return Quantity.fromWire(v);
      case "Object":
        return ObjectRef.fromWire(v);
      case "Repr":
        return Repr.fromWire(v);
    }
    return v as unknown as Value;
  }
  const out: { [key: string]: Value } = {};
  for (const [k, x] of Object.entries(v)) out[k] = fromWire(x as WireValue);
  return out;
}

/** Recursively turn class instances back into wire forms. Wire values pass through unchanged. */
export function toWire(v: PropertyInput): WireValue {
  if (v === null || typeof v !== "object" || v instanceof Uint8Array) return v;
  if (isValueClass(v)) return v.toWire();
  if (Array.isArray(v)) return v.map(toWire);
  if (isTagged(v)) return v;
  const out: { [key: string]: WireValue } = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toWire(x as PropertyInput);
  return out;
}

// --------------------------------------------------------------------------------- constructors

export const vec = (x = 0, y = 0, z = 0): WireVector => ({ $type: "Vector", x, y, z });
export const quantity = (value: number, unit: string): WireQuantity => ({
  $type: "Quantity",
  value,
  unit,
  text: formatQuantity(value, unit),
});
export const objectRef = (doc: string, name: string): WireObjectRef => ({ $type: "Object", doc, name });
export const placement = (
  base: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
): WirePlacement => ({
  $type: "Placement",
  base,
  rotation,
});

// ------------------------------------------------------------------------------------- base64

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // base64url, accepted on input
  t["_".charCodeAt(0)] = 63;
  return t;
})();

/** Standard base64 with padding. Works the same in the browser, Bun and workers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  let i = 0;
  const chunk: string[] = [];
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk.push(B64[v >> 18]!, B64[(v >> 12) & 63]!, B64[(v >> 6) & 63]!, B64[v & 63]!);
    if (chunk.length >= 8192) {
      out += chunk.join("");
      chunk.length = 0;
    }
  }
  out += chunk.join("");
  if (i < n) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < n ? bytes[i + 1]! : 0;
    const v = (b0 << 16) | (b1 << 8);
    out += B64[v >> 18]! + B64[(v >> 12) & 63]! + (i + 1 < n ? B64[(v >> 6) & 63]! : "=") + "=";
  }
  return out;
}

/** Decodes standard or URL-safe base64, padded or not; whitespace is ignored. */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)]!;
    if (v < 0) throw new Error(`invalid base64 character '${clean[i]}' at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/**
 * A small quantity parser for the units a UI (and the mock server) meets most: lengths and
 * angles. FreeCAD's own parser is far richer; the server stays the authority, this is for input
 * validation and for the mock.
 */

export type Dimension = "length" | "angle" | "none";

interface UnitDef {
  dimension: Dimension;
  /** Factor to the base unit (mm, degree). */
  factor: number;
}

const UNITS: Record<string, UnitDef> = {
  nm: { dimension: "length", factor: 1e-6 },
  um: { dimension: "length", factor: 1e-3 },
  µm: { dimension: "length", factor: 1e-3 },
  mm: { dimension: "length", factor: 1 },
  cm: { dimension: "length", factor: 10 },
  dm: { dimension: "length", factor: 100 },
  m: { dimension: "length", factor: 1000 },
  km: { dimension: "length", factor: 1e6 },
  in: { dimension: "length", factor: 25.4 },
  '"': { dimension: "length", factor: 25.4 },
  thou: { dimension: "length", factor: 0.0254 },
  mil: { dimension: "length", factor: 0.0254 },
  ft: { dimension: "length", factor: 304.8 },
  "'": { dimension: "length", factor: 304.8 },
  yd: { dimension: "length", factor: 914.4 },
  "°": { dimension: "angle", factor: 1 },
  deg: { dimension: "angle", factor: 1 },
  rad: { dimension: "angle", factor: 180 / Math.PI },
  gon: { dimension: "angle", factor: 0.9 },
};

/** The base unit of each dimension, as FreeCAD writes it. */
export const BASE_UNIT: Record<Dimension, string> = { length: "mm", angle: "°", none: "" };

export function unitDimension(unit: string): Dimension {
  return UNITS[unit]?.dimension ?? "none";
}

export interface ParsedQuantity {
  /** Value in the base unit of its dimension (mm, degrees). */
  value: number;
  dimension: Dimension;
  /** Base unit (`mm`, `°`) or `""` for a plain number. */
  unit: string;
}

/**
 * `"25.4 mm"`, `"1in"`, `"90 °"`, `"1.5 rad"`, `"3"`, `"1 ft 2 in"` (sums of terms of one
 * dimension). Throws on anything else.
 */
export function parseQuantity(text: string): ParsedQuantity {
  const s = text.trim().replace(/,/g, ".");
  if (!s) throw new Error("empty quantity");
  const re = /\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(µm|um|nm|mm|cm|dm|km|m|in|thou|mil|ft|yd|deg|rad|gon|°|"|')?/y;
  let pos = 0;
  let total = 0;
  let dimension: Dimension | undefined;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m || m[0].length === 0) throw new Error(`cannot parse quantity "${text}"`);
    pos = re.lastIndex;
    const unit = m[2];
    const def = unit ? UNITS[unit]! : undefined;
    const dim = def?.dimension ?? "none";
    if (dimension !== undefined && dim !== dimension && dim !== "none") throw new Error(`mixed units in "${text}"`);
    if (dimension === undefined || dimension === "none") dimension = dim;
    total += Number(m[1]) * (def?.factor ?? 1);
  }
  const d = dimension ?? "none";
  return { value: total, dimension: d, unit: BASE_UNIT[d] };
}

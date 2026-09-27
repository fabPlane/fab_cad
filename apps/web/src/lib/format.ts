/**
 * FreeCAD's user-facing number formatting: the "Standard (mm, kg, s, degree)" unit schema with
 * two decimals (FreeCAD's default `Decimals` preference), and the helpers the property editor and
 * the Python console echo need.
 */

/** FreeCAD's default number of decimals (Preferences > General > Units). */
export const DECIMALS = 2;

/** `10` → `10.00`, `-0.001` → `0.00` (never `-0.00`). */
export function fixed(n: number, decimals = DECIMALS): string {
  const s = n.toFixed(decimals);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

/** The unit as FreeCAD's user string writes it: `deg` → `°`. */
export function userUnit(unit: string): string {
  return unit === "deg" ? "°" : unit;
}

/** `10.00 mm`, `90.00 °`, `3.00` (no unit). */
export function formatQuantity(value: number, unit: string, decimals = DECIMALS): string {
  const u = userUnit(unit);
  return u ? `${fixed(value, decimals)} ${u}` : fixed(value, decimals);
}

/** A plain float the way FreeCAD's float spin box shows it. */
export function formatFloat(n: number, decimals = DECIMALS): string {
  return fixed(n, decimals);
}

/**
 * FreeCAD's property editor name: camel case split with spaces (`ShapeColor` → `Shape Color`,
 * `AttachmentSupport` → `Attachment Support`), after `PropertyItem::setPropertyName`.
 */
export function splitCamelCase(name: string): string {
  let out = "";
  for (const ch of name) {
    if (ch >= "A" && ch <= "Z" && out.length > 0) {
      const last = out[out.length - 1]!;
      if (last >= "a" && last <= "z") out += " ";
    }
    out += ch;
  }
  return out;
}

/** A Python string literal in single quotes, as FreeCAD's echo writes names. */
export function pyStr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

/** A Python float literal (FreeCAD echoes floats like `10.0`). */
export function pyNum(n: number): string {
  if (!Number.isFinite(n)) return "0.0";
  if (Number.isInteger(n)) return `${n}.0`;
  return String(Number(n.toPrecision(12)));
}

export function pyBool(b: boolean): string {
  return b ? "True" : "False";
}

/** `(x, y, z)` in the schema's length unit, as the status bar prints a point. */
export function formatPoint(p: readonly [number, number, number], decimals = DECIMALS): string {
  return `(${p.map((v) => `${fixed(Math.abs(v) < 1e-7 ? 0 : v, decimals)} mm`).join(", ")})`;
}

/** A packed FreeCAD colour (`0xRRGGBBAA`) as CSS. */
export function packedToCss(packed: number): string {
  const r = (packed >>> 24) & 0xff;
  const g = (packed >>> 16) & 0xff;
  const b = (packed >>> 8) & 0xff;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb` → `(r, g, b)` floats, the way FreeCAD shows colour properties. */
export function cssToTuple(css: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(css);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

export function tupleToCss(t: readonly number[]): string {
  return `#${t
    .slice(0, 3)
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The value column of a colour property: `[204, 204, 204]`. */
export function formatColor(css: string): string {
  const t = cssToTuple(css);
  return `[${t.map((v) => Math.round(v * 255)).join(", ")}]`;
}

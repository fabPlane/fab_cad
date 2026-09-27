/**
 * The property view's model, independent of React: which editor a FreeCAD property type gets,
 * how its value reads in the value column, how typed text becomes a wire value, the Python line
 * FreeCAD's property editor would run for the edit (echoed to the console), how rows are grouped,
 * and the sub-rows of placements and vectors.
 *
 * Follows `src/Gui/propertyeditor/PropertyItem.cpp` and `PropertyModel.cpp`.
 */
import {
  Placement,
  Rotation,
  Vector,
  isTaggedAs,
  parseQuantity,
  unitDimension,
  type PropertyInfo,
  type PropertyInput,
  type WireObjectRef,
  type WirePlacement,
  type WireValue,
} from "@fab-cad/protocol";
import { fixed, formatQuantity, pyBool, pyNum, pyStr } from "../lib/format";

export type PropertyKind =
  | "quantity"
  | "float"
  | "int"
  | "bool"
  | "enum"
  | "string"
  | "file"
  | "placement"
  | "vector"
  | "vectorDistance"
  | "rotation"
  | "link"
  | "linkSub"
  | "linkList"
  | "linkSubList"
  | "color"
  | "stringList"
  | "numberList"
  | "map"
  | "none";

const QUANTITY_TYPES =
  /^App::Property(Length|Distance|Angle|Quantity|QuantityConstraint|Area|Volume|Speed|Acceleration|Force|Pressure|Frequency|Mass|Time|ElectricPotential|Temperature)/;

/** Types FreeCAD's property editor has no editor for (not shown unless "Show hidden"). */
const NO_EDITOR = new Set([
  "Part::PropertyPartShape",
  "App::PropertyExpressionEngine",
  "Materials::PropertyMaterial",
  "Part::PropertyGeometryList",
  "Part::PropertyShapeHistory",
  "Part::PropertyFilletEdges",
  "App::PropertyPythonObject",
  "App::PropertyLinkListHidden",
  "App::PropertyLinkHidden",
  "App::PropertyLinkSubHidden",
  "App::PropertyLinkSubListHidden",
  "App::PropertyXLinkSubHidden",
  "App::PropertyMaterialList",
  "App::PropertyColorList",
  "App::PropertyBoolList",
  "App::PropertyVectorList",
  "App::PropertyPlacementList",
  "App::PropertyFileIncluded",
]);

export function propertyKind(p: Pick<PropertyInfo, "type" | "value" | "enum" | "unit">): PropertyKind {
  const t = p.type;
  if (NO_EDITOR.has(t)) return "none";
  if (t === "Sketcher::PropertyConstraintList") return "none";
  if (QUANTITY_TYPES.test(t) || isTaggedAs(p.value, "Quantity")) return "quantity";
  if (t === "App::PropertyBool") return "bool";
  if (t === "App::PropertyEnumeration" || p.enum) return "enum";
  if (/^App::Property(Integer|IntegerConstraint|Percent)$/.test(t)) return "int";
  if (/^App::Property(Float|FloatConstraint|Precision)$/.test(t)) return "float";
  if (t === "App::PropertyPlacement" || t === "App::PropertyPlacementLink") return "placement";
  if (t === "App::PropertyVectorDistance" || t === "App::PropertyPosition") return "vectorDistance";
  if (/^App::Property(Vector|Direction)$/.test(t)) return "vector";
  if (t === "App::PropertyRotation") return "rotation";
  if (/^App::Property(Link|LinkChild|LinkGlobal|XLink)$/.test(t)) return "link";
  if (/^App::Property(LinkSub|LinkSubChild|LinkSubGlobal|XLinkSub)$/.test(t)) return "linkSub";
  if (/^App::Property(LinkList|LinkListChild|LinkListGlobal|XLinkList)$/.test(t)) return "linkList";
  if (/^App::Property(LinkSubList|LinkSubListChild|LinkSubListGlobal|XLinkSubList)$/.test(t)) return "linkSubList";
  if (t === "App::PropertyColor" || t === "App::PropertyMaterial") return "color";
  if (t === "App::PropertyStringList") return "stringList";
  if (/^App::Property(FloatList|IntegerList|IntegerSet)$/.test(t)) return "numberList";
  if (t === "App::PropertyMap") return "map";
  if (/^App::Property(File|Path)$/.test(t)) return "file";
  if (/^App::Property(String|Font|UUID)$/.test(t)) return "string";
  if (typeof p.value === "string") return "string";
  if (typeof p.value === "boolean") return "bool";
  if (typeof p.value === "number") return Number.isInteger(p.value) ? "int" : "float";
  return "none";
}

export function isReadOnly(p: Pick<PropertyInfo, "status">): boolean {
  return p.status.includes("ReadOnly");
}

export function isHidden(p: Pick<PropertyInfo, "status" | "type" | "value" | "enum" | "unit">): boolean {
  return p.status.includes("Hidden") || propertyKind(p) === "none";
}

// ------------------------------------------------------------------------------- display

export type LabelOf = (name: string) => string;

function refName(v: unknown): string | null {
  return isTaggedAs(v, "Object") ? (v as WireObjectRef).name : null;
}

function linkSubText(v: WireValue, labelOf: LabelOf): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v) && v.length === 2 && isTaggedAs(v[0], "Object")) {
    const name = labelOf((v[0] as WireObjectRef).name);
    const subs = Array.isArray(v[1]) ? (v[1] as string[]).filter((s) => s) : typeof v[1] === "string" && v[1] ? [v[1]] : [];
    return subs.length ? `${name} (${subs.join(", ")})` : name;
  }
  const n = refName(v);
  return n ? labelOf(n) : "";
}

export function quantityOf(v: WireValue, unit?: string): { value: number; unit: string } {
  if (isTaggedAs(v, "Quantity")) return { value: v.value, unit: v.unit || unit || "" };
  if (typeof v === "number") return { value: v, unit: unit ?? "" };
  return { value: 0, unit: unit ?? "" };
}

export function vectorOf(v: WireValue): [number, number, number] {
  if (isTaggedAs(v, "Vector")) return [v.x, v.y, v.z];
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number")) return v as [number, number, number];
  return [0, 0, 0];
}

export function placementOf(v: WireValue): Placement {
  return isTaggedAs(v, "Placement") ? Placement.fromWire(v as WirePlacement) : Placement.identity();
}

/** Axis and angle the way FreeCAD reports them (identity: axis z, angle 0). */
export function axisAngle(p: Placement): { axis: [number, number, number]; angle: number } {
  const angle = p.rotation.angle;
  if (angle < 1e-9) return { axis: [0, 0, 1], angle: 0 };
  return { axis: p.rotation.axis, angle };
}

/** The value column text (`PropertyItem::toString` per type). */
export function displayValue(p: PropertyInfo, labelOf: LabelOf = (n) => n): string {
  const kind = propertyKind(p);
  const v = p.value;
  switch (kind) {
    case "quantity": {
      const q = quantityOf(v, p.unit);
      return formatQuantity(q.value, q.unit);
    }
    case "float":
      return typeof v === "number" ? fixed(v) : String(v ?? "");
    case "int":
      return typeof v === "number" ? String(Math.round(v)) : String(v ?? "");
    case "bool":
      return v ? "true" : "false";
    case "enum":
    case "string":
    case "file":
      return typeof v === "string" ? v : String(v ?? "");
    case "placement": {
      const pl = placementOf(v);
      const { axis, angle } = axisAngle(pl);
      const b = pl.base;
      return `[(${axis.map((x) => fixed(x)).join(" ")}); ${formatQuantity(angle, "deg")}; (${[b.x, b.y, b.z].map((x) => formatQuantity(x, "mm")).join("  ")})]`;
    }
    case "vector":
      return `[${vectorOf(v)
        .map((x) => fixed(x))
        .join(" ")}]`;
    case "vectorDistance":
      return `[${vectorOf(v)
        .map((x) => formatQuantity(x, "mm"))
        .join("  ")}]`;
    case "rotation": {
      if (!isTaggedAs(v, "Rotation")) return "";
      const r = Rotation.fromWire(v);
      return `[(${r.axis.map((x) => fixed(x)).join(" ")}); ${formatQuantity(r.angle, "deg")}]`;
    }
    case "link": {
      const n = refName(v);
      return n ? labelOf(n) : "";
    }
    case "linkSub":
      return linkSubText(v, labelOf);
    case "linkList":
    case "linkSubList":
      return Array.isArray(v)
        ? `[${v.map((x) => (kind === "linkList" ? labelOf(refName(x) ?? "") : linkSubText(x, labelOf))).join(", ")}]`
        : "";
    case "color":
      return Array.isArray(v) ? `[${(v as number[]).map((x) => Math.round(x * 255)).join(", ")}]` : String(v ?? "");
    case "stringList":
    case "numberList":
      return Array.isArray(v) ? `[${v.map((x) => String(x)).join(", ")}]` : "";
    case "map":
      return v && typeof v === "object" ? `{${Object.entries(v as Record<string, unknown>).length} entries}` : "";
    case "none":
      if (isTaggedAs(v, "Repr")) return v.repr;
      return v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

// ------------------------------------------------------------------------------- parsing

export type ParseResult = { ok: true; value: PropertyInput; python: string } | { ok: false; error: string };

/**
 * Text typed into a quantity editor → the wire value to send and the Python literal FreeCAD's
 * editor would assign (`'25.40 mm'`). Accepts what `parseQuantity` understands (`10`, `10 mm`,
 * `1 in`, `1 ft 2 in`, `90 °`, `1.5 rad`); a bare number takes the property's unit.
 */
export function parseQuantityInput(text: string, unit: string): ParseResult {
  const t = text.trim();
  if (!t) return { ok: false, error: "empty" };
  let parsed;
  try {
    parsed = parseQuantity(t);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const want = unitDimension(unit);
  if (parsed.dimension !== "none" && want !== "none" && parsed.dimension !== want) {
    return { ok: false, error: `wrong unit: expected ${unit}` };
  }
  const u = parsed.dimension === "none" ? unit : parsed.unit;
  return {
    ok: true,
    value: { $type: "Quantity", value: parsed.value, unit: u },
    python: pyStr(formatQuantity(parsed.value, u)),
  };
}

export function parseFloatInput(text: string): ParseResult {
  const n = Number(text.trim().replace(",", "."));
  if (!text.trim() || !Number.isFinite(n)) return { ok: false, error: "not a number" };
  return { ok: true, value: n, python: pyNum(n) };
}

export function parseIntInput(text: string): ParseResult {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return { ok: false, error: "not an integer" };
  const n = parseInt(t, 10);
  return { ok: true, value: n, python: String(n) };
}

/** Parse the text an editor produced for a property of this kind. */
export function parseInput(p: Pick<PropertyInfo, "type" | "value" | "enum" | "unit">, text: string): ParseResult {
  const kind = propertyKind(p);
  switch (kind) {
    case "quantity":
      return parseQuantityInput(text, p.unit ?? quantityOf(p.value, p.unit).unit);
    case "float":
      return parseFloatInput(text);
    case "int":
      return parseIntInput(text);
    case "bool": {
      const b = /^(true|1|yes|on)$/i.test(text.trim());
      return { ok: true, value: b, python: pyBool(b) };
    }
    case "enum": {
      if (p.enum && !p.enum.includes(text)) return { ok: false, error: `not one of ${p.enum.join(", ")}` };
      return { ok: true, value: text, python: pyStr(text) };
    }
    case "string":
    case "file":
      return { ok: true, value: text, python: pyStr(text) };
    default:
      return { ok: false, error: "no text editor for this property" };
  }
}

// ------------------------------------------------------------------------------- python echo

/** `FreeCAD.getDocument('Unnamed').getObject('Box').` — the target prefix of an edit. */
export function objectPath(doc: string, object: string): string {
  return `FreeCAD.getDocument(${pyStr(doc)}).getObject(${pyStr(object)})`;
}

/** The line FreeCAD's `PropertyItem::setPropertyValue` runs. */
export function assignmentEcho(doc: string, object: string, prop: string, python: string): string {
  return `${objectPath(doc, object)}.${prop} = ${python}`;
}

export function placementPython(p: Placement): string {
  const { axis, angle } = axisAngle(p);
  const b = p.base;
  return `App.Placement(App.Vector(${[b.x, b.y, b.z].map((x) => fixed(x)).join(",")}),App.Rotation(App.Vector(${axis
    .map((x) => fixed(x))
    .join(",")}),${fixed(angle)}))`;
}

export function vectorPython(v: readonly number[]): string {
  return `(${v.map((x) => fixed(x)).join(", ")})`;
}

export function placementWire(base: readonly number[], axis: readonly number[], angle: number): WirePlacement {
  return new Placement(Vector.fromArray(base), Rotation.fromAxisAngle(axis, angle)).toWire();
}

// ------------------------------------------------------------------------------- sub-rows

export interface SubRow {
  /** Path below the property (`Base.x`, `Rotation.Angle`), what `SetExpression` binds. */
  path: string;
  label: string;
  kind: "quantity" | "float" | "vector" | "vectorDistance";
  display: string;
  /** Numeric value (quantity: base unit). */
  value: number | [number, number, number];
  unit?: string;
  children?: SubRow[];
}

/** FreeCAD's expandable children: Placement → Angle, Axis (x, y, z), Position (x, y, z). */
export function subRows(p: PropertyInfo): SubRow[] {
  const kind = propertyKind(p);
  const mkVec = (base: string, v: [number, number, number], unit: string | undefined): SubRow[] =>
    (["x", "y", "z"] as const).map((c, i) => ({
      path: `${base}.${c}`,
      label: c,
      kind: unit ? ("quantity" as const) : ("float" as const),
      display: unit ? formatQuantity(v[i]!, unit) : fixed(v[i]!),
      value: v[i]!,
      ...(unit ? { unit } : {}),
    }));
  if (kind === "placement") {
    const pl = placementOf(p.value);
    const { axis, angle } = axisAngle(pl);
    const base: [number, number, number] = [pl.base.x, pl.base.y, pl.base.z];
    return [
      { path: "Rotation.Angle", label: "Angle", kind: "quantity", display: formatQuantity(angle, "deg"), value: angle, unit: "deg" },
      {
        path: "Rotation.Axis",
        label: "Axis",
        kind: "vector",
        display: `[${axis.map((x) => fixed(x)).join(" ")}]`,
        value: axis,
        children: mkVec("Rotation.Axis", axis, undefined),
      },
      {
        path: "Base",
        label: "Position",
        kind: "vectorDistance",
        display: `[${base.map((x) => formatQuantity(x, "mm")).join("  ")}]`,
        value: base,
        children: mkVec("Base", base, "mm"),
      },
    ];
  }
  if (kind === "vector") return mkVec("", vectorOf(p.value), undefined).map((r) => ({ ...r, path: r.label }));
  if (kind === "vectorDistance") return mkVec("", vectorOf(p.value), "mm").map((r) => ({ ...r, path: r.label }));
  return [];
}

/**
 * A new value for the whole property after editing one sub-row, plus the Python FreeCAD writes
 * for it. `subPath` is a `SubRow.path`; `n` is in the sub-row's unit (mm, deg or plain).
 */
export function applySubEdit(p: PropertyInfo, subPath: string, n: number): { value: PropertyInput; python: string } | null {
  const kind = propertyKind(p);
  if (kind === "placement") {
    const pl = placementOf(p.value);
    const aa = axisAngle(pl);
    const base = [pl.base.x, pl.base.y, pl.base.z];
    const axis = [...aa.axis];
    let angle = aa.angle;
    const comp = { x: 0, y: 1, z: 2 } as Record<string, number>;
    if (subPath === "Rotation.Angle") angle = n;
    else if (subPath.startsWith("Rotation.Axis.")) axis[comp[subPath.slice(-1)]!] = n;
    else if (subPath.startsWith("Base.")) base[comp[subPath.slice(-1)]!] = n;
    else return null;
    if (Math.hypot(axis[0]!, axis[1]!, axis[2]!) < 1e-12) axis.splice(0, 3, 0, 0, 1);
    const next = new Placement(Vector.fromArray(base), Rotation.fromAxisAngle(axis, angle));
    return { value: next.toWire(), python: placementPython(next) };
  }
  if (kind === "vector" || kind === "vectorDistance") {
    const v = vectorOf(p.value);
    const i = { x: 0, y: 1, z: 2 }[subPath as "x" | "y" | "z"];
    if (i === undefined) return null;
    v[i] = n;
    return { value: { $type: "Vector", x: v[0], y: v[1], z: v[2] }, python: vectorPython(v) };
  }
  return null;
}

// ------------------------------------------------------------------------------- grouping

export interface PropertyGroup {
  name: string;
  rows: PropertyInfo[];
}

/**
 * Rows grouped like `PropertyModel::getGroupInfo`: an empty group is "Base", groups are sorted by
 * name (a `std::map<QString>`), rows keep the container's order. Hidden properties and types with
 * no editor are left out unless `showAll`.
 */
export function groupProperties(props: PropertyInfo[], opts: { showAll?: boolean } = {}): PropertyGroup[] {
  const groups = new Map<string, PropertyInfo[]>();
  for (const p of props) {
    if (!opts.showAll && isHidden(p)) continue;
    const g = p.group || "Base";
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(p);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, rows]) => ({ name, rows }));
}

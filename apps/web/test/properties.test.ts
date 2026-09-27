import { describe, expect, test } from "bun:test";
import type { PropertyInfo } from "@fab-cad/protocol";
import {
  applySubEdit,
  assignmentEcho,
  displayValue,
  groupProperties,
  isHidden,
  parseInput,
  parseQuantityInput,
  placementPython,
  propertyKind,
  subRows,
} from "../src/properties/model";
import { Placement, Rotation, Vector } from "@fab-cad/protocol";

const P = (p: Partial<PropertyInfo> & Pick<PropertyInfo, "name" | "type">): PropertyInfo => ({
  group: "",
  doc: "",
  status: [],
  value: null,
  ...p,
});

const length = P({
  name: "Length",
  type: "App::PropertyLength",
  group: "Box",
  value: { $type: "Quantity", value: 10, unit: "mm", text: "10.00 mm" },
  unit: "mm",
});
const angle = P({
  name: "Angle",
  type: "App::PropertyAngle",
  group: "Cylinder",
  value: { $type: "Quantity", value: 360, unit: "deg" },
  unit: "deg",
});
const placement = P({
  name: "Placement",
  type: "App::PropertyPlacement",
  status: ["NoRecompute"],
  value: { $type: "Placement", base: [1, 2, 3], rotation: [0, 0, 0, 1], axis: [0, 0, 1], angle: 0 },
});

describe("property kinds", () => {
  test("FreeCAD property types map to editors", () => {
    expect(propertyKind(length)).toBe("quantity");
    expect(propertyKind(angle)).toBe("quantity");
    expect(propertyKind(P({ name: "Refine", type: "App::PropertyBool", value: true }))).toBe("bool");
    expect(propertyKind(P({ name: "Type", type: "App::PropertyEnumeration", value: "Length", enum: ["Length", "UpToLast"] }))).toBe("enum");
    expect(propertyKind(P({ name: "Occurrences", type: "App::PropertyIntegerConstraint", value: 3 }))).toBe("int");
    expect(propertyKind(P({ name: "FuzzyTolerance", type: "App::PropertyFloatConstraint", value: 1e-7 }))).toBe("float");
    expect(propertyKind(placement)).toBe("placement");
    expect(propertyKind(P({ name: "Direction", type: "App::PropertyVector", value: { $type: "Vector", x: 0, y: 0, z: 1 } }))).toBe(
      "vector",
    );
    expect(propertyKind(P({ name: "Tip", type: "App::PropertyLink", value: null }))).toBe("link");
    expect(propertyKind(P({ name: "Profile", type: "App::PropertyLinkSub", value: null }))).toBe("linkSub");
    expect(propertyKind(P({ name: "Shape", type: "Part::PropertyPartShape", value: null }))).toBe("none");
    expect(propertyKind(P({ name: "Label", type: "App::PropertyString", value: "Box" }))).toBe("string");
  });

  test("hidden flags and editor-less types are hidden", () => {
    expect(isHidden(P({ name: "Visibility", type: "App::PropertyBool", status: ["Hidden", "Output"], value: true }))).toBe(true);
    expect(isHidden(P({ name: "Shape", type: "Part::PropertyPartShape", value: null }))).toBe(true);
    expect(isHidden(length)).toBe(false);
  });
});

describe("display values", () => {
  test("quantities, placements, vectors and links read like FreeCAD's property editor", () => {
    expect(displayValue(length)).toBe("10.00 mm");
    expect(displayValue(angle)).toBe("360.00 °");
    expect(displayValue(placement)).toBe("[(0.00 0.00 1.00); 0.00 °; (1.00 mm  2.00 mm  3.00 mm)]");
    expect(displayValue(P({ name: "Direction", type: "App::PropertyVector", value: { $type: "Vector", x: 0, y: 0, z: 1 } }))).toBe(
      "[0.00 0.00 1.00]",
    );
    expect(displayValue(P({ name: "Refine", type: "App::PropertyBool", value: false }))).toBe("false");
    const labels: Record<string, string> = { Sketch: "My sketch" };
    expect(
      displayValue(
        P({ name: "Tip", type: "App::PropertyLink", value: { $type: "Object", doc: "D", name: "Sketch" } }),
        (n) => labels[n] ?? n,
      ),
    ).toBe("My sketch");
    expect(
      displayValue(
        P({ name: "Profile", type: "App::PropertyLinkSub", value: [{ $type: "Object", doc: "D", name: "Sketch" }, ["Face1", "Edge2"]] }),
        (n) => labels[n] ?? n,
      ),
    ).toBe("My sketch (Face1, Edge2)");
  });
});

describe("parsing input", () => {
  test("quantities accept units and convert to the property's base unit", () => {
    const mm = parseQuantityInput("10 mm", "mm");
    expect(mm.ok && mm.value).toEqual({ $type: "Quantity", value: 10, unit: "mm" });
    const inch = parseQuantityInput("1 in", "mm");
    expect(inch.ok && (inch.value as { value: number }).value).toBeCloseTo(25.4);
    expect(inch.ok && inch.python).toBe("'25.40 mm'");
    const bare = parseQuantityInput("12.5", "mm");
    expect(bare.ok && (bare.value as { value: number }).value).toBe(12.5);
    const deg = parseQuantityInput("90 °", "deg");
    expect(deg.ok && deg.python).toBe("'90.00 °'");
    expect(parseQuantityInput("10 deg", "mm").ok).toBe(false);
    expect(parseQuantityInput("abc", "mm").ok).toBe(false);
    expect(parseQuantityInput("", "mm").ok).toBe(false);
  });

  test("numbers, booleans, enumerations and strings", () => {
    const f = parseInput(P({ name: "F", type: "App::PropertyFloat", value: 0 }), "1,5");
    expect(f.ok && f.value).toBe(1.5);
    expect(parseInput(P({ name: "I", type: "App::PropertyInteger", value: 0 }), "2.5").ok).toBe(false);
    const i = parseInput(P({ name: "I", type: "App::PropertyInteger", value: 0 }), "7");
    expect(i.ok && i.python).toBe("7");
    const e = parseInput(P({ name: "T", type: "App::PropertyEnumeration", value: "A", enum: ["A", "B"] }), "B");
    expect(e.ok && e.python).toBe("'B'");
    expect(parseInput(P({ name: "T", type: "App::PropertyEnumeration", value: "A", enum: ["A", "B"] }), "C").ok).toBe(false);
    const s = parseInput(P({ name: "Label", type: "App::PropertyString", value: "" }), "it's");
    expect(s.ok && s.python).toBe("'it\\'s'");
    const b = parseInput(P({ name: "Refine", type: "App::PropertyBool", value: false }), "true");
    expect(b.ok && b.python).toBe("True");
  });
});

describe("placement and vector sub-rows", () => {
  test("a placement expands into Angle, Axis and Position", () => {
    const rows = subRows(placement);
    expect(rows.map((r) => r.label)).toEqual(["Angle", "Axis", "Position"]);
    expect(rows[2]!.children!.map((r) => r.display)).toEqual(["1.00 mm", "2.00 mm", "3.00 mm"]);
    expect(rows[1]!.children!.map((r) => r.path)).toEqual(["Rotation.Axis.x", "Rotation.Axis.y", "Rotation.Axis.z"]);
  });

  test("editing a sub-row rebuilds the whole placement", () => {
    const r = applySubEdit(placement, "Base.z", 10)!;
    expect(r.python).toBe("App.Placement(App.Vector(1.00,2.00,10.00),App.Rotation(App.Vector(0.00,0.00,1.00),0.00))");
    const a = applySubEdit(placement, "Rotation.Angle", 90)!;
    const w = a.value as { axis: number[]; angle: number; base: number[] };
    expect(w.angle).toBeCloseTo(90);
    expect(w.base).toEqual([1, 2, 3]);
    const vec = applySubEdit(P({ name: "Direction", type: "App::PropertyVector", value: { $type: "Vector", x: 0, y: 0, z: 1 } }), "x", 1)!;
    expect(vec.value).toEqual({ $type: "Vector", x: 1, y: 0, z: 1 });
  });

  test("placementPython writes FreeCAD's App.Placement form", () => {
    const p = new Placement(new Vector(0, 0, 5), Rotation.fromAxisAngle([1, 0, 0], 90));
    expect(placementPython(p)).toBe("App.Placement(App.Vector(0.00,0.00,5.00),App.Rotation(App.Vector(1.00,0.00,0.00),90.00))");
  });
});

describe("grouping", () => {
  test("groups sorted by name, empty group is Base, container order kept, hidden left out", () => {
    const props = [
      length,
      P({ name: "Width", type: "App::PropertyLength", group: "Box", value: { $type: "Quantity", value: 10, unit: "mm" } }),
      P({ name: "Shape", type: "Part::PropertyPartShape", value: null }),
      placement,
      P({ name: "Label", type: "App::PropertyString", group: "Base", status: ["Output"], value: "Cube" }),
      P({ name: "Visibility", type: "App::PropertyBool", status: ["Hidden"], value: true }),
    ];
    const g = groupProperties(props);
    expect(g.map((x) => x.name)).toEqual(["Base", "Box"]);
    expect(g[0]!.rows.map((r) => r.name)).toEqual(["Placement", "Label"]);
    expect(g[1]!.rows.map((r) => r.name)).toEqual(["Length", "Width"]);
    const all = groupProperties(props, { showAll: true });
    expect(all[0]!.rows.map((r) => r.name)).toEqual(["Shape", "Placement", "Label", "Visibility"]);
  });

  test("the echo is FreeCAD's PropertyItem::setPropertyValue line", () => {
    expect(assignmentEcho("Unnamed", "Box", "Length", "'20.00 mm'")).toBe(
      "FreeCAD.getDocument('Unnamed').getObject('Box').Length = '20.00 mm'",
    );
  });
});

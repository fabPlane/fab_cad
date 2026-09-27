/**
 * The mock's type registry: the handful of FreeCAD document object types it can create, with the
 * properties FreeCAD gives them (names, types, groups, tooltips and flags as FreeCAD 1.x has them),
 * and the dynamic property types `AddProperty` accepts.
 */
import { formatQuantity, type WireQuantity, type WireValue } from "@fab-cad/protocol";

export interface Prop {
  name: string;
  type: string;
  group: string;
  doc: string;
  status: string[];
  value: WireValue;
  unit?: string;
  enum?: string[];
  expression?: string;
}

export type ShapeKind = "box" | "cylinder" | "sphere";

export interface TypeDef {
  name: string;
  /** Most derived first. */
  hierarchy: string[];
  /** Can `AddObject` create it? */
  creatable: boolean;
  isGeo: boolean;
  /** Default internal name / label stem. */
  baseName: string;
  shape?: ShapeKind;
  props: () => Prop[];
}

export const q = (value: number, unit: string): WireQuantity => ({ $type: "Quantity", value, unit, text: formatQuantity(value, unit) });

const length = (name: string, group: string, doc: string, value: number): Prop => ({
  name,
  type: "App::PropertyLength",
  group,
  doc,
  status: [],
  value: q(value, "mm"),
  unit: "mm",
});

const angle = (name: string, group: string, doc: string, value: number): Prop => ({
  name,
  type: "App::PropertyAngle",
  group,
  doc,
  status: [],
  value: q(value, "deg"),
  unit: "deg",
});

function documentObjectProps(): Prop[] {
  return [
    { name: "Label", type: "App::PropertyString", group: "Base", doc: "User name of the object (UTF8)", status: [], value: "" },
    {
      name: "Label2",
      type: "App::PropertyString",
      group: "Base",
      doc: "User description of the object (UTF8)",
      status: ["Hidden"],
      value: "",
    },
    {
      name: "Visibility",
      type: "App::PropertyBool",
      group: "Base",
      doc: "Whether the object is visible",
      status: ["Hidden", "Output", "NoRecompute"],
      value: true,
    },
  ];
}

function geoFeatureProps(): Prop[] {
  return [
    ...documentObjectProps(),
    {
      name: "Placement",
      type: "App::PropertyPlacement",
      group: "Base",
      doc: "Position and orientation of the object",
      status: [],
      value: { $type: "Placement", base: [0, 0, 0], rotation: [0, 0, 0, 1], axis: [0, 0, 1], angle: 0 },
    },
  ];
}

function partFeatureProps(): Prop[] {
  return [
    ...geoFeatureProps(),
    {
      name: "Shape",
      type: "Part::PropertyPartShape",
      group: "Base",
      doc: "Shape of the object",
      status: ["Hidden", "Output"],
      value: { $type: "Repr", type: "Part.Shape", repr: "<Shape object (null)>" },
    },
  ];
}

const DOCUMENT_OBJECT = "App::DocumentObject";
/** What every document object derives from, up to `Base::BaseClass` (not included), as FreeCAD reports it. */
export const BASE_CLASSES = ["App::TransactionalObject", "App::ExtensionContainer", "App::PropertyContainer", "Base::Persistence"];
const H = (...names: string[]): string[] => [...names, ...BASE_CLASSES];
const GEO_FEATURE = "App::GeoFeature";
const PART_FEATURE = "Part::Feature";
const PART_PRIMITIVE = "Part::Primitive";

export const TYPES: Record<string, TypeDef> = {
  [DOCUMENT_OBJECT]: {
    name: DOCUMENT_OBJECT,
    hierarchy: H(DOCUMENT_OBJECT),
    creatable: false,
    isGeo: false,
    baseName: "Object",
    props: documentObjectProps,
  },
  [GEO_FEATURE]: {
    name: GEO_FEATURE,
    hierarchy: H(GEO_FEATURE, DOCUMENT_OBJECT),
    creatable: false,
    isGeo: true,
    baseName: "GeoFeature",
    props: geoFeatureProps,
  },
  "App::DocumentObjectGroup": {
    name: "App::DocumentObjectGroup",
    hierarchy: H("App::DocumentObjectGroup", DOCUMENT_OBJECT),
    creatable: true,
    isGeo: false,
    baseName: "Group",
    props: () => [
      ...documentObjectProps(),
      { name: "Group", type: "App::PropertyLinkList", group: "Base", doc: "List of referenced objects", status: [], value: [] },
    ],
  },
  [PART_FEATURE]: {
    name: PART_FEATURE,
    hierarchy: H(PART_FEATURE, GEO_FEATURE, DOCUMENT_OBJECT),
    creatable: false,
    isGeo: true,
    baseName: "Shape",
    props: partFeatureProps,
  },
  [PART_PRIMITIVE]: {
    name: PART_PRIMITIVE,
    hierarchy: H(PART_PRIMITIVE, PART_FEATURE, GEO_FEATURE, DOCUMENT_OBJECT),
    creatable: false,
    isGeo: true,
    baseName: "Primitive",
    props: partFeatureProps,
  },
  "Part::Box": {
    name: "Part::Box",
    hierarchy: H("Part::Box", PART_PRIMITIVE, PART_FEATURE, GEO_FEATURE, DOCUMENT_OBJECT),
    creatable: true,
    isGeo: true,
    baseName: "Box",
    shape: "box",
    props: () => [
      ...partFeatureProps(),
      length("Length", "Box", "The length of the box", 10),
      length("Width", "Box", "The width of the box", 10),
      length("Height", "Box", "The height of the box", 10),
    ],
  },
  "Part::Cylinder": {
    name: "Part::Cylinder",
    hierarchy: H("Part::Cylinder", PART_PRIMITIVE, PART_FEATURE, GEO_FEATURE, DOCUMENT_OBJECT),
    creatable: true,
    isGeo: true,
    baseName: "Cylinder",
    shape: "cylinder",
    props: () => [
      ...partFeatureProps(),
      length("Radius", "Cylinder", "The radius of the cylinder", 2),
      length("Height", "Cylinder", "The height of the cylinder", 10),
      angle("Angle", "Cylinder", "The angle of the cylinder", 360),
    ],
  },
  "Part::Sphere": {
    name: "Part::Sphere",
    hierarchy: H("Part::Sphere", PART_PRIMITIVE, PART_FEATURE, GEO_FEATURE, DOCUMENT_OBJECT),
    creatable: true,
    isGeo: true,
    baseName: "Sphere",
    shape: "sphere",
    props: () => [
      ...partFeatureProps(),
      length("Radius", "Sphere", "Radius of the sphere", 5),
      angle("Angle1", "Sphere", "Angle1-the start angle of the sphere", -90),
      angle("Angle2", "Sphere", "Angle2-the end angle of the sphere", 90),
      angle("Angle3", "Sphere", "Angle3-the revolution angle of the sphere", 360),
    ],
  },
};

/** Every type name the mock knows, abstract ones and base classes included. */
export function knownType(name: string): boolean {
  return Object.values(TYPES).some((t) => t.hierarchy.includes(name));
}

/** Creatable types derived from `base` (inclusive), sorted, for `GetTypes`. */
export function typesDerivedFrom(base: string): string[] {
  return Object.values(TYPES)
    .filter((t) => t.creatable && t.hierarchy.includes(base))
    .map((t) => t.name)
    .sort();
}

/** Default value and unit for a dynamic property, or undefined for an unknown type. */
export function dynamicPropertyDefault(type: string): { value: WireValue; unit?: string; enum?: string[] } | undefined {
  switch (type) {
    case "App::PropertyString":
    case "App::PropertyFont":
    case "App::PropertyFile":
    case "App::PropertyPath":
      return { value: "" };
    case "App::PropertyBool":
      return { value: false };
    case "App::PropertyInteger":
    case "App::PropertyFloat":
    case "App::PropertyPercent":
      return { value: 0 };
    case "App::PropertyLength":
    case "App::PropertyDistance":
      return { value: q(0, "mm"), unit: "mm" };
    case "App::PropertyAngle":
      return { value: q(0, "deg"), unit: "deg" };
    case "App::PropertyQuantity":
      return { value: q(0, ""), unit: "" };
    case "App::PropertyVector":
    case "App::PropertyVectorDistance":
      return { value: { $type: "Vector", x: 0, y: 0, z: 0 } };
    case "App::PropertyPlacement":
      return { value: { $type: "Placement", base: [0, 0, 0], rotation: [0, 0, 0, 1], axis: [0, 0, 1], angle: 0 } };
    case "App::PropertyLink":
      return { value: null };
    case "App::PropertyLinkList":
    case "App::PropertyStringList":
    case "App::PropertyIntegerList":
    case "App::PropertyFloatList":
      return { value: [] };
    case "App::PropertyEnumeration":
      return { value: "", enum: [] };
    case "App::PropertyMap":
      return { value: {} };
    default:
      return undefined;
  }
}

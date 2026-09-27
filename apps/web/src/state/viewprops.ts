/**
 * View provider properties (the property view's View tab): FreeCAD keeps them in the GUI document
 * (`ViewProviderPartExt`), which the headless API server does not have, so the web UI owns them.
 * Defaults are FreeCAD's (`ViewParams.cpp`: shape #cccccc, lines black 2 px, points #191919 2 px).
 * `Visibility` is the exception: it lives on the App object and goes through `setProperties`.
 */
import { create } from "zustand";

export type DisplayMode = "Flat Lines" | "Shaded" | "Wireframe" | "Points";

export interface ViewProps {
  DisplayMode: DisplayMode;
  ShapeColor: string;
  LineColor: string;
  PointColor: string;
  LineWidth: number;
  PointSize: number;
  Transparency: number;
  Selectable: boolean;
  BoundingBox: boolean;
  ShowInTree: boolean;
  Deviation: number;
  AngularDeflection: number;
  Lighting: "One side" | "Two side";
  DrawStyle: "Solid" | "Dashed" | "Dotted" | "Dashdot";
  OnTopWhenSelected: "Disabled" | "Enabled" | "Object" | "Element";
  SelectionStyle: "Shape" | "BoundBox";
}

export const DEFAULT_SHAPE_COLOR = "#cccccc";
export const DEFAULT_LINE_COLOR = "#000000";
export const DEFAULT_POINT_COLOR = "#191919";
/** Sketches draw their edges white outside edit mode (`ViewProviderSketch`). */
export const SKETCH_LINE_COLOR = "#ffffff";

export function defaultViewProps(type = ""): ViewProps {
  const sketch = type.startsWith("Sketcher::");
  const datum = /^(App::(Line|Plane|Point|Origin)|PartDesign::(Plane|Line|Point))/.test(type);
  return {
    DisplayMode: sketch ? "Wireframe" : "Flat Lines",
    ShapeColor: datum ? "#ffff00" : DEFAULT_SHAPE_COLOR,
    LineColor: sketch ? SKETCH_LINE_COLOR : DEFAULT_LINE_COLOR,
    PointColor: sketch ? SKETCH_LINE_COLOR : DEFAULT_POINT_COLOR,
    LineWidth: 2,
    PointSize: sketch ? 4 : 2,
    Transparency: 0,
    Selectable: true,
    BoundingBox: false,
    ShowInTree: true,
    Deviation: 0.5,
    AngularDeflection: 28.5,
    Lighting: "Two side",
    DrawStyle: "Solid",
    OnTopWhenSelected: "Disabled",
    SelectionStyle: "Shape",
  };
}

/** The View tab rows: property name, FreeCAD group, editor. */
export const VIEW_PROPERTY_DEFS: {
  name: keyof ViewProps | "Visibility";
  group: string;
  kind: "enum" | "bool" | "color" | "float" | "int" | "angle";
  enum?: string[];
  min?: number;
  max?: number;
  doc: string;
}[] = [
  { name: "BoundingBox", group: "Display Options", kind: "bool", doc: "Display object bounding box" },
  {
    name: "DisplayMode",
    group: "Display Options",
    kind: "enum",
    enum: ["Flat Lines", "Shaded", "Wireframe", "Points"],
    doc: "Set the display mode",
  },
  { name: "ShowInTree", group: "Display Options", kind: "bool", doc: "Show the object in the tree view" },
  { name: "Visibility", group: "Display Options", kind: "bool", doc: "Show the object in the 3D view" },
  { name: "AngularDeflection", group: "Object Style", kind: "angle", doc: "Specify how finely to generate the mesh for rendering" },
  { name: "Deviation", group: "Object Style", kind: "float", doc: "Sets the accuracy of the polygonal representation of the model" },
  { name: "DrawStyle", group: "Object Style", kind: "enum", enum: ["Solid", "Dashed", "Dotted", "Dashdot"], doc: "Set the line style" },
  { name: "Lighting", group: "Object Style", kind: "enum", enum: ["One side", "Two side"], doc: "Set object lighting" },
  { name: "LineColor", group: "Object Style", kind: "color", doc: "Set the line color" },
  { name: "LineWidth", group: "Object Style", kind: "float", min: 1, max: 64, doc: "Set the line width" },
  { name: "PointColor", group: "Object Style", kind: "color", doc: "Set the point color" },
  { name: "PointSize", group: "Object Style", kind: "float", min: 1, max: 64, doc: "Set the point size" },
  { name: "ShapeColor", group: "Object Style", kind: "color", doc: "Set the shape color" },
  { name: "Transparency", group: "Object Style", kind: "int", min: 0, max: 100, doc: "Set the object transparency" },
  {
    name: "OnTopWhenSelected",
    group: "Selection",
    kind: "enum",
    enum: ["Disabled", "Enabled", "Object", "Element"],
    doc: "Render the object on top of others when selected",
  },
  { name: "Selectable", group: "Selection", kind: "bool", doc: "Set if the object is selectable in the 3D view" },
  { name: "SelectionStyle", group: "Selection", kind: "enum", enum: ["Shape", "BoundBox"], doc: "Set the object selection style" },
];

const key = (doc: string, object: string) => `${doc}\u0000${object}`;

interface ViewPropsState {
  overrides: Record<string, Partial<ViewProps>>;
  set: (doc: string, object: string, patch: Partial<ViewProps>) => void;
  forget: (doc: string) => void;
}

export const useViewProps = create<ViewPropsState>((set, get) => ({
  overrides: {},
  set: (doc, object, patch) => {
    const k = key(doc, object);
    set({ overrides: { ...get().overrides, [k]: { ...get().overrides[k], ...patch } } });
  },
  forget: (doc) => {
    const next: Record<string, Partial<ViewProps>> = {};
    for (const [k, v] of Object.entries(get().overrides)) if (!k.startsWith(`${doc}\u0000`)) next[k] = v;
    set({ overrides: next });
  },
}));

export function viewPropsOf(doc: string, object: string, type: string, overrides = useViewProps.getState().overrides): ViewProps {
  return { ...defaultViewProps(type), ...overrides[key(doc, object)] };
}

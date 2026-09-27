/**
 * Part workbench task dialogs: Primitives (`DlgPrimitives`), Boolean (`DlgBooleanOperation`),
 * Fillet/Chamfer edges (`DlgFilletEdges`), Extrude, Revolve and Mirror.
 */
import { Placement, Rotation, Vector, objectRef, type ObjectInfo, type PropertyInput } from "@fab-cad/client";
import { useState } from "react";
import { command, errorText, python, settle } from "../commands/actions";
import { fixed, pyNum, pyStr } from "../lib/format";
import { placementPython, placementWire } from "../properties/model";
import { echo, log } from "../state/console";
import { selectedObjects, useSelection } from "../state/selection";
import { client, labelOf, objects, useModel } from "../state/session";
import { viewer } from "../state/view3d";
import { objectIcon } from "../ui/icons";
import { Icon, CheckBox, ComboBox, FloatSpinBox, FormRow, GroupBox, QuantitySpinBox } from "../ui/widgets";
import { openFeatureTask, openSimpleTask } from "./featureTask";

// ------------------------------------------------------------------------------ primitives

interface ParamDef {
  prop: string;
  label: string;
  unit: "mm" | "deg" | "" | "int";
  value: number;
}

export interface PrimitiveDef {
  label: string;
  type: string;
  name: string;
  icon: string;
  params: ParamDef[];
}

const L = (prop: string, value: number, label = prop): ParamDef => ({ prop, label, unit: "mm", value });
const A = (prop: string, value: number, label = prop): ParamDef => ({ prop, label, unit: "deg", value });

/** The primitive types of `DlgPrimitives.ui`, in its order, with its default values. */
export const PRIMITIVES: PrimitiveDef[] = [
  { label: "Plane", type: "Part::Plane", name: "Plane", icon: "Part_Plane_Parametric", params: [L("Length", 10), L("Width", 10)] },
  { label: "Box", type: "Part::Box", name: "Box", icon: "Part_Box_Parametric", params: [L("Length", 10), L("Width", 10), L("Height", 10)] },
  {
    label: "Cylinder",
    type: "Part::Cylinder",
    name: "Cylinder",
    icon: "Part_Cylinder_Parametric",
    params: [L("Radius", 2), L("Height", 10), A("Angle", 360, "Rotation angle")],
  },
  {
    label: "Cone",
    type: "Part::Cone",
    name: "Cone",
    icon: "Part_Cone_Parametric",
    params: [L("Radius1", 2, "Radius 1"), L("Radius2", 4, "Radius 2"), L("Height", 10), A("Angle", 360, "Rotation angle")],
  },
  {
    label: "Sphere",
    type: "Part::Sphere",
    name: "Sphere",
    icon: "Part_Sphere_Parametric",
    params: [L("Radius", 5), A("Angle1", -90, "Angle 1"), A("Angle2", 90, "Angle 2"), A("Angle3", 360, "Angle 3")],
  },
  {
    label: "Ellipsoid",
    type: "Part::Ellipsoid",
    name: "Ellipsoid",
    icon: "Part_Ellipsoid_Parametric",
    params: [
      L("Radius1", 2, "Radius 1"),
      L("Radius2", 4, "Radius 2"),
      L("Radius3", 0, "Radius 3"),
      A("Angle1", -90),
      A("Angle2", 90),
      A("Angle3", 360),
    ],
  },
  {
    label: "Torus",
    type: "Part::Torus",
    name: "Torus",
    icon: "Part_Torus_Parametric",
    params: [L("Radius1", 10, "Radius 1"), L("Radius2", 2, "Radius 2"), A("Angle1", -180), A("Angle2", 180), A("Angle3", 360)],
  },
  {
    label: "Prism",
    type: "Part::Prism",
    name: "Prism",
    icon: "Part_Prism_Parametric",
    params: [{ prop: "Polygon", label: "Polygon", unit: "int", value: 6 }, L("Circumradius", 2), L("Height", 10)],
  },
  {
    label: "Wedge",
    type: "Part::Wedge",
    name: "Wedge",
    icon: "Part_Wedge_Parametric",
    params: [
      L("Xmin", 0),
      L("Ymin", 0),
      L("Zmin", 0),
      L("X2min", 2),
      L("Z2min", 2),
      L("Xmax", 10),
      L("Ymax", 10),
      L("Zmax", 10),
      L("X2max", 8),
      L("Z2max", 8),
    ],
  },
  {
    label: "Helix",
    type: "Part::Helix",
    name: "Helix",
    icon: "Part_Helix_Parametric",
    params: [L("Pitch", 1), L("Height", 2), L("Radius", 1), A("Angle", 0)],
  },
  {
    label: "Spiral",
    type: "Part::Spiral",
    name: "Spiral",
    icon: "Part_Spiral_Parametric",
    params: [L("Growth", 1), { prop: "Rotations", label: "Rotations", unit: "", value: 2 }, L("Radius", 1)],
  },
  {
    label: "Circle",
    type: "Part::Circle",
    name: "Circle",
    icon: "Part_Circle_Parametric",
    params: [L("Radius", 2), A("Angle1", 0), A("Angle2", 360)],
  },
  {
    label: "Ellipse",
    type: "Part::Ellipse",
    name: "Ellipse",
    icon: "Part_Ellipse_Parametric",
    params: [L("MajorRadius", 4, "Major radius"), L("MinorRadius", 2, "Minor radius"), A("Angle1", 0), A("Angle2", 360)],
  },
  { label: "Point", type: "Part::Vertex", name: "Vertex", icon: "Part_Point_Parametric", params: [L("X", 0), L("Y", 0), L("Z", 0)] },
  {
    label: "Line",
    type: "Part::Line",
    name: "Line",
    icon: "Part_Line_Parametric",
    params: [L("X1", 0), L("Y1", 0), L("Z1", 0), L("X2", 10), L("Y2", 0), L("Z2", 0)],
  },
  {
    label: "Regular polygon",
    type: "Part::RegularPolygon",
    name: "RegularPolygon",
    icon: "Part_Polygon_Parametric",
    params: [{ prop: "Polygon", label: "Polygon", unit: "int", value: 6 }, L("Circumradius", 2)],
  },
];

export function primitiveProperties(def: PrimitiveDef, values: Record<string, number>): Record<string, PropertyInput> {
  const out: Record<string, PropertyInput> = {};
  for (const p of def.params) {
    const v = values[p.prop] ?? p.value;
    out[p.prop] = p.unit === "mm" || p.unit === "deg" ? { $type: "Quantity", value: v, unit: p.unit } : v;
  }
  return out;
}

export function primitiveEcho(
  def: PrimitiveDef,
  name: string,
  values: Record<string, number>,
  pl: { base: number[]; axis: number[]; angle: number },
): string[] {
  const lines = [`App.ActiveDocument.addObject(${pyStr(def.type)},${pyStr(name)})`];
  for (const p of def.params) {
    const v = values[p.prop] ?? p.value;
    const lit =
      p.unit === "mm" ? pyStr(`${fixed(v)} mm`) : p.unit === "deg" ? pyStr(`${fixed(v)} °`) : p.unit === "int" ? String(v) : pyNum(v);
    lines.push(`App.ActiveDocument.${name}.${p.prop}=${lit}`);
  }
  lines.push(`App.ActiveDocument.${name}.Placement=${placementPython(placementFromFields(pl))}`);
  lines.push(`App.ActiveDocument.${name}.Label=${pyStr(def.label)}`);
  return lines;
}

function placementFromFields(pl: { base: number[]; axis: number[]; angle: number }): Placement {
  return new Placement(Vector.fromArray(pl.base), Rotation.fromAxisAngle(pl.axis, pl.angle));
}

function PrimitivesBody({ state }: { state: PrimitivesState }) {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const def = PRIMITIVES[state.index]!;
  return (
    <>
      <GroupBox title="Primitive parameters" icon="Part_Primitives">
        <FormRow label="Type">
          <ComboBox
            testId="primitive-type"
            value={String(state.index)}
            options={PRIMITIVES.map((p, i) => ({ value: String(i), label: p.label }))}
            onChange={(v) => {
              state.index = Number(v);
              rerender();
            }}
          />
        </FormRow>
        <div className="primitive-icon">
          <Icon name={def.icon} size={48} />
        </div>
        {def.params.map((p) => (
          <FormRow key={`${def.type}.${p.prop}`} label={`${p.label}:`}>
            {p.unit === "mm" || p.unit === "deg" ? (
              <QuantitySpinBox
                testId={`primitive-${p.prop}`}
                value={state.values[def.type]?.[p.prop] ?? p.value}
                unit={p.unit}
                onCommit={(v) => {
                  (state.values[def.type] ??= {})[p.prop] = v;
                  rerender();
                }}
              />
            ) : (
              <FloatSpinBox
                testId={`primitive-${p.prop}`}
                value={state.values[def.type]?.[p.prop] ?? p.value}
                integer={p.unit === "int"}
                onCommit={(v) => {
                  (state.values[def.type] ??= {})[p.prop] = v;
                  rerender();
                }}
              />
            )}
          </FormRow>
        ))}
      </GroupBox>
      <PlacementBox pl={state.placement} onChange={rerender} />
    </>
  );
}

export function PlacementBox({ pl, onChange }: { pl: { base: number[]; axis: number[]; angle: number }; onChange: () => void }) {
  return (
    <GroupBox title="Location" icon="Std_Placement">
      {(["X", "Y", "Z"] as const).map((c, i) => (
        <FormRow key={c} label={`${c}:`}>
          <QuantitySpinBox
            value={pl.base[i]!}
            unit="mm"
            testId={`placement-${c}`}
            onCommit={(v) => {
              pl.base[i] = v;
              onChange();
            }}
          />
        </FormRow>
      ))}
      <FormRow label="Rotation axis:">
        <div className="vec3">
          {[0, 1, 2].map((i) => (
            <FloatSpinBox
              key={i}
              value={pl.axis[i]!}
              onCommit={(v) => {
                pl.axis[i] = v;
                onChange();
              }}
            />
          ))}
        </div>
      </FormRow>
      <FormRow label="Angle:">
        <QuantitySpinBox
          value={pl.angle}
          unit="deg"
          onCommit={(v) => {
            pl.angle = v;
            onChange();
          }}
        />
      </FormRow>
    </GroupBox>
  );
}

interface PrimitivesState {
  index: number;
  values: Record<string, Record<string, number>>;
  placement: { base: number[]; axis: number[]; angle: number };
}

export async function createPrimitive(
  doc: string,
  def: PrimitiveDef,
  values: Record<string, number>,
  pl: PrimitivesState["placement"],
): Promise<string> {
  let created = "";
  await command(doc, "Create primitive", async () => {
    const info = await client().addObject(doc, def.type, {
      name: def.name,
      label: def.label,
      properties: { ...primitiveProperties(def, values), Placement: placementWire(pl.base, pl.axis, pl.angle) },
    });
    created = info.name;
  });
  echo(primitiveEcho(def, created, values, pl));
  useSelection.getState().select({ doc, object: created, sub: "" }, { echo: false });
  setTimeout(() => viewer()?.fitAll(), 30);
  return created;
}

export function openPrimitivesTask(doc: string, initialType = "Part::Box"): void {
  const state: PrimitivesState = {
    index: Math.max(
      0,
      PRIMITIVES.findIndex((p) => p.type === initialType),
    ),
    values: {},
    placement: { base: [0, 0, 0], axis: [0, 0, 1], angle: 0 },
  };
  openSimpleTask({
    id: "part-primitives",
    title: "Primitives",
    icon: "Part_Primitives",
    render: () => <PrimitivesBody state={state} />,
    accept: async () => {
      const def = PRIMITIVES[state.index]!;
      try {
        await createPrimitive(doc, def, state.values[def.type] ?? {}, state.placement);
      } catch (e) {
        log.error(`Cannot create ${def.label}: ${errorText(e)}`);
        return false;
      }
    },
  });
}

// ------------------------------------------------------------------------------ booleans

export type BooleanOp = "Union" | "Intersection" | "Difference" | "Section";

const BOOL_TYPES: Record<BooleanOp, { type: string; name: string; tx: string }> = {
  Union: { type: "Part::MultiFuse", name: "Fusion", tx: "Fusion" },
  Intersection: { type: "Part::MultiCommon", name: "Common", tx: "Common" },
  Difference: { type: "Part::Cut", name: "Cut", tx: "Part Cut" },
  Section: { type: "Part::Section", name: "Section", tx: "Section" },
};

/** Part_Cut / Part_Fuse / Part_Common / Part_Section / the Boolean dialog: one transaction, inputs hidden. */
export async function booleanOperation(doc: string, op: BooleanOp, shapes: string[]): Promise<string> {
  const t = BOOL_TYPES[op];
  const refs = shapes.map((s) => objectRef(doc, s));
  const props: Record<string, PropertyInput> =
    op === "Union" || op === "Intersection" ? { Shapes: refs } : { Base: refs[0]!, Tool: refs[1]! };
  let name = "";
  await command(doc, t.tx, async () => {
    const info = await client().addObject(doc, t.type, { name: t.name, properties: props });
    name = info.name;
    for (const s of shapes) await client().setProperties(doc, s, { Visibility: false });
  });
  const lines = [`App.activeDocument().addObject(${pyStr(t.type)},${pyStr(name)})`];
  if (op === "Union" || op === "Intersection")
    lines.push(`App.activeDocument().${name}.Shapes = [${shapes.map((s) => `App.activeDocument().${s}`).join(",")},]`);
  else
    lines.push(
      `App.activeDocument().${name}.Base = App.activeDocument().${shapes[0]}`,
      `App.activeDocument().${name}.Tool = App.activeDocument().${shapes[1]}`,
    );
  for (const s of shapes) lines.push(`Gui.activeDocument().hide(${pyStr(s)})`);
  lines.push("App.ActiveDocument.recompute()");
  echo(lines);
  useSelection.getState().select({ doc, object: name, sub: "" }, { echo: false });
  return name;
}

const isSolidish = (o: ObjectInfo) =>
  o.isGeo && !o.type.startsWith("App::") && !o.type.startsWith("Sketcher::") && o.type !== "PartDesign::Body";

function ShapeList({ doc, value, onChange, testId }: { doc: string; value: string; onChange: (v: string) => void; testId: string }) {
  useModel();
  const shapes = objects(doc).filter(isSolidish);
  return (
    <div className="listbox" data-testid={testId}>
      {shapes.map((o) => (
        <div key={o.name} className={`listbox-item ${value === o.name ? "selected" : ""}`} onClick={() => onChange(o.name)}>
          <Icon name={objectIcon(o.type, o.typeHierarchy)} />
          {o.label}
        </div>
      ))}
    </div>
  );
}

export function openBooleanTask(doc: string): void {
  const sel = selectedObjects(useSelection.getState().selection, doc);
  const state = { op: "Union" as BooleanOp, first: sel[0] ?? "", second: sel[1] ?? "" };
  function Body() {
    const [, force] = useState(0);
    const set = (p: Partial<typeof state>) => (Object.assign(state, p), force((n) => n + 1));
    return (
      <GroupBox title="Boolean Operation" icon="Part_Boolean">
        <div className="radio-grid">
          {(["Union", "Intersection", "Difference", "Section"] as BooleanOp[]).map((op) => (
            <label key={op} className="radio">
              <input type="radio" checked={state.op === op} onChange={() => set({ op })} data-testid={`boolean-${op}`} />
              <Icon name={{ Union: "Part_Fuse", Intersection: "Part_Common", Difference: "Part_Cut", Section: "Part_Section" }[op]} />
              {op}
            </label>
          ))}
        </div>
        <div className="two-lists">
          <div>
            <div className="list-title">First shape</div>
            <ShapeList doc={doc} value={state.first} onChange={(v) => set({ first: v })} testId="boolean-first" />
          </div>
          <div>
            <div className="list-title">Second shape</div>
            <ShapeList doc={doc} value={state.second} onChange={(v) => set({ second: v })} testId="boolean-second" />
          </div>
        </div>
      </GroupBox>
    );
  }
  openSimpleTask({
    id: "part-boolean",
    title: "Boolean Operation",
    icon: "Part_Boolean",
    render: () => <Body />,
    accept: async () => {
      if (!state.first || !state.second || state.first === state.second) {
        log.warning("Select two different shapes for the boolean operation.");
        return false;
      }
      try {
        await booleanOperation(doc, state.op, [state.first, state.second]);
      } catch (e) {
        log.error(`Boolean operation failed: ${errorText(e)}`);
        return false;
      }
    },
  });
}

// ------------------------------------------------------------------------------ fillet / chamfer

/** Edge count of an object's shape (from its tessellation). */
async function edgeCount(doc: string, name: string): Promise<number> {
  const [t] = await client().tessellate(doc, { objects: [name] });
  return t?.edgeCount ?? 0;
}

export async function openPartFilletTask(doc: string, kind: "Fillet" | "Chamfer"): Promise<void> {
  const sel = useSelection.getState().selection.filter((s) => s.doc === doc);
  const found = sel[0]?.object ?? objects(doc).find(isSolidish)?.name;
  if (!found) {
    log.warning(`Select a shape (and its edges) to ${kind.toLowerCase()} first.`);
    return;
  }
  const base: string = found;
  const n = await edgeCount(doc, base);
  const picked = new Set(sel.filter((s) => s.object === base && s.sub.startsWith("Edge")).map((s) => Number(s.sub.slice(4))));
  const state = { radius: 1, edges: picked.size ? picked : new Set<number>(), base };
  function Body() {
    const [, force] = useState(0);
    const re = () => force((x) => x + 1);
    return (
      <GroupBox title={`${kind} Edges`} icon={`Part_${kind}`}>
        <FormRow label="Shape">
          <span>{labelOf(doc, base)}</span>
        </FormRow>
        <FormRow label={kind === "Fillet" ? "Radius:" : "Size:"}>
          <QuantitySpinBox testId="fillet-radius" value={state.radius} unit="mm" min={0} onCommit={(v) => ((state.radius = v), re())} />
        </FormRow>
        <div className="list-title">Edges to {kind.toLowerCase()}</div>
        <div className="listbox tall" data-testid="fillet-edges">
          {Array.from({ length: n }, (_, i) => i + 1).map((e) => (
            <div key={e} className="listbox-item">
              <CheckBox
                checked={state.edges.has(e)}
                onChange={(b) => {
                  if (b) state.edges.add(e);
                  else state.edges.delete(e);
                  re();
                }}
                label={`Edge${e}`}
              />
            </div>
          ))}
        </div>
        <div className="row-buttons">
          <button className="btn" onClick={() => (Array.from({ length: n }, (_, i) => state.edges.add(i + 1)), re())}>
            Select all
          </button>
          <button className="btn" onClick={() => (state.edges.clear(), re())}>
            None
          </button>
        </div>
      </GroupBox>
    );
  }
  openSimpleTask({
    id: `part-${kind}`,
    title: kind,
    icon: `Part_${kind}`,
    render: () => <Body />,
    accept: async () => {
      if (!state.edges.size) {
        log.warning(`Select at least one edge to ${kind.toLowerCase()}.`);
        return false;
      }
      const edges = [...state.edges].sort((a, b) => a - b);
      const r = pyNum(state.radius);
      const code = [
        `FreeCAD.ActiveDocument = FreeCAD.getDocument(${pyStr(doc)})`,
        `__fillets__ = []`,
        ...edges.map((e) => `__fillets__.append((${e},${r},${r}))`),
        `FreeCAD.ActiveDocument.addObject("Part::${kind}","${kind}")`,
        `FreeCAD.ActiveDocument.ActiveObject.Base = FreeCAD.ActiveDocument.getObject(${pyStr(base)})`,
        `FreeCAD.ActiveDocument.ActiveObject.Edges = __fillets__`,
        `del __fillets__`,
        `FreeCAD.ActiveDocument.getObject(${pyStr(base)}).Visibility = False`,
      ].join("\n");
      try {
        await command(doc, kind, async () => {
          await python(code);
        });
      } catch (e) {
        log.error(`${kind} failed: ${errorText(e)}`);
        return false;
      }
    },
  });
}

// ------------------------------------------------------------------------------ extrude / revolve / mirror

export async function openExtrudeTask(doc: string): Promise<void> {
  const base = selectedObjects(useSelection.getState().selection, doc)[0];
  if (!base) return void log.warning("Select a shape to extrude (a sketch, a face, a wire).");
  const c = client();
  await c.openTransaction(doc, "Extrude");
  try {
    const info = await c.addObject(doc, "Part::Extrusion", {
      name: "Extrude",
      properties: { Base: objectRef(doc, base), DirMode: "Normal", LengthFwd: { $type: "Quantity", value: 10, unit: "mm" }, Solid: true },
    });
    await c.setProperties(doc, base, { Visibility: false });
    await c.recompute(doc);
    echo([
      `f = FreeCAD.getDocument(${pyStr(doc)}).addObject('Part::Extrusion', 'Extrude')`,
      `f.Base = App.getDocument(${pyStr(doc)}).getObject(${pyStr(base)})`,
      `f.DirMode = "Normal"`,
      `f.LengthFwd = 10.0`,
      `f.Solid = True`,
    ]);
    await settle();
    openFeatureTask({
      doc,
      object: info.name,
      title: "Extrude",
      icon: "Part_Extrude",
      fields: [
        { prop: "DirMode", label: "Direction", kind: "enum" },
        { prop: "LengthFwd", label: "Along:", kind: "quantity" },
        { prop: "LengthRev", label: "Against:", kind: "quantity" },
        { prop: "Symmetric", label: "Symmetric", kind: "bool" },
        { prop: "Reversed", label: "Reversed", kind: "bool" },
        { prop: "Solid", label: "Create solid", kind: "bool" },
        { prop: "TaperAngle", label: "Taper outward angle", kind: "quantity" },
      ],
    });
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    log.error(`Extrude failed: ${errorText(e)}`);
  }
}

export async function openRevolveTask(doc: string): Promise<void> {
  const base = selectedObjects(useSelection.getState().selection, doc)[0];
  if (!base) return void log.warning("Select a shape to revolve.");
  const c = client();
  await c.openTransaction(doc, "Revolve");
  try {
    const info = await c.addObject(doc, "Part::Revolution", {
      name: "Revolve",
      properties: {
        Source: objectRef(doc, base),
        Axis: { $type: "Vector", x: 0, y: 1, z: 0 },
        Angle: { $type: "Quantity", value: 360, unit: "deg" },
        Solid: true,
      },
    });
    await c.setProperties(doc, base, { Visibility: false });
    await c.recompute(doc);
    echo([
      `FreeCAD.ActiveDocument.addObject("Part::Revolution","Revolve")`,
      `FreeCAD.ActiveDocument.Revolve.Source = FreeCAD.ActiveDocument.${base}`,
      `FreeCAD.ActiveDocument.Revolve.Axis = (0.000000000000000,1.000000000000000,0.000000000000000)`,
      `FreeCAD.ActiveDocument.Revolve.Angle = 360.0`,
      `FreeCAD.ActiveDocument.Revolve.Solid = True`,
    ]);
    await settle();
    openFeatureTask({
      doc,
      object: info.name,
      title: "Revolve",
      icon: "Part_Revolve",
      fields: [
        { prop: "Angle", label: "Angle:", kind: "quantity" },
        { prop: "Symmetric", label: "Symmetric angle", kind: "bool" },
        { prop: "Solid", label: "Create solid", kind: "bool" },
      ],
    });
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    log.error(`Revolve failed: ${errorText(e)}`);
  }
}

export async function openMirrorTask(doc: string): Promise<void> {
  const base = selectedObjects(useSelection.getState().selection, doc)[0];
  if (!base) return void log.warning("Select a shape to mirror.");
  const c = client();
  await c.openTransaction(doc, "Mirroring");
  try {
    const info = await c.addObject(doc, "Part::Mirroring", {
      name: "Mirror",
      properties: { Source: objectRef(doc, base), Normal: { $type: "Vector", x: 1, y: 0, z: 0 } },
    });
    await c.recompute(doc);
    echo([
      `__doc__=FreeCAD.getDocument(${pyStr(doc)})`,
      `__doc__.addObject("Part::Mirroring")`,
      `__doc__.ActiveObject.Source=__doc__.getObject(${pyStr(base)})`,
      `__doc__.ActiveObject.Label=u"${labelOf(doc, base)} (Mirror #1)"`,
      `__doc__.ActiveObject.Normal=(1,0,0)`,
      `__doc__.ActiveObject.Base=(0,0,0)`,
      `del __doc__`,
    ]);
    await settle();
    const planes: Record<string, [number, number, number]> = { "YZ plane": [1, 0, 0], "XZ plane": [0, 1, 0], "XY plane": [0, 0, 1] };
    openFeatureTask({
      doc,
      object: info.name,
      title: "Mirroring",
      icon: "Part_Mirror",
      fields: [],
      extra: () => (
        <FormRow label="Mirror plane:">
          <ComboBox
            value="YZ plane"
            options={Object.keys(planes)}
            onChange={(v) => {
              const n = planes[v]!;
              void import("./featureTask").then((m) =>
                m.setLive(doc, info.name, { Normal: { $type: "Vector", x: n[0], y: n[1], z: n[2] } }, { Normal: `(${n.join(",")})` }),
              );
            }}
          />
        </FormRow>
      ),
    });
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    log.error(`Mirror failed: ${errorText(e)}`);
  }
}

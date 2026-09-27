/**
 * Sketcher task dialogs: the plane choice of a new sketch (Part Design's "Select feature" and the
 * Sketcher's `SketchOrientationDialog`), and the edit-mode panel (`TaskSketcherMessages`,
 * `TaskSketcherConstraints`, `TaskSketcherElements`) with its Close button.
 */
import { Placement, Rotation, Vector, type WirePlacement } from "@fab-cad/client";
import { useState } from "react";
import { formatQuantity } from "../lib/format";
import { placementPython } from "../properties/model";
import { constraintIcon, isDimensional, sketchVertices } from "../sketcher/model";
import { leaveSketchEdit, selKey, useSketch, type SketchSel } from "../sketcher/session";
import { editDatum } from "../sketcher/tools";
import { log } from "../state/console";
import { CheckBox, GroupBox, Icon, QuantitySpinBox, Button } from "../ui/widgets";
import { run } from "../ui/commandUi";
import { openSimpleTask } from "./featureTask";
import { useView3D } from "../state/view3d";

const PLANES = [
  { id: "XY_Plane", label: "XY_Plane (Base plane)", icon: "Std_Plane" },
  { id: "XZ_Plane", label: "XZ_Plane (Base plane)", icon: "Std_Plane" },
  { id: "YZ_Plane", label: "YZ_Plane (Base plane)", icon: "Std_Plane" },
];

/** Part Design: pick the base plane for a new sketch. */
export function openSketchPlaneTask(doc: string, onPlane: (plane: string) => Promise<void>): void {
  const state = { plane: "XY_Plane" };
  // The base planes show in the 3D view and can be clicked there too.
  const picker = (selected: string) =>
    useView3D.getState().setOriginPicker({
      selected,
      pick: (role) => {
        state.plane = role;
        picker(role);
      },
    });
  picker(state.plane);
  function Body() {
    const [, force] = useState(0);
    useView3D((s) => s.originPicker);
    return (
      <GroupBox title="Select feature" icon="Sketcher_NewSketch">
        <div className="muted">Select attachment plane for the new sketch:</div>
        <div className="listbox" data-testid="sketch-planes">
          {PLANES.map((p) => (
            <div
              key={p.id}
              className={`listbox-item ${state.plane === p.id ? "selected" : ""}`}
              data-testid={`plane-${p.id}`}
              onClick={() => ((state.plane = p.id), picker(p.id), force((n) => n + 1))}
            >
              <Icon name={p.icon} />
              {p.label}
            </div>
          ))}
        </div>
      </GroupBox>
    );
  }
  openSimpleTask({
    id: "pd-sketch-plane",
    title: "Select feature",
    icon: "Sketcher_NewSketch",
    render: () => <Body />,
    reject: () => useView3D.getState().setOriginPicker(null),
    accept: async () => {
      useView3D.getState().setOriginPicker(null);
      try {
        // Close the dialog before the sketch opens its own edit panel.
        setTimeout(() => void onPlane(state.plane).catch((e) => log.error(String(e))), 0);
      } catch (e) {
        log.error(String(e));
        return false;
      }
    },
  });
}

/** `SketchOrientationDialog`: XY / XZ / YZ, reversed, offset → the sketch placement. */
export function orientationPlacement(plane: "XY" | "XZ" | "YZ", reverse: boolean, offset: number): Placement {
  const q: Record<string, [number, number, number, number]> = {
    XY: reverse ? [1, 0, 0, 0] : [0, 0, 0, 1],
    XZ: reverse ? [0, 1, 1, 0] : [1, 0, 0, 1],
    YZ: reverse ? [-1, 1, 1, -1] : [1, 1, 1, 1],
  };
  const base: Record<string, [number, number, number]> = { XY: [0, 0, offset], XZ: [0, offset, 0], YZ: [offset, 0, 0] };
  return new Placement(Vector.fromArray(base[plane]!), Rotation.fromQuaternion(q[plane]!));
}

export function openSketchOrientationTask(doc: string, onAccept: (p: { wire: WirePlacement; python: string }) => Promise<void>): void {
  const state = { plane: "XY" as "XY" | "XZ" | "YZ", reverse: false, offset: 0 };
  function Body() {
    const [, force] = useState(0);
    const re = () => force((n) => n + 1);
    return (
      <GroupBox title="Sketch Orientation" icon="Sketcher_NewSketch">
        <div className="muted">Sketch orientation</div>
        {(["XY", "XZ", "YZ"] as const).map((p) => (
          <label key={p} className="radio">
            <input type="radio" checked={state.plane === p} onChange={() => ((state.plane = p), re())} data-testid={`orient-${p}`} />
            {p}-plane
          </label>
        ))}
        <CheckBox checked={state.reverse} onChange={(b) => ((state.reverse = b), re())} label="Reverse direction" />
        <div className="form-row">
          <label className="form-label">Offset:</label>
          <div className="form-field">
            <QuantitySpinBox value={state.offset} unit="mm" onCommit={(v) => ((state.offset = v), re())} />
          </div>
        </div>
      </GroupBox>
    );
  }
  openSimpleTask({
    id: "sketch-orientation",
    title: "Choose orientation",
    icon: "Sketcher_NewSketch",
    render: () => <Body />,
    accept: () => {
      const p = orientationPlacement(state.plane, state.reverse, state.offset);
      setTimeout(() => void onAccept({ wire: p.toWire(), python: placementPython(p) }).catch((e) => log.error(String(e))), 0);
    },
  });
}

// ------------------------------------------------------------------------------ edit panel

function geoLabel(type: string): string {
  return type === "LineSegment" ? "Line" : type === "ArcOfCircle" ? "Arc" : type === "Other" ? "Curve" : type;
}

export function SketchEditPanel() {
  const data = useSketch((s) => s.data);
  const selected = useSketch((s) => s.selected);
  const name = useSketch((s) => s.name);
  const tool = useSketch((s) => s.tool);
  const isSel = (s: SketchSel) => selected.some((x) => selKey(x) === selKey(s));
  const toggle = (s: SketchSel, add: boolean) => {
    const st = useSketch.getState();
    if (add) st.setSelected(isSel(s) ? st.selected.filter((x) => selKey(x) !== selKey(s)) : [...st.selected, s]);
    else st.setSelected([s]);
  };
  if (!data) return null;
  const msg =
    data.conflicting.length > 0
      ? { cls: "bad", text: `Over-constrained: conflicting constraints ${data.conflicting.join(", ")}` }
      : data.redundant.length > 0
        ? { cls: "bad", text: `Redundant constraints: ${data.redundant.join(", ")}` }
        : data.fully
          ? { cls: "ok", text: "Fully constrained" }
          : { cls: "under", text: data.dof >= 0 ? `Under-constrained: ${data.dof} DoF` : "Under-constrained" };
  return (
    <div data-testid="sketch-panel">
      <div className="task-buttons">
        <Button primary onClick={() => void leaveSketchEdit(true)} testId="sketch-close">
          Close
        </Button>
      </div>
      <GroupBox title="Solver messages" icon="Sketcher_Sketch">
        <div className={`solver-message ${msg.cls}`} data-testid="solver-message">
          {msg.text}
        </div>
        <div className="muted">
          {name}: {data.geo.length} elements, {data.cons.length} constraints{tool ? ` — tool: ${tool}` : ""}
        </div>
      </GroupBox>
      <GroupBox title="Edit controls" icon="Sketcher_CreateLine">
        <div className="row-buttons" style={{ flexWrap: "wrap" }}>
          {(
            [
              ["Sketcher_CreateLine", "Line"],
              ["Sketcher_CreatePolyline", "Polyline"],
              ["Sketcher_CreateRectangle", "Rectangle"],
              ["Sketcher_CreateCircle", "Circle"],
              ["Sketcher_CreateArc", "Arc"],
              ["Sketcher_CreatePoint", "Point"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className="tool-button" title={label} onClick={() => run(id)} data-testid={`panel-${id}`}>
              <Icon name={id} size={20} />
            </button>
          ))}
        </div>
      </GroupBox>
      <GroupBox title="Constraints" icon="Sketcher_ConstrainLock">
        <div className="listbox tall" data-testid="sketch-constraints">
          {data.cons.map((c) => (
            <div
              key={c.i}
              className={`listbox-item ${isSel({ kind: "constraint", i: c.i }) ? "selected" : ""}`}
              onClick={(e) => toggle({ kind: "constraint", i: c.i }, e.ctrlKey || e.metaKey)}
              onDoubleClick={() => isDimensional(c.type) && void editDatum(c.i)}
            >
              <Icon name={constraintIcon(c.type)} />
              {c.name || `Constraint${c.i + 1}`}
              {isDimensional(c.type) && (
                <span className="muted">
                  &nbsp;({formatQuantity(c.type === "Angle" ? (c.value * 180) / Math.PI : c.value, c.type === "Angle" ? "deg" : "mm")})
                </span>
              )}
            </div>
          ))}
        </div>
      </GroupBox>
      <GroupBox title="Elements" icon="Sketcher_Element_Line_Edge">
        <div className="listbox tall" data-testid="sketch-elements">
          {data.geo.map((g) => (
            <div
              key={g.i}
              className={`listbox-item ${isSel({ kind: "edge", geo: g.i }) ? "selected" : ""}`}
              onClick={(e) => toggle({ kind: "edge", geo: g.i }, e.ctrlKey || e.metaKey)}
            >
              <Icon
                name={
                  g.type === "Circle"
                    ? "Sketcher_Element_Circle_Edge"
                    : g.type === "ArcOfCircle"
                      ? "Sketcher_Element_Arc_Edge"
                      : g.type === "Point"
                        ? "Sketcher_Element_Point_StartingPoint"
                        : "Sketcher_Element_Line_Edge"
                }
              />
              {g.i + 1}-{geoLabel(g.type)}
              {g.construction ? "-Construction" : ""}
            </div>
          ))}
        </div>
        <div className="muted">{sketchVertices(data.geo).length} vertices · grid and snapping: click near a point to snap (coincident)</div>
      </GroupBox>
    </div>
  );
}

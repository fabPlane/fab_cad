/** Sketcher commands (`src/Mod/Sketcher/Gui/Command*.cpp`). */
import * as THREE from "three";
import { useSketch } from "../sketcher/session";
import { echo } from "../state/console";
import { selectedObjects } from "../state/selection";
import { bodyOf } from "../state/activeBody";
import { openSketchOrientationTask } from "../tasks/sketchTasks";
import { currentViewer } from "../ui/View3D";
import { client } from "../state/session";
import { command } from "./actions";
import { createAttachedSketch, newPartDesignSketch } from "./partdesign";
import { registerCommands, type CommandContext, type CommandDef } from "./registry";

const hasDoc = (c: CommandContext) => c.connected && !!c.doc && !c.taskOpen;
const editing = (c: CommandContext) => !!c.editing;

async function sketcher() {
  return Promise.all([import("../sketcher/session"), import("../sketcher/tools")]);
}

/** `Sketcher_NewSketch`: on a selected planar face, else with the orientation dialog (XY / XZ / YZ). */
async function newSketch(c: CommandContext): Promise<void> {
  const doc = c.doc!;
  if (c.workbench === "PartDesignWorkbench") return newPartDesignSketch(doc);
  const face = c.selection.find((s) => s.sub.startsWith("Face"));
  if (face) {
    await createAttachedSketch(doc, bodyOf(doc, face.object), face.object, face.sub);
    return;
  }
  openSketchOrientationTask(doc, async (placement) => {
    let name = "";
    await command(doc, "Create a new sketch", async () => {
      const info = await client().addObject(doc, "Sketcher::SketchObject", {
        name: "Sketch",
        label: "Sketch",
        properties: { Placement: placement.wire, MapMode: "Deactivated" },
      });
      name = info.name;
    });
    echo([
      `App.activeDocument().addObject('Sketcher::SketchObject', '${name}')`,
      `App.activeDocument().${name}.Label = 'Sketch'`,
      `App.activeDocument().${name}.Placement = ${placement.python}`,
      `App.activeDocument().${name}.MapMode = "Deactivated"`,
      `Gui.activeDocument().setEdit('${name}')`,
    ]);
    const { startSketchEdit } = await import("../sketcher/session");
    await startSketchEdit(doc, name);
  });
}

function tool(id: string, t: "point" | "line" | "polyline" | "rectangle" | "circle" | "arc"): CommandDef {
  return {
    id,
    isActive: editing,
    isChecked: () => useSketch.getState().tool === t,
    run: async () => {
      const [s] = await sketcher();
      s.useSketch.getState().setTool(s.useSketch.getState().tool === t ? null : t);
    },
  };
}

function constraint(id: string, kind: string): CommandDef {
  return {
    id,
    isActive: editing,
    run: async () => {
      const [, t] = await sketcher();
      await t.constrain(kind);
    },
  };
}

export function registerSketcherCommands(): void {
  const list: CommandDef[] = [
    { id: "Sketcher_NewSketch", isActive: (c) => hasDoc(c) && !c.editing, run: (c) => newSketch(c) },
    {
      id: "Sketcher_EditSketch",
      isActive: (c) =>
        hasDoc(c) && !c.editing && selectedObjects(c.selection, c.doc).some((n) => c.object(n)?.type === "Sketcher::SketchObject"),
      run: async (c) => {
        const name = selectedObjects(c.selection, c.doc).find((n) => c.object(n)?.type === "Sketcher::SketchObject")!;
        const [s] = await sketcher();
        await s.startSketchEdit(c.doc!, name);
      },
    },
    {
      id: "Sketcher_LeaveSketch",
      isActive: editing,
      run: async () => {
        const [s] = await sketcher();
        await s.leaveSketchEdit(true);
      },
    },
    {
      id: "Sketcher_CancelSketch",
      isActive: editing,
      run: async () => {
        const [s] = await sketcher();
        await s.leaveSketchEdit(false);
      },
    },
    {
      id: "Sketcher_ViewSketch",
      isActive: editing,
      run: async () => {
        const [s] = await sketcher();
        const d = s.useSketch.getState().data;
        const v = currentViewer();
        if (d && v) v.lookAlong(new THREE.Quaternion(...d.placement.q));
      },
    },
    {
      id: "Sketcher_StopOperation",
      isActive: editing,
      run: async () => {
        const [s] = await sketcher();
        s.useSketch.getState().setTool(null);
      },
    },
    tool("Sketcher_CreatePoint", "point"),
    tool("Sketcher_CreateLine", "line"),
    tool("Sketcher_CreatePolyline", "polyline"),
    tool("Sketcher_CreateRectangle", "rectangle"),
    tool("Sketcher_CreateCircle", "circle"),
    tool("Sketcher_CreateArc", "arc"),
    { id: "Sketcher_CompLine", items: ["Sketcher_CreatePolyline", "Sketcher_CreateLine"] },
    { id: "Sketcher_CompCreateArc", items: ["Sketcher_CreateArc"] },
    { id: "Sketcher_CompCreateRectangles", items: ["Sketcher_CreateRectangle"] },
    {
      ...constraint("Sketcher_ConstrainCoincidentUnified", "Coincident"),
      menuText: "Coincident Constraint",
      toolTip: "Constrains two points to be coincident, or a point to lie on an edge",
      pixmap: "Constraint_PointOnPoint",
      accel: "C",
    },
    constraint("Sketcher_ConstrainCoincident", "Coincident"),
    constraint("Sketcher_ConstrainHorizontal", "Horizontal"),
    constraint("Sketcher_ConstrainVertical", "Vertical"),
    constraint("Sketcher_ConstrainParallel", "Parallel"),
    constraint("Sketcher_ConstrainPerpendicular", "Perpendicular"),
    constraint("Sketcher_ConstrainTangent", "Tangent"),
    constraint("Sketcher_ConstrainEqual", "Equal"),
    constraint("Sketcher_ConstrainDistance", "Distance"),
    constraint("Sketcher_ConstrainDistanceX", "DistanceX"),
    constraint("Sketcher_ConstrainDistanceY", "DistanceY"),
    constraint("Sketcher_ConstrainRadius", "Radius"),
    constraint("Sketcher_ConstrainDiameter", "Diameter"),
    constraint("Sketcher_ConstrainLock", "Lock"),
    constraint("Sketcher_ConstrainBlock", "Block"),
    {
      id: "Sketcher_ConstrainHorVer",
      isActive: editing,
      run: async () => {
        const [s, t] = await sketcher();
        const r = t.resolveSelection();
        const g = r.geo.find((x) => x.i === r.lines[0]);
        const horizontal = g && g.type === "LineSegment" ? Math.abs(g.end[0] - g.start[0]) >= Math.abs(g.end[1] - g.start[1]) : true;
        await t.constrain(horizontal ? "Horizontal" : "Vertical");
        void s;
      },
    },
    {
      id: "Sketcher_Dimension",
      isActive: editing,
      run: async () => {
        const [, t] = await sketcher();
        const r = t.resolveSelection();
        await t.constrain(r.circles.length ? "Radius" : "Distance");
      },
    },
    {
      id: "Sketcher_ToggleConstruction",
      isActive: editing,
      run: async () => {
        const [, t] = await sketcher();
        await t.toggleConstruction();
      },
    },
  ];
  registerCommands(list);
}

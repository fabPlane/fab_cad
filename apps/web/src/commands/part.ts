/** Part workbench commands (`src/Mod/Part/Gui/Command*.cpp`). */
import { selectedObjects } from "../state/selection";
import {
  booleanOperation,
  openBooleanTask,
  openExtrudeTask,
  openMirrorTask,
  openPartFilletTask,
  openPrimitivesTask,
  openRevolveTask,
} from "../tasks/partTasks";
import { createObject, python, recompute } from "./actions";
import { registerCommands, type CommandContext, type CommandDef } from "./registry";
import { pyStr } from "../lib/format";

const hasDoc = (c: CommandContext) => c.connected && !!c.doc && !c.editing;
const selCount = (c: CommandContext) => selectedObjects(c.selection, c.doc).length;

/** `CmdPartBox` & co.: `addObject`, the translated label, one transaction, then `ViewFit`. */
function primitive(id: string, type: string, name: string, label: string): CommandDef {
  return {
    id,
    isActive: hasDoc,
    run: (c) =>
      createObject(c.doc!, type, name, label, {
        label,
        echo: [
          `App.ActiveDocument.addObject(${JSON.stringify(type)},${JSON.stringify(name)})`,
          `App.ActiveDocument.ActiveObject.Label = ${JSON.stringify(label)}`,
        ],
      }),
  };
}

export function registerPartCommands(): void {
  const list: CommandDef[] = [
    primitive("Part_Box", "Part::Box", "Box", "Cube"),
    primitive("Part_Cylinder", "Part::Cylinder", "Cylinder", "Cylinder"),
    primitive("Part_Sphere", "Part::Sphere", "Sphere", "Sphere"),
    primitive("Part_Cone", "Part::Cone", "Cone", "Cone"),
    primitive("Part_Torus", "Part::Torus", "Torus", "Torus"),
    {
      id: "Part_Tube",
      isActive: hasDoc,
      run: async (c) => {
        // A Python feature (BasicShapes.Shapes.TubeFeature); needs RunPython.
        await python(
          [
            "import BasicShapes.Shapes",
            `tube = App.getDocument(${pyStr(c.doc!)}).addObject("Part::FeaturePython","Tube")`,
            "BasicShapes.Shapes.TubeFeature(tube)",
          ].join("\n"),
        );
        await recompute(c.doc!, { quiet: true });
      },
    },
    { id: "Part_Primitives", isActive: hasDoc, run: (c) => openPrimitivesTask(c.doc!) },
    { id: "Part_Boolean", isActive: hasDoc, run: (c) => openBooleanTask(c.doc!) },
    {
      id: "Part_Cut",
      isActive: (c) => hasDoc(c) && selCount(c) === 2,
      run: (c) => booleanOperation(c.doc!, "Difference", selectedObjects(c.selection, c.doc)),
    },
    {
      id: "Part_Fuse",
      isActive: (c) => hasDoc(c) && selCount(c) >= 2,
      run: (c) => booleanOperation(c.doc!, "Union", selectedObjects(c.selection, c.doc)),
    },
    {
      id: "Part_Common",
      isActive: (c) => hasDoc(c) && selCount(c) >= 2,
      run: (c) => booleanOperation(c.doc!, "Intersection", selectedObjects(c.selection, c.doc)),
    },
    {
      id: "Part_Section",
      isActive: (c) => hasDoc(c) && selCount(c) === 2,
      run: (c) => booleanOperation(c.doc!, "Section", selectedObjects(c.selection, c.doc)),
    },
    {
      id: "Part_Compound",
      isActive: (c) => hasDoc(c) && selCount(c) >= 1,
      run: async (c) => {
        const names = selectedObjects(c.selection, c.doc);
        const { objectRef } = await import("@fab-cad/client");
        await createObject(c.doc!, "Part::Compound", "Compound", "Compound", {
          properties: { Links: names.map((n) => objectRef(c.doc!, n)) },
          echo: [
            `App.activeDocument().addObject("Part::Compound","Compound")`,
            `App.activeDocument().Compound.Links = [${names.map((n) => `App.activeDocument().${n},`).join("")}]`,
          ],
          fit: false,
        });
      },
    },
    { id: "Part_CompCompoundTools", items: ["Part_Compound", "Part_ExplodeCompound", "Part_CompoundFilter"] },
    { id: "Part_CompJoinFeatures", items: ["Part_JoinConnect", "Part_JoinEmbed", "Part_JoinCutout"] },
    { id: "Part_CompSplitFeatures", items: ["Part_BooleanFragments", "Part_SliceApart", "Part_Slice", "Part_XOR"] },
    { id: "Part_CompOffset", items: ["Part_Offset", "Part_Offset2D"] },
    { id: "Part_Extrude", isActive: (c) => hasDoc(c) && selCount(c) >= 1, run: (c) => openExtrudeTask(c.doc!) },
    { id: "Part_Revolve", isActive: (c) => hasDoc(c) && selCount(c) >= 1, run: (c) => openRevolveTask(c.doc!) },
    { id: "Part_Mirror", isActive: (c) => hasDoc(c) && selCount(c) >= 1, run: (c) => openMirrorTask(c.doc!) },
    { id: "Part_Fillet", isActive: hasDoc, run: (c) => openPartFilletTask(c.doc!, "Fillet") },
    { id: "Part_Chamfer", isActive: hasDoc, run: (c) => openPartFilletTask(c.doc!, "Chamfer") },
    {
      id: "Part_RefineShape",
      isActive: (c) => hasDoc(c) && selCount(c) >= 1,
      run: async (c) => {
        const { objectRef } = await import("@fab-cad/client");
        for (const n of selectedObjects(c.selection, c.doc)) {
          await createObject(c.doc!, "Part::Refine", "Refine", "Refine shape", {
            properties: { Source: objectRef(c.doc!, n) },
            echo: [`App.ActiveDocument.addObject('Part::Refine','${n}').Source=App.ActiveDocument.${n}`],
            fit: false,
          });
        }
      },
    },
  ];
  registerCommands(list);
}

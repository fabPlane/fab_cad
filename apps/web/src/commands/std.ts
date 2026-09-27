/**
 * The standard commands (`src/Gui/Command*.cpp`): File, Edit, View, Windows, Help and the
 * structure tools, implemented over the FreeCAD API.
 */
import { IMPORT_ACCEPT, OPEN_ACCEPT, fileBytes, pickFiles } from "../lib/files";
import { pyStr } from "../lib/format";
import { useApp, type WorkbenchId } from "../state/app";
import { echo, log } from "../state/console";
import { message, prompt } from "../state/dialogs";
import { selectedObjects, useSelection } from "../state/selection";
import { documents, object, objects } from "../state/session";
import { DRAW_STYLES, useView3D, viewer, type StandardView } from "../state/view3d";
import { useViewProps, viewPropsOf } from "../state/viewprops";
import { aboutDialog, exportDialog, saveAsDialog } from "../ui/dialogs/fileDialogs";
import {
  activateDocument,
  closeDocument,
  createObject,
  deleteObjects,
  exportObjects,
  importInto,
  newDocument,
  openFile,
  python,
  recompute,
  redo,
  saveDocument,
  serverHasFiles,
  setVisibility,
  undo,
} from "./actions";
import { registerCommands, type CommandContext, type CommandDef } from "./registry";

const hasDoc = (c: CommandContext) => c.connected && !!c.doc;
const hasSel = (c: CommandContext) => hasDoc(c) && c.selection.length > 0;
const notEditing = (c: CommandContext) => !c.editing && !c.taskOpen;

function selNames(c: CommandContext): string[] {
  return selectedObjects(c.selection, c.doc);
}

function standardView(id: string, view: StandardView): CommandDef {
  return {
    id,
    isActive: hasDoc,
    run: () => {
      echo(`Gui.activeDocument().activeView().view${view === "Home" ? "Home" : view}()`);
      viewer()?.setStandardView(view);
    },
  };
}

export const WORKBENCHES: { id: WorkbenchId; name: string; icon: string }[] = [
  { id: "PartDesignWorkbench", name: "Part Design", icon: "PartDesignWorkbench" },
  { id: "PartWorkbench", name: "Part", icon: "PartWorkbench" },
  { id: "SketcherWorkbench", name: "Sketcher", icon: "SketcherWorkbench" },
];

export function activateWorkbench(id: WorkbenchId): void {
  if (useApp.getState().workbench === id) return;
  echo(`Gui.activateWorkbench(${pyStr(id)})`);
  useApp.getState().setWorkbench(id);
}

export function registerStdCommands(): void {
  const list: CommandDef[] = [
    // ------------------------------------------------------------------ File
    { id: "Std_New", isActive: (c) => c.connected, run: () => newDocument() },
    {
      id: "Std_Open",
      isActive: (c) => c.connected,
      run: async () => {
        for (const f of await pickFiles(OPEN_ACCEPT, true)) await openFile(f);
      },
    },
    {
      id: "Std_CloseActiveWindow",
      isActive: (c) => hasDoc(c) || useApp.getState().startTab,
      run: async (c) => {
        if (c.doc) await closeDocument(c.doc);
        else useApp.getState().closeStart();
      },
    },
    {
      id: "Std_CloseAllWindows",
      isActive: (c) => c.connected && documents().length > 0,
      run: async () => {
        for (const d of documents()) await closeDocument(d.name);
      },
    },
    { id: "Std_Save", isActive: hasDoc, run: (c) => saveDocument(c.doc!) },
    {
      id: "Std_SaveAs",
      isActive: hasDoc,
      run: async (c) => {
        const target = serverHasFiles() ? await saveAsDialog(c.doc!) : "download";
        if (target) await saveDocument(c.doc!, { as: target });
      },
    },
    { id: "Std_SaveCopy", isActive: hasDoc, run: (c) => saveDocument(c.doc!, { as: "download", copy: true }) },
    {
      id: "Std_SaveAll",
      isActive: (c) => c.connected && documents().length > 0,
      run: async () => {
        for (const d of documents()) await saveDocument(d.name);
      },
    },
    {
      id: "Std_Import",
      isActive: (c) => c.connected,
      run: async (c) => {
        const files = await pickFiles(IMPORT_ACCEPT, true);
        if (!files.length) return;
        const doc = c.doc ?? (await newDocument());
        for (const f of files) await importInto(doc, f.name, await fileBytes(f));
      },
    },
    {
      id: "Std_Export",
      isActive: hasSel,
      run: async (c) => {
        const names = selNames(c);
        const choice = await exportDialog(c.doc!, names);
        if (choice) await exportObjects(c.doc!, names, choice.format, choice.fileName);
      },
    },
    {
      id: "Std_ProjectInfo",
      isActive: hasDoc,
      run: async (c) => {
        const d = documents().find((x) => x.name === c.doc);
        if (!d) return;
        await message(
          "Document information",
          `Name: ${d.name}\nLabel: ${d.label}\nFile: ${d.fileName || "(not saved)"}\nObjects: ${d.objectCount}\nModified: ${d.modified ? "yes" : "no"}\nUndo steps: ${d.undoCount}, redo steps: ${d.redoCount}`,
        );
      },
    },

    // ------------------------------------------------------------------ Edit
    {
      id: "Std_Undo",
      isActive: (c) => hasDoc(c) && notEditing(c) && (c.undo?.undo.length ?? 0) > 0,
      run: (c) => undo(c.doc!),
    },
    {
      id: "Std_Redo",
      isActive: (c) => hasDoc(c) && notEditing(c) && (c.undo?.redo.length ?? 0) > 0,
      run: (c) => redo(c.doc!),
    },
    {
      id: "Std_Delete",
      isActive: (c) => hasSel(c) && notEditing(c),
      run: (c) => deleteObjects(c.doc!, selNames(c)),
    },
    {
      id: "Std_Refresh",
      isActive: (c) => hasDoc(c) && c.objects().some((o) => o.isTouched || o.isError),
      run: (c) => recompute(c.doc!),
    },
    {
      id: "Std_SelectAll",
      isActive: hasDoc,
      run: (c) => {
        echo(`Gui.Selection.addSelection(App.getDocument(${pyStr(c.doc!)}).Objects)`);
        useSelection.getState().setSelection(c.objects().map((o) => ({ doc: c.doc!, object: o.name, sub: "" })));
      },
    },
    {
      id: "Std_DuplicateSelection",
      isActive: (c) => hasSel(c) && notEditing(c),
      run: async (c) => {
        const names = selNames(c);
        const doc = c.doc!;
        await python(
          [
            `__objs__ = [App.getDocument(${pyStr(doc)}).getObject(n) for n in ${JSON.stringify(names)}]`,
            `App.getDocument(${pyStr(doc)}).openTransaction('Duplicate')`,
            `App.getDocument(${pyStr(doc)}).copyObject(__objs__, True)`,
            `App.getDocument(${pyStr(doc)}).commitTransaction()`,
            "del __objs__",
          ].join("\n"),
        );
        await recompute(doc, { quiet: true });
      },
    },
    {
      id: "Std_SendToPythonConsole",
      isActive: (c) => hasSel(c),
      run: async (c) => {
        const s = c.selection[0]!;
        const lines = [`obj = App.getDocument(${pyStr(s.doc)}).getObject(${pyStr(s.object)})`];
        if (s.sub) lines.push(`shp = obj.Shape`, `elt = obj.Shape.${s.sub}`);
        await python(lines.join("\n"));
        useApp.setState({ panels: { ...useApp.getState().panels, python: true } });
      },
    },
    {
      id: "Std_Edit",
      isActive: (c) => hasSel(c) && !c.taskOpen && (!!c.editing || c.object(c.selection[0]!.object)?.type === "Sketcher::SketchObject"),
      isChecked: (c) => !!c.editing,
      run: async (c) => {
        const { startSketchEdit, leaveSketchEdit } = await import("../sketcher/session");
        if (c.editing) await leaveSketchEdit(true);
        else await startSketchEdit(c.doc!, c.selection[0]!.object);
      },
    },
    { id: "Std_Properties", isActive: hasSel, run: () => useApp.getState().setComboTab("model") },

    // ------------------------------------------------------------------ Create
    {
      id: "Std_Group",
      isActive: hasDoc,
      run: (c) => createObject(c.doc!, "App::DocumentObjectGroup", "Group", "Add a group", { fit: false }),
    },
    {
      id: "Std_Part",
      isActive: hasDoc,
      run: (c) =>
        createObject(c.doc!, "App::Part", "Part", "Add a part", {
          echo: [
            "App.activeDocument().Tip = App.activeDocument().addObject('App::Part','Part')",
            "App.activeDocument().Part.Label = 'Part'",
          ],
          fit: false,
        }),
    },
    {
      id: "Std_VarSet",
      isActive: hasDoc,
      run: (c) => createObject(c.doc!, "App::VarSet", "VarSet", "Add a variable set", { fit: false }),
    },

    // ------------------------------------------------------------------ View
    {
      id: "Std_OrthographicCamera",
      isActive: hasDoc,
      isChecked: () => useView3D.getState().orthographic,
      run: () => {
        echo('Gui.activeDocument().activeView().setCameraType("Orthographic")');
        useView3D.getState().setOrthographic(true);
      },
    },
    {
      id: "Std_PerspectiveCamera",
      isActive: hasDoc,
      isChecked: () => !useView3D.getState().orthographic,
      run: () => {
        echo('Gui.activeDocument().activeView().setCameraType("Perspective")');
        useView3D.getState().setOrthographic(false);
      },
    },
    {
      id: "Std_ViewFitAll",
      isActive: hasDoc,
      run: () => {
        echo('Gui.SendMsgToActiveView("ViewFit")');
        viewer()?.fitAll();
      },
    },
    {
      id: "Std_ViewFitSelection",
      isActive: hasSel,
      run: () => {
        echo('Gui.SendMsgToActiveView("ViewSelection")');
        viewer()?.fitSelection();
      },
    },
    { id: "Std_AlignToSelection", isActive: hasSel, run: () => viewer()?.alignToSelection() },
    standardView("Std_ViewIsometric", "Isometric"),
    standardView("Std_ViewDimetric", "Dimetric"),
    standardView("Std_ViewTrimetric", "Trimetric"),
    standardView("Std_ViewHome", "Home"),
    standardView("Std_ViewFront", "Front"),
    standardView("Std_ViewTop", "Top"),
    standardView("Std_ViewRight", "Right"),
    standardView("Std_ViewRear", "Rear"),
    standardView("Std_ViewBottom", "Bottom"),
    standardView("Std_ViewLeft", "Left"),
    { id: "Std_ViewRotateLeft", isActive: hasDoc, run: () => viewer()?.rotateAroundView(90) },
    { id: "Std_ViewRotateRight", isActive: hasDoc, run: () => viewer()?.rotateAroundView(-90) },
    { id: "Std_ViewZoomIn", isActive: hasDoc, run: () => viewer()?.zoom(1 / 1.25) },
    { id: "Std_ViewZoomOut", isActive: hasDoc, run: () => viewer()?.zoom(1.25) },
    {
      id: "Std_DrawStyle",
      items: DRAW_STYLES.map((d) => d.id),
    },
    ...DRAW_STYLES.map(
      (d): CommandDef => ({
        id: d.id,
        menuText: d.menuText,
        pixmap: d.pixmap,
        accel: d.accel,
        toolTip: `Sets the draw style of the 3D view to ${d.style.toLowerCase()}`,
        isActive: hasDoc,
        isChecked: () => useView3D.getState().drawStyle === d.style,
        run: () => {
          echo(`Gui.activeDocument().activeView().setDrawStyle(${pyStr(d.style)})`);
          useView3D.getState().setDrawStyle(d.style);
        },
      }),
    ),
    {
      id: "Std_AxisCross",
      isActive: hasDoc,
      isChecked: () => useView3D.getState().axisCross,
      run: () => useView3D.getState().toggleAxisCross(),
    },
    {
      id: "Std_ToggleVisibility",
      isActive: (c) => hasSel(c) && notEditing(c),
      run: (c) => setVisibility(c.doc!, selNames(c), "toggle"),
    },
    { id: "Std_ShowSelection", isActive: hasSel, run: (c) => setVisibility(c.doc!, selNames(c), true) },
    { id: "Std_HideSelection", isActive: hasSel, run: (c) => setVisibility(c.doc!, selNames(c), false) },
    {
      id: "Std_SelectVisibleObjects",
      isActive: hasDoc,
      run: (c) =>
        useSelection.getState().setSelection(
          c
            .objects()
            .filter((o) => o.visibility && o.isGeo)
            .map((o) => ({ doc: c.doc!, object: o.name, sub: "" })),
        ),
    },
    {
      id: "Std_ToggleObjects",
      isActive: hasDoc,
      run: (c) =>
        setVisibility(
          c.doc!,
          c
            .objects()
            .filter((o) => o.isGeo)
            .map((o) => o.name),
          "toggle",
        ),
    },
    {
      id: "Std_ShowObjects",
      isActive: hasDoc,
      run: (c) =>
        setVisibility(
          c.doc!,
          c
            .objects()
            .filter((o) => o.isGeo && !o.visibility)
            .map((o) => o.name),
          true,
        ),
    },
    {
      id: "Std_HideObjects",
      isActive: hasDoc,
      run: (c) =>
        setVisibility(
          c.doc!,
          c
            .objects()
            .filter((o) => o.isGeo && o.visibility)
            .map((o) => o.name),
          false,
        ),
    },
    {
      id: "Std_ToggleSelectability",
      isActive: hasSel,
      run: (c) => {
        for (const n of selNames(c)) {
          const o = object(c.doc!, n);
          const vp = viewPropsOf(c.doc!, n, o?.type ?? "");
          useViewProps.getState().set(c.doc!, n, { Selectable: !vp.Selectable });
        }
      },
    },
    {
      id: "Std_ToggleTransparency",
      isActive: hasSel,
      run: (c) => {
        for (const n of selNames(c)) {
          const o = object(c.doc!, n);
          const vp = viewPropsOf(c.doc!, n, o?.type ?? "");
          useViewProps.getState().set(c.doc!, n, { Transparency: vp.Transparency > 0 ? 0 : 70 });
        }
      },
    },
    {
      id: "Std_RandomColor",
      isActive: hasSel,
      run: (c) => {
        for (const n of selNames(c)) {
          const col = `#${Array.from({ length: 3 }, () =>
            Math.floor(Math.random() * 256)
              .toString(16)
              .padStart(2, "0"),
          ).join("")}`;
          useViewProps.getState().set(c.doc!, n, { ShapeColor: col });
          echo(`Gui.getDocument(${pyStr(c.doc!)}).getObject(${pyStr(n)}).ShapeColor = ${pyStr(col)}`);
        }
      },
    },
    {
      id: "Std_ViewScreenShot",
      isActive: hasDoc,
      run: async (c) => {
        const url = viewer()?.screenshot();
        if (!url) return;
        const a = document.createElement("a");
        a.href = url;
        a.download = `${c.doc}.png`;
        a.click();
      },
    },
    {
      id: "Std_ViewStatusBar",
      isChecked: () => useApp.getState().panels.statusBar,
      run: () => useApp.getState().togglePanel("statusBar"),
    },
    { id: "Std_DockViewMenu", items: ["Std_ComboView", "Std_ReportView", "Std_PythonView"] },
    {
      id: "Std_ComboView",
      menuText: "Combo View",
      toolTip: "Toggles the Combo View",
      isChecked: () => useApp.getState().panels.comboView,
      run: () => useApp.getState().togglePanel("comboView"),
    },
    {
      id: "Std_ReportView",
      menuText: "Report view",
      toolTip: "Toggles the Report view",
      isChecked: () => useApp.getState().panels.report,
      run: () => useApp.getState().togglePanel("report"),
    },
    {
      id: "Std_PythonView",
      menuText: "Python console",
      toolTip: "Toggles the Python console",
      isChecked: () => useApp.getState().panels.python,
      run: () => useApp.getState().togglePanel("python"),
    },
    {
      id: "Std_ToggleBottomPanels",
      isChecked: () => useApp.getState().panels.report || useApp.getState().panels.python,
      run: () => {
        const p = useApp.getState().panels;
        const on = !(p.report || p.python);
        useApp.setState({ panels: { ...p, report: on, python: on } });
      },
    },
    { id: "Std_Workbench", items: WORKBENCHES.map((w) => `Std_Workbench_${w.id}`) },
    ...WORKBENCHES.map(
      (w): CommandDef => ({
        id: `Std_Workbench_${w.id}`,
        menuText: w.name,
        pixmap: w.icon,
        toolTip: `Switch to the ${w.name} workbench`,
        isChecked: (c) => c.workbench === w.id,
        run: () => activateWorkbench(w.id),
      }),
    ),

    // ------------------------------------------------------------------ Windows
    {
      id: "Std_ActivateNextWindow",
      isActive: () => useApp.getState().openTabs.length > 1,
      run: () => {
        const { openTabs, activeDoc } = useApp.getState();
        const i = openTabs.indexOf(activeDoc ?? "");
        void activateDocument(openTabs[(i + 1) % openTabs.length]!);
      },
    },
    {
      id: "Std_ActivatePrevWindow",
      isActive: () => useApp.getState().openTabs.length > 1,
      run: () => {
        const { openTabs, activeDoc } = useApp.getState();
        const i = openTabs.indexOf(activeDoc ?? "");
        void activateDocument(openTabs[(i - 1 + openTabs.length) % openTabs.length]!);
      },
    },
    {
      id: "Std_Windows",
      isActive: () => useApp.getState().openTabs.length > 0,
      run: async () => {
        const names = useApp.getState().openTabs;
        const pick = await prompt("Windows", `Activate a window (${names.join(", ")}):`, useApp.getState().activeDoc ?? names[0] ?? "");
        if (pick && names.includes(pick)) await activateDocument(pick);
      },
    },

    // ------------------------------------------------------------------ Help
    { id: "Std_About", run: () => aboutDialog() },
    { id: "Std_FreeCADWebsite", run: () => void window.open("https://www.freecad.org", "_blank", "noopener") },
    { id: "Std_FreeCADUserHub", run: () => void window.open("https://wiki.freecad.org/User_hub", "_blank", "noopener") },
    { id: "Std_FreeCADForum", run: () => void window.open("https://forum.freecad.org", "_blank", "noopener") },
    { id: "Std_ReportBug", run: () => void window.open("https://github.com/FreeCAD/FreeCAD/issues", "_blank", "noopener") },
    { id: "Std_PythonHelp", run: () => void window.open("https://wiki.freecad.org/Python_scripting_tutorial", "_blank", "noopener") },
    { id: "Std_DevHandbook", run: () => void window.open("https://freecad.github.io/DevelopersHandbook/", "_blank", "noopener") },
    { id: "Std_FreeCADDonation", run: () => void window.open("https://www.freecad.org/sponsor", "_blank", "noopener") },
    {
      id: "Std_Start",
      menuText: "&Start Page",
      pixmap: "freecad",
      toolTip: "Displays the Start page",
      run: () => useApp.getState().showStart(),
    },
  ];
  registerCommands(list);
  void objects;
  void log;
}

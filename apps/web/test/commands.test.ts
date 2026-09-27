import { beforeAll, describe, expect, test } from "bun:test";
import type { ObjectInfo } from "@fab-cad/protocol";
import { registerAllCommands } from "../src/commands/index";
import {
  commandInfo,
  eventToKey,
  isCommandActive,
  isCommandChecked,
  parseAccel,
  stepKey,
  stripMnemonic,
  type CommandContext,
} from "../src/commands/registry";
import { buildAccelMap } from "../src/ui/shortcuts";
import { commandsOf, effectiveLayout, workbench, WORKBENCH_DEFS } from "../src/workbenches";
import catalog from "../src/generated/freecad-commands.json";

beforeAll(() => registerAllCommands());

const obj = (name: string, type = "Part::Box"): ObjectInfo => ({
  name,
  label: name,
  type,
  typeHierarchy: [type],
  isGeo: true,
  isValid: true,
  isTouched: false,
  isError: false,
  status: "Valid",
  inList: [],
  outList: [],
  children: [],
  parents: [],
  visibility: true,
});

function ctx(p: Partial<CommandContext> = {}): CommandContext {
  const objects = [obj("Box"), obj("Cylinder", "Part::Cylinder"), obj("Sketch", "Sketcher::SketchObject")];
  return {
    connected: true,
    doc: "Unnamed",
    selection: [],
    editing: null,
    taskOpen: false,
    workbench: "PartWorkbench",
    undo: { undo: [], redo: [] },
    objects: () => objects,
    object: (n) => objects.find((o) => o.name === n),
    ...p,
  };
}

describe("command metadata comes from FreeCAD's sources", () => {
  test("menu texts, pixmaps and shortcuts", () => {
    expect(commandInfo("Std_New")).toMatchObject({ menuText: "&New Document", pixmap: "document-new", accel: "Ctrl+N" });
    expect(commandInfo("Std_Undo")).toMatchObject({ pixmap: "edit-undo", accel: "Ctrl+Z" });
    expect(commandInfo("Std_Redo").accel).toBe("Ctrl+Y");
    expect(commandInfo("Std_ViewFitAll").accel).toBe("V, F");
    expect(commandInfo("Std_ViewIsometric").accel).toBe("0");
    expect(commandInfo("Std_ViewFront").accel).toBe("1");
    expect(commandInfo("Std_ToggleVisibility").accel).toBe("Space");
    expect(commandInfo("Std_Delete").accel).toBe("Del");
    expect(commandInfo("Part_Box")).toMatchObject({ menuText: "Cube", pixmap: "Part_Box_Parametric" });
    expect(commandInfo("PartDesign_Pad").menuText).toBe("Pad");
    expect(stripMnemonic("&New Document")).toBe("New Document");
  });

  test("every command a workbench shows has FreeCAD's texts or a web definition", () => {
    const META = catalog as Record<string, unknown>;
    for (const wb of Object.values(WORKBENCH_DEFS)) {
      for (const id of commandsOf(wb)) {
        const info = commandInfo(id);
        const known = id in META || info.def !== undefined;
        if (!known) throw new Error(`${wb.name}: ${id} has neither FreeCAD metadata nor a definition`);
      }
    }
  });
});

describe("command enabling", () => {
  test("document commands need a document", () => {
    expect(isCommandActive("Part_Box", ctx())).toBe(true);
    expect(isCommandActive("Part_Box", ctx({ doc: null }))).toBe(false);
    expect(isCommandActive("Std_New", ctx({ doc: null }))).toBe(true);
    expect(isCommandActive("Std_New", ctx({ connected: false }))).toBe(false);
  });

  test("undo and redo follow the undo stack", () => {
    expect(isCommandActive("Std_Undo", ctx())).toBe(false);
    expect(isCommandActive("Std_Undo", ctx({ undo: { undo: ["Edit Box.Length"], redo: [] } }))).toBe(true);
    expect(isCommandActive("Std_Redo", ctx({ undo: { undo: [], redo: ["Cube"] } }))).toBe(true);
    expect(isCommandActive("Std_Undo", ctx({ undo: { undo: ["x"], redo: [] }, taskOpen: true }))).toBe(false);
  });

  test("selection-based commands", () => {
    const one = [{ doc: "Unnamed", object: "Box", sub: "" }];
    const two = [...one, { doc: "Unnamed", object: "Cylinder", sub: "Face1" }];
    expect(isCommandActive("Std_Delete", ctx())).toBe(false);
    expect(isCommandActive("Std_Delete", ctx({ selection: one }))).toBe(true);
    expect(isCommandActive("Part_Cut", ctx({ selection: one }))).toBe(false);
    expect(isCommandActive("Part_Cut", ctx({ selection: two }))).toBe(true);
    expect(isCommandActive("Part_Fuse", ctx({ selection: two }))).toBe(true);
    expect(isCommandActive("Std_ViewFitSelection", ctx({ selection: one }))).toBe(true);
    expect(isCommandActive("Sketcher_EditSketch", ctx({ selection: [{ doc: "Unnamed", object: "Sketch", sub: "" }] }))).toBe(true);
    expect(isCommandActive("Sketcher_EditSketch", ctx({ selection: one }))).toBe(false);
  });

  test("sketch tools only in edit mode; FreeCAD commands without a web version stay disabled", () => {
    expect(isCommandActive("Sketcher_CreateLine", ctx())).toBe(false);
    expect(isCommandActive("Sketcher_CreateLine", ctx({ editing: { doc: "Unnamed", object: "Sketch", kind: "sketch" } }))).toBe(true);
    expect(isCommandActive("Sketcher_LeaveSketch", ctx({ editing: { doc: "Unnamed", object: "Sketch", kind: "sketch" } }))).toBe(true);
    expect(isCommandActive("Part_Loft", ctx())).toBe(false);
    expect(commandInfo("Part_Loft").implemented).toBe(false);
    expect(isCommandActive("Std_Print", ctx())).toBe(false);
  });

  test("group commands are active when one of their items is; draw styles are checkable", () => {
    expect(isCommandActive("Std_DrawStyle", ctx())).toBe(true);
    expect(isCommandChecked("Std_DrawStyleAsIs", ctx())).toBe(true);
    expect(isCommandChecked("Std_DrawStyleWireframe", ctx())).toBe(false);
    expect(isCommandChecked("Std_Workbench_PartWorkbench", ctx())).toBe(true);
  });
});

describe("shortcuts", () => {
  test("accelerators parse into steps", () => {
    expect(parseAccel("Ctrl+Shift+S")).toEqual([["Ctrl", "Shift", "S"]]);
    expect(parseAccel("V, F")).toEqual([["V"], ["F"]]);
    expect(parseAccel("Ctrl++")).toEqual([["Ctrl", "+"]]);
    expect(stepKey(["Shift", "Ctrl", "s"])).toBe("Ctrl+Shift+S");
  });

  test("keyboard events normalise to FreeCAD's notation", () => {
    const k = (key: string, m: Partial<KeyboardEvent> = {}) =>
      eventToKey({ key, code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m } as KeyboardEvent);
    expect(k("z", { ctrlKey: true })).toBe("Ctrl+Z");
    expect(k(" ")).toBe("Space");
    expect(k("Delete")).toBe("Del");
    expect(k("S", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+S");
    expect(k("0")).toBe("0");
    expect(k("ArrowLeft", { shiftKey: true })).toBe("Shift+Left");
  });

  test("the accelerator map has FreeCAD's bindings, chords included", () => {
    const map = buildAccelMap();
    expect(map.get("Ctrl+N")).toContain("Std_New");
    expect(map.get("Ctrl+O")).toContain("Std_Open");
    expect(map.get("Ctrl+S")).toContain("Std_Save");
    expect(map.get("Ctrl+Z")).toContain("Std_Undo");
    expect(map.get("Ctrl+Y")).toContain("Std_Redo");
    expect(map.get("V F")).toContain("Std_ViewFitAll");
    expect(map.get("0")).toContain("Std_ViewIsometric");
    for (const [key, id] of [
      ["1", "Std_ViewFront"],
      ["2", "Std_ViewTop"],
      ["3", "Std_ViewRight"],
      ["4", "Std_ViewRear"],
      ["5", "Std_ViewBottom"],
      ["6", "Std_ViewLeft"],
    ] as const)
      expect(map.get(key)).toContain(id);
    expect(map.get("Space")).toContain("Std_ToggleVisibility");
    expect(map.get("Del")).toContain("Std_Delete");
    expect(map.get("V 3")).toContain("Std_DrawStyleWireframe");
    expect(map.get("Shift+Left")).toContain("Std_ViewRotateLeft");
    expect(map.get("Home")).toContain("Std_ViewHome");
  });
});

describe("workbenches", () => {
  test("FreeCAD's menu order, with the workbench menus before Windows", () => {
    expect(workbench("PartWorkbench").menus.map((m) => m.title)).toEqual([
      "&File",
      "&Edit",
      "&View",
      "&Tools",
      "&Macro",
      "&Part",
      "&Windows",
      "&Help",
    ]);
    expect(workbench("PartDesignWorkbench").menus.map((m) => m.title)).toEqual([
      "&File",
      "&Edit",
      "&View",
      "&Tools",
      "&Macro",
      "&Sketch",
      "&Part Design",
      "&Windows",
      "&Help",
    ]);
    expect(workbench("SketcherWorkbench").menus.map((m) => m.title)).toContain("S&ketch");
    expect(workbench("PartWorkbench").menus[0]!.items.slice(0, 3)).toEqual(["Std_New", "Std_Open", "Std_RecentFiles"]);
  });

  test("toolbars", () => {
    const names = workbench("PartWorkbench").toolbars.map((t) => t.name);
    expect(names).toEqual(["File", "Edit", "Workbench", "View", "Structure", "Solids", "Part Tools", "Boolean Tools"]);
    expect(
      workbench("PartWorkbench")
        .toolbars.find((t) => t.name === "Solids")!
        .items.slice(0, 5),
    ).toEqual(["Part_Box", "Part_Cylinder", "Part_Sphere", "Part_Cone", "Part_Torus"]);
    const edit = effectiveLayout("PartDesignWorkbench", true);
    expect(edit.toolbars.map((t) => t.name)).toContain("Geometries");
    expect(edit.menus.map((m) => m.title)).toContain("S&ketch");
  });
});

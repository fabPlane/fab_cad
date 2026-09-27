/**
 * The stores and command actions against the in-page mock FreeCAD (the same stack `?mock=1`
 * runs): documents, object creation with FreeCAD's echo, property edits as one undo step,
 * undo/redo, deletion, selection, console.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connectBackend } from "../src/backend/connect";
import { deleteObjects, editExpression, editProperty, newDocument, redo, setVisibility, undo } from "../src/commands/actions";
import { makeContext } from "../src/commands/context";
import { registerAllCommands } from "../src/commands/index";
import { runCommand } from "../src/commands/registry";
import { useApp } from "../src/state/app";
import { echo, useConsole } from "../src/state/console";
import { selectionEcho, useSelection } from "../src/state/selection";
import { attachConnection, disconnect, objects, property, refreshUndo, useSession } from "../src/state/session";
import { runConsoleCode, needsMoreInput } from "../src/ui/Output";

registerAllCommands();

const echoes = () =>
  useConsole
    .getState()
    .lines.filter((l) => l.kind === "echo")
    .map((l) => l.text);

beforeEach(async () => {
  useConsole.setState({ lines: [], report: [], history: [] });
  useSelection.setState({ selection: [], preselection: null });
  useApp.setState({ activeDoc: null, openTabs: [], startTab: true, task: null, editing: null });
  const c = await connectBackend({ kind: "mock", demo: false });
  attachConnection(c, { kind: "mock", demo: false });
});

afterEach(async () => {
  await disconnect();
});

describe("documents and objects", () => {
  test("File > New creates a document, opens its tab and echoes App.newDocument()", async () => {
    const doc = await newDocument();
    expect(doc).toBe("Unnamed");
    expect(useApp.getState().activeDoc).toBe("Unnamed");
    expect(useApp.getState().openTabs).toContain("Unnamed");
    expect(echoes()).toEqual(["App.newDocument()"]);
    expect(useSession.getState().status).toBe("connected");
  });

  test("Part_Box: one undo step named like FreeCAD's, the label 'Cube', FreeCAD's echo", async () => {
    await newDocument();
    await runCommand("Part_Box", makeContext());
    const box = objects("Unnamed").find((o) => o.type === "Part::Box")!;
    expect(box.name).toBe("Box");
    expect(box.label).toBe("Cube");
    expect(echoes()).toContain('App.ActiveDocument.addObject("Part::Box","Box")');
    expect(echoes()).toContain('App.ActiveDocument.ActiveObject.Label = "Cube"');
    await refreshUndo("Unnamed");
    expect(useSession.getState().undo.Unnamed?.undo[0]).toBe("Cube");
    // the new object is selected, like after FreeCAD's command
    expect(useSelection.getState().selection).toEqual([{ doc: "Unnamed", object: "Box", sub: "" }]);
  });

  test("a property edit is one transaction 'Edit Box.Length' with a recompute; undo and redo restore it", async () => {
    await newDocument();
    await runCommand("Part_Box", makeContext());
    await editProperty("Unnamed", "Box", "Length", { $type: "Quantity", value: 25.4, unit: "mm" }, "'25.40 mm'");
    expect(property("Unnamed", "Box", "Length")?.value).toMatchObject({ value: 25.4 });
    expect(echoes()).toContain("FreeCAD.getDocument('Unnamed').getObject('Box').Length = '25.40 mm'");
    await refreshUndo("Unnamed");
    expect(useSession.getState().undo.Unnamed?.undo[0]).toBe("Edit Box.Length");
    await undo("Unnamed");
    expect(property("Unnamed", "Box", "Length")?.value).toMatchObject({ value: 10 });
    expect(useSession.getState().undo.Unnamed?.redo[0]).toBe("Edit Box.Length");
    await redo("Unnamed");
    expect(property("Unnamed", "Box", "Length")?.value).toMatchObject({ value: 25.4 });
  });

  test("expressions bind with setExpression and show on the property", async () => {
    await newDocument();
    await runCommand("Part_Box", makeContext());
    await editExpression("Unnamed", "Box", "Height", "Length * 2");
    const h = property("Unnamed", "Box", "Height")!;
    expect(h.expression).toBe("Length * 2");
    expect(h.value).toMatchObject({ value: 20 });
    expect(echoes().at(-1)).toBe("FreeCAD.getDocument('Unnamed').getObject('Box').setExpression('Height', u'Length * 2')");
  });

  test("visibility and deletion", async () => {
    await newDocument();
    await runCommand("Part_Box", makeContext());
    await runCommand("Part_Cylinder", makeContext());
    await setVisibility("Unnamed", ["Box"], "toggle");
    expect(objects("Unnamed").find((o) => o.name === "Box")?.visibility).toBe(false);
    useSelection.getState().select({ doc: "Unnamed", object: "Cylinder", sub: "" });
    await runCommand("Std_Delete", makeContext());
    expect(objects("Unnamed").map((o) => o.name)).toEqual(["Box"]);
    expect(echoes()).toContain("App.getDocument('Unnamed').removeObject('Cylinder')");
    expect(useSelection.getState().selection).toEqual([]);
    await deleteObjects("Unnamed", ["Box"]);
    expect(objects("Unnamed")).toEqual([]);
  });
});

describe("selection", () => {
  test("replace, add, toggle, and FreeCAD's commented selection echo", () => {
    const s = useSelection.getState();
    s.select({ doc: "D", object: "Box", sub: "Face1", point: [1, 2, 3] });
    expect(echoes().at(-1)).toBe("# Gui.Selection.addSelection('D','Box','Face1',1.0,2.0,3.0)");
    s.select({ doc: "D", object: "Box", sub: "Edge2" }, { add: true });
    expect(useSelection.getState().selection.map((x) => x.sub)).toEqual(["Face1", "Edge2"]);
    s.select({ doc: "D", object: "Box", sub: "Face1" }, { add: true, toggle: true });
    expect(useSelection.getState().selection.map((x) => x.sub)).toEqual(["Edge2"]);
    s.select({ doc: "D", object: "Cyl", sub: "" });
    expect(useSelection.getState().selection.map((x) => x.object)).toEqual(["Cyl"]);
    s.prune((_d, o) => o !== "Cyl");
    expect(useSelection.getState().selection).toEqual([]);
    expect(selectionEcho({ doc: "D", object: "Box", sub: "" })).toBe("# Gui.Selection.addSelection('D','Box','')");
  });
});

describe("console", () => {
  test("echo splits multi-line code into console lines", () => {
    echo("a = 1\nb = 2");
    expect(echoes()).toEqual(["a = 1", "b = 2"]);
  });

  test("code runs through RunPython; the mock refuses it and the error is shown", async () => {
    await runConsoleCode("1 + 1");
    const last = useConsole.getState().lines.at(-1)!;
    expect(last.kind).toBe("error");
  });

  test("blocks wait for an empty line, open brackets for their close", () => {
    expect(needsMoreInput(["x = 1"])).toBe(false);
    expect(needsMoreInput(["for i in range(3):"])).toBe(true);
    expect(needsMoreInput(["for i in range(3):", "    print(i)"])).toBe(true);
    expect(needsMoreInput(["for i in range(3):", "    print(i)", ""])).toBe(false);
    expect(needsMoreInput(["f(1,"])).toBe(true);
    expect(needsMoreInput(["f(1,", "2)"])).toBe(false);
    expect(needsMoreInput(['s = """abc'])).toBe(true);
    expect(needsMoreInput(["d = {'a': 1}  # a: comment"])).toBe(false);
  });
});

describe("server restarts", () => {
  test("a new server token reloads the model and resets selection, task and edit mode", async () => {
    await disconnect();
    const { createMockDispatcher } = await import("@fab-cad/mock-server");
    const { FreeCADClient, DocumentStore, WasmTransport } = await import("@fab-cad/client");
    let current = createMockDispatcher({ token: "first" });
    // an instance whose FreeCAD can be swapped underneath, like a restarted server
    const listeners = new Set<(b: Uint8Array) => void>();
    const hook = (d: typeof current) => d.onEvent((b) => listeners.forEach((l) => l(b)));
    let off = hook(current);
    const instance = {
      dispatch: (req: Uint8Array) => current.dispatch(req),
      onEvent: (cb: (b: Uint8Array) => void) => (listeners.add(cb), () => listeners.delete(cb)),
      shutdown: () => current.shutdown(),
    };
    const client = await FreeCADClient.connect(new WasmTransport(instance));
    const store = new DocumentStore(client, { debounceMs: 5 });
    await store.load();
    attachConnection(
      {
        kind: "mock",
        description: "swappable mock",
        client,
        store,
        serverInfo: null,
        close: async () => (store.dispose(), await client.close()),
      },
      { kind: "mock", demo: false },
    );
    await newDocument();
    await runCommand("Part_Box", makeContext());
    expect(objects("Unnamed").length).toBe(1);
    useSelection.getState().select({ doc: "Unnamed", object: "Box", sub: "Face1" });
    useApp.getState().openTask({ id: "t", title: "T", render: () => null, accept: () => undefined, reject: () => undefined });
    useApp.getState().setEditing({ doc: "Unnamed", object: "Box", kind: "sketch" });

    // FreeCAD restarts: a fresh instance with another token and no documents
    off();
    current = createMockDispatcher({ token: "second" });
    off = hook(current);
    await client.ping().catch(() => undefined); // TOKEN_MISMATCH: the client pins the new token
    await new Promise((r) => setTimeout(r, 50));
    await store.flush();

    expect(useSelection.getState().selection).toEqual([]);
    expect(useApp.getState().task).toBeNull();
    expect(useApp.getState().editing).toBeNull();
    expect(store.documents()).toEqual([]);
    expect(useConsole.getState().report.some((r) => r.kind === "warning" && r.text.includes("FreeCAD restarted"))).toBe(true);
    // the page keeps working against the new server
    const doc = await newDocument();
    expect(store.document(doc)).toBeDefined();
    off();
  });
});

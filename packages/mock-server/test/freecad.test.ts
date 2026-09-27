import { beforeEach, describe, expect, test } from "bun:test";
import {
  decodeTessellation,
  type CommandName,
  type EventMessage,
  type ParamsOf,
  type PropertyInfo,
  type ResultOf,
  type WireQuantity,
} from "@fab-cad/protocol";
import { ApiFailure, MockFreeCAD } from "../src/freecad";

/** Drive the core directly: returns the result or throws an `ApiFailure` with the status. */
function harness(fc = new MockFreeCAD()) {
  let id = 0;
  const events: EventMessage[] = [];
  fc.onEvent((e) => events.push(e));
  const call = <K extends CommandName>(cmd: K, params?: ParamsOf<K>, client?: string): ResultOf<K> => {
    const { response, events: evs } = fc.handle({ id: ++id, cmd, params, client });
    fc.publish(evs);
    if (response.status !== "OK") throw new ApiFailure(response.status, response.error);
    return response.result as ResultOf<K>;
  };
  const status = (cmd: string, params?: object) => fc.handle({ id: ++id, cmd, params }).response.status;
  return { fc, call, status, events };
}

const qv = (p: PropertyInfo | undefined) => (p?.value as WireQuantity).value;

describe("MockFreeCAD", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  test("server commands", () => {
    expect(h.call("Ping")).toBeNull();
    expect(h.call("GetVersion").api).toBe(1);
    expect(h.call("GetServerInfo").token).toBe(h.fc.token);
    expect(h.call("GetCommands").map((c) => c.name)).toContain("Tessellate");
    expect(h.call("GetTypes", { base: "Part::Primitive" })).toEqual(["Part::Box", "Part::Cylinder", "Part::Sphere"]);
    expect(h.call("GetTypes", {})).toEqual(["App::DocumentObjectGroup", "Part::Box", "Part::Cylinder", "Part::Sphere"]);
    expect(h.status("GetTypes", { base: "Nope::Nothing" })).toBe("NOT_FOUND");
    expect(h.call("LoadModule", { name: "Part" })).toBeNull();
    expect(h.status("LoadModule", { name: "Nope" })).toBe("FAILED");
    expect(h.status("RunPython", { code: "1" })).toBe("FORBIDDEN");
    expect(h.status("Frobnicate")).toBe("UNKNOWN_COMMAND");
    expect(h.fc.handle({ id: 1 }).response.status).toBe("BAD_REQUEST");
    expect(h.fc.handle({ id: 1, cmd: "Ping", token: "wrong" }).response.status).toBe("TOKEN_MISMATCH");
    expect(h.fc.handle({ id: 1, cmd: "Ping", token: h.fc.token }).response.status).toBe("OK");
  });

  test("documents: create, name uniqueness, active, close", () => {
    const a = h.call("NewDocument", {});
    const b = h.call("NewDocument", { label: "Second" });
    expect(a.name).toBe("Unnamed");
    expect(b.name).toBe("Unnamed1");
    expect(b.label).toBe("Second");
    expect(h.call("ListDocuments").map((d) => [d.name, d.active])).toEqual([
      ["Unnamed", false],
      ["Unnamed1", true],
    ]);
    h.call("SetActiveDocument", { doc: "Unnamed" });
    h.call("CloseDocument", { doc: "Unnamed" });
    expect(h.call("ListDocuments")[0]!.active).toBe(true);
    expect(h.status("GetObjects", { doc: "Unnamed" })).toBe("NOT_FOUND");
    expect(h.events.map((e) => e.event)).toEqual([
      "DocumentCreated",
      "ActiveDocumentChanged",
      "DocumentCreated",
      "ActiveDocumentChanged",
      "ActiveDocumentChanged",
      "DocumentDeleted",
      "ActiveDocumentChanged",
    ]);
    expect(h.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("objects: add with properties, names, labels, groups", () => {
    const doc = h.call("NewDocument", { name: "D" }).name;
    const g = h.call("AddObject", { doc, type: "App::DocumentObjectGroup" });
    const box = h.call("AddObject", { doc, type: "Part::Box", group: g.name, properties: { Length: "25.4 mm", Width: 5 } });
    const box2 = h.call("AddObject", { doc, type: "Part::Box" });
    expect([g.name, box.name, box2.name]).toEqual(["Group", "Box", "Box001"]);
    expect(box2.label).toBe("Box001");
    expect(box.typeHierarchy[0]).toBe("Part::Box");
    expect(box.typeHierarchy).toContain("App::DocumentObject");
    expect(box.typeHierarchy.at(-1)).toBe("Base::Persistence");
    expect(box.isTouched).toBe(true);
    expect(box.status).toBe("Touched");
    const props = h.call("GetProperties", { doc, object: "Box" });
    expect(qv(props.find((p) => p.name === "Length"))).toBeCloseTo(25.4);
    expect(qv(props.find((p) => p.name === "Width"))).toBe(5);
    expect(props.find((p) => p.name === "Length")!.unit).toBe("mm");
    const infos = h.call("GetObjects", { doc });
    expect(infos.find((o) => o.name === "Group")!.children).toEqual(["Box"]);
    expect(infos.find((o) => o.name === "Box")!.parents).toEqual(["Group"]);
    expect(infos.find((o) => o.name === "Box")!.inList).toEqual(["Group"]);
    expect(h.status("AddObject", { doc, type: "Part::Nope" })).toBe("FAILED");
    expect(h.status("AddObject", { doc, type: "Part::Feature" })).toBe("FAILED");
    expect(h.status("AddObject", { doc })).toBe("BAD_REQUEST");
    const withObj = h.call("GetObject", { doc, object: "Box", properties: true });
    expect(withObj.properties!.map((p) => p.name)).toContain("Placement");
  });

  test("SetProperties coercions and errors", () => {
    const doc = h.call("NewDocument", {}).name;
    h.call("AddObject", { doc, type: "Part::Box" });
    const changed = h.call("SetProperties", {
      doc,
      object: "Box",
      values: {
        Length: "1 in",
        Height: { $type: "Quantity", value: 2, unit: "cm" },
        Placement: { $type: "Placement", base: [1, 2, 3], rotation: { $type: "Rotation", axis: [0, 0, 1], angle: 90 } } as never,
        Width: { $type: "Quantity", text: "2 cm" } as never,
        Label: "My box",
      },
    });
    expect(changed.map((p) => p.name)).toEqual(["Length", "Height", "Placement", "Width", "Label"]);
    expect(qv(changed[3])).toBeCloseTo(20);
    expect(changed[2]!.value).toMatchObject({ axis: [0, 0, 1] });
    expect((changed[2]!.value as { angle: number }).angle).toBeCloseTo(90);
    expect(qv(changed[0])).toBeCloseTo(25.4);
    expect(qv(changed[1])).toBeCloseTo(20);
    const rot = (changed[2]!.value as { rotation: number[] }).rotation;
    expect(rot[2]).toBeCloseTo(Math.SQRT1_2);
    expect(rot[3]).toBeCloseTo(Math.SQRT1_2);
    expect(h.status("SetProperties", { doc, object: "Box", values: { Length: -1 } })).toBe("FAILED");
    expect(h.status("SetProperties", { doc, object: "Box", values: { Length: "3 deg" } })).toBe("FAILED");
    expect(h.status("SetProperties", { doc, object: "Box", values: { Nope: 1 } })).toBe("NOT_FOUND");
    expect(h.status("SetProperties", { doc, object: "Box", values: { Shape: 1 } })).toBe("FAILED");
    // failed requests change nothing (atomic)
    expect(h.status("SetProperties", { doc, object: "Box", values: { Width: 3, Length: -1 } })).toBe("FAILED");
    expect(qv(h.call("GetProperties", { doc, object: "Box", names: ["Width"] })[0])).toBe(20);
    const cyl = h.call("AddObject", { doc, type: "Part::Cylinder" }).name;
    const angle = h.call("GetProperties", { doc, object: cyl, names: ["Angle"] })[0]!;
    expect(angle).toMatchObject({ unit: "deg", value: { unit: "deg", text: "360 °" } });
  });

  test("ObjectChanged is coalesced per request and carries the client", () => {
    const doc = h.call("NewDocument", {}).name;
    h.call("AddObject", { doc, type: "Part::Box" });
    h.events.length = 0;
    h.call("SetProperties", { doc, object: "Box", values: { Length: 11, Width: 12 } }, "tab-1");
    const changed = h.events.filter((e) => e.event === "ObjectChanged");
    expect(changed.map((e) => (e.data as { property: string }).property)).toEqual(["Length", "Width"]);
    expect(changed.every((e) => e.data.client === "tab-1")).toBe(true);
    expect(h.events[0]!.event).toBe("TransactionOpened");
    expect(h.events.at(-1)!.event).toBe("TransactionCommitted");
  });

  test("recompute builds shapes; tessellation is real and revisioned", () => {
    const doc = h.call("NewDocument", {}).name;
    h.call("AddObject", { doc, type: "Part::Box", properties: { Length: 20, Width: 10, Height: 5 } });
    h.call("AddObject", { doc, type: "Part::Cylinder" });
    h.call("AddObject", { doc, type: "Part::Sphere" });
    expect(h.call("Tessellate", { doc })).toEqual([]); // no shapes before the first recompute
    const r = h.call("Recompute", { doc });
    expect(r).toEqual({ recomputed: 3, errors: [] });
    const tess = h.call("Tessellate", { doc }).map((t) => decodeTessellation(t));
    const box = tess.find((t) => t.object === "Box")!;
    expect(box.faceCount).toBe(6);
    expect(box.edgeCount).toBe(12);
    expect(box.deflection).toBeGreaterThan(0);
    expect(box.placement!.base.x).toBe(0);
    expect(box.vertices.length).toBe(24);
    expect(box.triangleCount).toBe(12);
    expect(Math.max(...box.positions.filter((_, i) => i % 3 === 0))).toBe(20);
    const cyl = tess.find((t) => t.object === "Cylinder")!;
    expect(cyl.faceCount).toBe(3);
    expect(cyl.edgeCount).toBe(3);
    const sph = tess.find((t) => t.object === "Sphere")!;
    expect(sph.faceCount).toBe(1);
    for (let i = 0; i < sph.positions.length; i += 3) {
      expect(Math.hypot(sph.positions[i]!, sph.positions[i + 1]!, sph.positions[i + 2]!)).toBeCloseTo(5, 4);
    }
    for (const t of tess) {
      expect(t.faces[t.faces.length - 2]! + t.faces[t.faces.length - 1]!).toBe(t.triangleCount);
      for (const ix of t.indices) expect(ix).toBeLessThan(t.vertexCount);
    }

    // revision changes with the shape, and only then
    const rev0 = box.revision;
    h.call("Recompute", { doc, force: true });
    expect(decodeTessellation(h.call("Tessellate", { doc, objects: ["Box"] })[0]!).revision).toBe(rev0);
    h.call("SetProperties", { doc, object: "Box", values: { Length: 30 } });
    expect(h.call("GetObject", { doc, object: "Box" }).isTouched).toBe(true);
    h.call("Recompute", { doc });
    const box2 = decodeTessellation(h.call("Tessellate", { doc, objects: ["Box"] })[0]!);
    expect(box2.revision).not.toBe(rev0);
    expect(h.call("GetBoundingBox", { doc, objects: ["Box"] })).toEqual({ min: [0, 0, 0], max: [30, 10, 5] });

    // placement moves the shape without a recompute, in the global frame
    h.call("SetProperties", {
      doc,
      object: "Box",
      values: { Placement: { $type: "Placement", base: [100, 0, 0], rotation: [0, 0, 0, 1] } },
    });
    const moved = decodeTessellation(h.call("Tessellate", { doc, objects: ["Box"] })[0]!);
    expect(moved.revision).not.toBe(box2.revision);
    expect(Math.min(...moved.positions.filter((_, i) => i % 3 === 0))).toBe(100);
    const noEdges = decodeTessellation(h.call("Tessellate", { doc, objects: ["Box"], edges: false })[0]!);
    expect([noEdges.edgeCount, noEdges.edgePositions.length, noEdges.vertices.length]).toEqual([0, 0, 0]);
    // a finer deflection gives more triangles on curved faces
    const coarse = decodeTessellation(h.call("Tessellate", { doc, objects: ["Sphere"], deflection: 0.5 })[0]!);
    const fine = decodeTessellation(h.call("Tessellate", { doc, objects: ["Sphere"], deflection: 0.001 })[0]!);
    expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount);
    expect(coarse.deflection).toBe(0.5);
  });

  test("recompute errors", () => {
    const doc = h.call("NewDocument", {}).name;
    h.call("AddObject", { doc, type: "Part::Box", properties: { Length: 0 } });
    const r = h.call("Recompute", { doc });
    expect(r.errors).toEqual([{ object: "Box", message: "Length of box too small" }]);
    const info = h.call("GetObject", { doc, object: "Box" });
    expect(info.isError).toBe(true);
    expect(info.isValid).toBe(false);
    expect(info.status).toBe("Length of box too small");
  });

  test("expressions drive values on recompute", () => {
    const doc = h.call("NewDocument", {}).name;
    h.call("AddObject", { doc, type: "Part::Box" });
    h.call("AddObject", { doc, type: "Part::Cylinder", label: "Pin" });
    h.call("SetExpression", { doc, object: "Box", path: "Width", expression: "Length * 2" });
    h.call("SetExpression", { doc, object: "Cylinder", path: "Height", expression: "Box.Width + 1 mm" });
    h.call("Recompute", { doc });
    expect(qv(h.call("GetProperties", { doc, object: "Box", names: ["Width"] })[0])).toBe(20);
    expect(qv(h.call("GetProperties", { doc, object: "Cylinder", names: ["Height"] })[0])).toBe(21);
    expect(h.call("GetObject", { doc, object: "Cylinder" }).outList).toEqual(["Box"]);
    h.call("SetProperties", { doc, object: "Box", values: { Length: 5 } });
    h.call("Recompute", { doc });
    expect(qv(h.call("GetProperties", { doc, object: "Cylinder", names: ["Height"] })[0])).toBe(11);
    expect(h.call("GetProperties", { doc, object: "Box", names: ["Width"] })[0]!.expression).toBe("Length * 2");
    expect(h.status("SetExpression", { doc, object: "Box", path: "Width", expression: "Length *" })).toBe("FAILED");
    h.call("SetExpression", { doc, object: "Box", path: "Width", expression: null });
    expect(h.call("GetProperties", { doc, object: "Box", names: ["Width"] })[0]!.expression).toBeUndefined();
  });

  test("undo / redo with automatic and explicit transactions", () => {
    const doc = h.call("NewDocument", {}).name;
    h.call("AddObject", { doc, type: "Part::Box" });
    h.call("SetProperties", { doc, object: "Box", values: { Length: 42 } });
    expect(h.call("GetUndoStack", { doc })).toEqual({ undo: ["Edit Box", "Create Box"], redo: [] });

    h.events.length = 0;
    expect(h.call("Undo", { doc })).toEqual({ undo: ["Create Box"], redo: ["Edit Box"] });
    expect(qv(h.call("GetProperties", { doc, object: "Box", names: ["Length"] })[0])).toBe(10);
    expect(h.events.map((e) => e.event)).toEqual(["ObjectChanged", "Undo"]);
    h.call("Redo", { doc });
    expect(qv(h.call("GetProperties", { doc, object: "Box", names: ["Length"] })[0])).toBe(42);
    h.call("Undo", { doc });
    h.call("Undo", { doc });
    expect(h.call("GetObjects", { doc })).toEqual([]);
    expect(h.status("Undo", { doc })).toBe("FAILED");
    h.call("Redo", { doc });
    expect(h.call("GetObjects", { doc }).length).toBe(1);

    // a new edit clears the redo stack
    h.call("SetProperties", { doc, object: "Box", values: { Height: 3 } });
    expect(h.call("GetUndoStack", { doc }).redo).toEqual([]);

    // explicit transaction groups several commands
    h.call("OpenTransaction", { doc, name: "Two boxes" });
    h.call("AddObject", { doc, type: "Part::Box" });
    h.call("AddObject", { doc, type: "Part::Box" });
    h.call("CommitTransaction", { doc });
    expect(h.call("GetUndoStack", { doc }).undo[0]).toBe("Two boxes");
    h.call("Undo", { doc });
    expect(h.call("GetObjects", { doc }).length).toBe(1);

    // abort rolls back
    h.call("OpenTransaction", { doc, name: "Oops" });
    h.call("RemoveObject", { doc, object: "Box" });
    h.call("AbortTransaction", { doc });
    expect(h.call("GetObjects", { doc }).length).toBe(1);
    expect(h.call("ListDocuments")[0]!.undoCount).toBe(2);
  });

  test("undo restores the shape revision (so a client cache stays valid)", () => {
    const doc = h.call("NewDocument", {}).name;
    h.call("AddObject", { doc, type: "Part::Box" });
    h.call("Recompute", { doc });
    const rev1 = h.call("Tessellate", { doc })[0]!.revision;
    h.call("SetProperties", { doc, object: "Box", values: { Length: 3 } });
    h.call("Recompute", { doc });
    const rev2 = h.call("Tessellate", { doc })[0]!.revision;
    expect(rev2).not.toBe(rev1);
    h.call("Undo", { doc });
    expect(h.call("Tessellate", { doc })[0]!.revision).toBe(rev1);
  });

  test("remove, recursive remove and dynamic properties", () => {
    const doc = h.call("NewDocument", {}).name;
    const g = h.call("AddObject", { doc, type: "App::DocumentObjectGroup" }).name;
    h.call("AddObject", { doc, type: "Part::Box", group: g });
    h.call("AddObject", { doc, type: "Part::Sphere", group: g });
    h.call("RemoveObject", { doc, object: "Box" });
    expect(h.call("GetObject", { doc, object: g }).children).toEqual(["Sphere"]);
    h.call("RemoveObject", { doc, object: g, recursive: true });
    expect(h.call("GetObjects", { doc })).toEqual([]);

    h.call("AddObject", { doc, type: "Part::Box" });
    const p = h.call("AddProperty", {
      doc,
      object: "Box",
      type: "App::PropertyLength",
      name: "Clearance",
      group: "Fit",
      documentation: "gap",
    });
    expect(p).toMatchObject({ name: "Clearance", group: "Fit", doc: "gap", status: ["Dynamic"], unit: "mm" });
    h.call("SetProperties", { doc, object: "Box", values: { Clearance: "0.2 mm" } });
    expect(h.status("AddProperty", { doc, object: "Box", type: "App::PropertyLength", name: "Clearance" })).toBe("FAILED");
    expect(h.status("AddProperty", { doc, object: "Box", type: "App::PropertyNope", name: "X" })).toBe("FAILED");
    expect(h.status("RemoveProperty", { doc, object: "Box", name: "Length" })).toBe("FAILED");
    h.call("RemoveProperty", { doc, object: "Box", name: "Clearance" });
    expect(h.status("GetProperties", { doc, object: "Box", names: ["Clearance"] })).toBe("NOT_FOUND");
  });

  test("save and reopen as bytes; export", () => {
    const doc = h.call("NewDocument", { name: "Part" }).name;
    h.call("AddObject", { doc, type: "Part::Box", properties: { Length: 7 } });
    h.call("Recompute", { doc });
    const { data, fileName } = h.call("SaveDocumentBytes", { doc });
    expect(fileName).toBe("Part.FCStd");
    const reopened = h.call("OpenDocumentBytes", { data, fileName });
    expect(reopened.name).toBe("Part1");
    expect(reopened.objectCount).toBe(1);
    expect(qv(h.call("GetProperties", { doc: reopened.name, object: "Box", names: ["Length"] })[0])).toBe(7);
    expect(h.status("OpenDocumentBytes", { data: new Uint8Array([0x50, 0x4b, 3, 4]) })).toBe("FAILED");
    expect(h.status("SaveDocument", { doc })).toBe("FAILED"); // no file name, no fs

    const stl = new TextDecoder().decode(h.call("Export", { doc, objects: ["Box"], format: "stl" }).data);
    expect(stl.match(/facet normal/g)!.length).toBe(12);
    expect(h.status("Export", { doc, objects: ["Box"], format: "step" })).toBe("FAILED");
  });

  test("file system backed save / open", () => {
    const files = new Map<string, Uint8Array>();
    const hh = harness(new MockFreeCAD({ fs: { readFile: (p) => files.get(p)!, writeFile: (p, d) => void files.set(p, d) } }));
    const doc = hh.call("NewDocument", {}).name;
    hh.call("AddObject", { doc, type: "Part::Box" });
    expect(hh.call("ListDocuments")[0]!.modified).toBe(true);
    const saved = hh.call("SaveDocumentAs", { doc, path: "/tmp/x.FCStd" });
    expect(saved).toMatchObject({ fileName: "/tmp/x.FCStd", modified: false });
    expect(hh.events.at(-1)).toMatchObject({ event: "DocumentSaved", data: { doc, fileName: "/tmp/x.FCStd" } });
    const opened = hh.call("OpenDocument", { path: "/tmp/x.FCStd" });
    expect(opened.objectCount).toBe(1);
  });

  test("demo document", () => {
    const d = harness(new MockFreeCAD({ demo: true }));
    const docs = d.call("ListDocuments");
    expect(docs).toMatchObject([{ name: "Demo", objectCount: 4, undoCount: 0, modified: false, active: true }]);
    expect(d.call("GetObjects", { doc: "Demo" }).map((o) => o.name)).toEqual(["Parts", "Box", "Cylinder", "Sphere"]);
    expect(d.call("Tessellate", { doc: "Demo" }).length).toBe(3);
  });
});

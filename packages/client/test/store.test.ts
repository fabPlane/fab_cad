import { beforeEach, describe, expect, test } from "bun:test";
import { createMockDispatcher, type MockDispatcher } from "@fab-cad/mock-server";
import type { WireQuantity } from "@fab-cad/protocol";
import { FreeCADClient } from "../src/client";
import { DocumentStore, type StoreChange } from "../src/store/document-store";
import { TessellationCache } from "../src/store/tessellation-cache";
import { WasmTransport } from "../src/transport/wasm";

const len = (v: unknown) => (v as WireQuantity).value;

describe("DocumentStore", () => {
  let mock: MockDispatcher;
  let client: FreeCADClient;
  let other: FreeCADClient;
  let store: DocumentStore;
  let changes: StoreChange[];

  beforeEach(async () => {
    mock = createMockDispatcher({ demo: true });
    client = new FreeCADClient(new WasmTransport(mock, { ownsInstance: false }), { clientName: "ui" });
    // a second client on the same FreeCAD: the store must follow changes it did not make
    other = new FreeCADClient(new WasmTransport(createMockDispatcher({ freecad: mock.freecad }), { ownsInstance: false }), {
      clientName: "script",
    });
    store = new DocumentStore(client, { debounceMs: 1 });
    await store.load();
    changes = [];
    store.subscribe((c) => changes.push(c));
  });

  test("load() mirrors documents, objects in order, and properties", () => {
    expect(store.documents().map((d) => d.name)).toEqual(["Demo"]);
    expect(store.activeDocument()?.name).toBe("Demo");
    expect(store.objects("Demo").map((o) => o.name)).toEqual(["Parts", "Box", "Cylinder", "Sphere"]);
    expect(store.roots("Demo").map((o) => o.name)).toEqual(["Parts"]);
    expect(len(store.property("Demo", "Box", "Length")?.value)).toBe(10);
    expect(store.properties("Demo", "Cylinder").map((p) => p.name)).toContain("Radius");
  });

  test("ObjectChanged refetches the changed property and the object's info", async () => {
    await other.setProperties("Demo", "Box", { Length: 42, Label: "Big box" });
    await store.flush();
    expect(len(store.property("Demo", "Box", "Length")?.value)).toBe(42);
    expect(store.object("Demo", "Box")?.label).toBe("Big box");
    expect(store.object("Demo", "Box")?.isTouched).toBe(true);
    const objChange = changes.find((c) => c.kind === "object" && c.object === "Box");
    expect(objChange).toMatchObject({ properties: expect.arrayContaining(["Length", "Label"]) });
    expect(store.documents()[0]!.undoCount).toBe(1); // transaction events refresh the document
  });

  test("ObjectCreated / ObjectDeleted keep order and the tree current", async () => {
    await other.addObject("Demo", "Part::Box", { group: "Parts" });
    await store.flush();
    expect(store.objects("Demo").map((o) => o.name)).toEqual(["Parts", "Box", "Cylinder", "Sphere", "Box001"]);
    expect(store.object("Demo", "Parts")?.children).toContain("Box001");
    expect(store.properties("Demo", "Box001").length).toBeGreaterThan(0);

    await other.removeObject("Demo", "Cylinder");
    await store.flush();
    expect(store.objects("Demo").map((o) => o.name)).toEqual(["Parts", "Box", "Sphere", "Box001"]);
    expect(store.object("Demo", "Parts")?.children).not.toContain("Cylinder");
    expect(changes).toContainEqual({ kind: "objectRemoved", doc: "Demo", object: "Cylinder" });
  });

  test("undo / redo bring the mirror back", async () => {
    await other.setProperties("Demo", "Box", { Length: 5 });
    await other.addObject("Demo", "Part::Sphere");
    await store.flush();
    await other.undo("Demo");
    await store.flush();
    expect(store.object("Demo", "Sphere001")).toBeUndefined();
    await other.undo("Demo");
    await store.flush();
    expect(len(store.property("Demo", "Box", "Length")?.value)).toBe(10);
    await other.redo("Demo");
    await store.flush();
    expect(len(store.property("Demo", "Box", "Length")?.value)).toBe(5);
    expect(store.documents()[0]).toMatchObject({ undoCount: 1, redoCount: 1 });
  });

  test("documents come and go", async () => {
    const d = await other.newDocument({ label: "Second" });
    await other.addObject(d.name, "Part::Cylinder");
    await store.flush();
    expect(store.documents().map((x) => [x.name, x.active])).toEqual([
      ["Demo", false],
      ["Unnamed", true],
    ]);
    expect(store.objects("Unnamed").map((o) => o.name)).toEqual(["Cylinder"]);
    await other.closeDocument("Unnamed");
    await store.flush();
    expect(store.document("Unnamed")).toBeUndefined();
    expect(changes).toContainEqual({ kind: "documentRemoved", doc: "Unnamed" });
  });

  test("a burst of events is one refetch per object (debounced)", async () => {
    const calls: string[] = [];
    const orig = client.call.bind(client);
    client.call = ((cmd: never, params: never, opts: never) => {
      calls.push(cmd);
      return orig(cmd, params, opts);
    }) as typeof client.call;
    await other.setProperties("Demo", "Box", { Length: 1, Width: 2, Height: 3 });
    await other.setProperties("Demo", "Box", { Length: 4 });
    await store.flush();
    expect(calls.filter((c) => c === "GetProperties").length).toBe(1);
    expect(calls.filter((c) => c === "GetObject").length).toBe(1);
    expect(len(store.property("Demo", "Box", "Height")?.value)).toBe(3);
  });

  test("tessellations are cached by revision and refetched only when stale", async () => {
    const calls: unknown[] = [];
    const orig = client.call.bind(client);
    client.call = ((cmd: string, params: never, opts: never) => {
      if (cmd === "Tessellate") calls.push((params as { objects?: string[] }).objects);
      return orig(cmd as never, params, opts);
    }) as typeof client.call;

    const first = await store.tessellate("Demo");
    expect(first.map((t) => t.object)).toEqual(["Box", "Cylinder", "Sphere"]);
    await store.tessellate("Demo");
    expect(calls).toEqual([["Box", "Cylinder", "Sphere"]]);

    await other.setProperties("Demo", "Box", { Length: 30 });
    await other.recompute("Demo");
    await store.flush();
    expect(store.isMeshStale("Demo", "Box")).toBe(true);
    expect(store.isMeshStale("Demo", "Sphere")).toBe(false);
    const second = await store.tessellate("Demo");
    expect(calls[1]).toEqual(["Box"]);
    const box = second.find((t) => t.object === "Box")!;
    expect(box.revision).not.toBe(first.find((t) => t.object === "Box")!.revision);
    expect(Math.max(...box.positions.filter((_, i) => i % 3 === 0))).toBe(30);
    expect(changes).toContainEqual({ kind: "tessellation", doc: "Demo", object: "Box" });

    // a placement change moves the mesh without a recompute
    await other.setProperties("Demo", "Sphere", { Placement: { $type: "Placement", base: [0, 0, 100], rotation: [0, 0, 0, 1] } });
    await store.flush();
    const moved = (await store.tessellate("Demo", ["Sphere"]))[0]!;
    expect(Math.min(...moved.positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(95, 3);

    // undo returns to a revision the cache still holds
    await other.undo("Demo");
    await store.flush();
    const before = store.cache.size;
    await store.tessellate("Demo", ["Sphere"]);
    expect(store.cache.size).toBe(before);
  });

  test("a server restart reloads everything", async () => {
    await store.tessellate("Demo");
    const reloaded = new Promise<void>((resolve) => store.subscribe((c) => c.kind === "reloaded" && resolve()));
    // simulate the restart: a reply carrying another token
    (client as unknown as { checkToken: (t: string, c: string) => void }).checkToken("new-token", "Ping");
    await reloaded;
    expect(store.cache.size).toBe(0);
    expect(store.objects("Demo").length).toBe(4);
  });
});

describe("TessellationCache", () => {
  const mesh = (object: string, revision: number) =>
    ({
      object,
      revision,
      placement: null,
      deflection: 0,
      positions: new Float32Array(),
      indices: new Uint32Array(),
      faces: new Uint32Array(),
      edges: new Uint32Array(),
      edgePositions: new Float32Array(),
      vertices: new Float32Array(),
      vertexCount: 0,
      triangleCount: 0,
      faceCount: 0,
      edgeCount: 0,
    }) as const;

  test("keys by (doc, object, revision), bounds revisions per object and entries overall", () => {
    const c = new TessellationCache({ maxEntries: 5, maxRevisionsPerObject: 2 });
    c.put("D", mesh("A", 1));
    c.put("D", mesh("A", 2));
    c.put("D", mesh("A", 3));
    expect(c.get("D", "A", 1)).toBeUndefined();
    expect(c.get("D", "A", 2)?.revision).toBe(2);
    expect(c.latest("D", "A")?.revision).toBe(3);
    for (const o of ["B", "C", "E", "F"]) c.put("D", mesh(o, 1));
    expect(c.size).toBe(5);
    c.evictObject("D", "F");
    expect(c.latest("D", "F")).toBeUndefined();
    c.evictDocument("D");
    expect(c.size).toBe(0);
  });
});

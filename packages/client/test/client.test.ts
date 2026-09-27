import { describe, expect, test } from "bun:test";
import { Placement, Quantity, Rotation, Vector } from "@fab-cad/protocol";
import { FreeCADClient, type RestartInfo } from "../src/client";
import { FreeCADApiError } from "../src/errors";
import { FakeTransport } from "./fake-transport";

describe("FreeCADClient", () => {
  test("pins the first reply's token and sends it afterwards", async () => {
    const t = new FakeTransport(() => ({ status: "OK", token: "T1", result: null }));
    const client = await FreeCADClient.connect(t, { clientName: "tab-9" });
    expect(client.token).toBe("T1");
    await client.ping();
    expect(t.requests.map((r) => r.token)).toEqual(["", "T1"]);
    expect(t.requests[1]).toMatchObject({ cmd: "Ping", params: {}, client: "tab-9" });
  });

  test("TOKEN_MISMATCH emits restarted, re-pins and throws", async () => {
    let token = "T1";
    const t = new FakeTransport((req) =>
      req.token && req.token !== token ? { status: "TOKEN_MISMATCH", token, error: "restarted" } : { status: "OK", token, result: null },
    );
    const client = await FreeCADClient.connect(t);
    const restarts: RestartInfo[] = [];
    client.onRestarted((i) => restarts.push(i));
    token = "T2";
    const err = await client.ping().catch((e) => e);
    expect(FreeCADApiError.is(err, "TOKEN_MISMATCH")).toBe(true);
    expect(restarts).toEqual([{ previousToken: "T1", newToken: "T2", command: "Ping" }]);
    await client.ping(); // works again with the new token
    expect(t.requests.at(-1)!.token).toBe("T2");
  });

  test("errors carry the status, command and server message", async () => {
    const t = new FakeTransport(() => ({ status: "NOT_FOUND", token: "T", error: "No object 'Nope'" }));
    const err = await new FreeCADClient(t).getObject("D", "Nope").catch((e) => e);
    expect(err).toBeInstanceOf(FreeCADApiError);
    expect(err).toMatchObject({ status: "NOT_FOUND", command: "GetObject", serverMessage: "No object 'Nope'" });
    expect(err.message).toBe("GetObject: NOT_FOUND - No object 'Nope'");
  });

  test("value classes are sent as wire values", async () => {
    const t = new FakeTransport(() => ({ status: "OK", token: "T", result: [] }));
    const client = new FreeCADClient(t, { encoding: "json" });
    await client.setProperties("D", "Box", {
      Placement: new Placement(new Vector(1, 2, 3), Rotation.fromAxisAngle([0, 0, 1], 90)),
      Length: new Quantity(5, "mm"),
      Height: "2 in",
    });
    const values = (t.requests[0]!.params as { values: Record<string, unknown> }).values;
    expect(values.Placement).toMatchObject({ $type: "Placement", base: [1, 2, 3] });
    expect(values.Length).toEqual({ $type: "Quantity", value: 5, unit: "mm", text: "5 mm" });
    expect(values.Height).toBe("2 in");
  });

  test("typed events, wildcard, next() and sequence gaps", async () => {
    const t = new FakeTransport(() => ({ status: "OK", token: "T", result: null }));
    const client = new FreeCADClient(t);
    const changed: string[] = [];
    const all: string[] = [];
    const gaps: [number, number][] = [];
    client.on("ObjectChanged", (d) => changed.push(`${d.object}.${d.property}`));
    client.on("*", (_d, m) => all.push(`${m.seq}:${m.event}`));
    client.onGap((g) => gaps.push([g.last, g.received]));
    const next = client.next("Recomputed");
    t.emit({ event: "ObjectChanged", seq: 1, data: { doc: "D", object: "Box", property: "Length" } });
    t.emit({ event: "Recomputed", seq: 2, data: { doc: "D" } }, "json");
    t.emit({ event: "ObjectChanged", seq: 5, data: { doc: "D", object: "Box", property: "Width" } });
    expect(await next).toEqual({ doc: "D" });
    expect(changed).toEqual(["Box.Length", "Box.Width"]);
    expect(all).toEqual(["1:ObjectChanged", "2:Recomputed", "5:ObjectChanged"]);
    expect(gaps).toEqual([[2, 5]]);
    expect(client.lastEventSeq).toBe(5);
  });

  test("transaction() commits on success and aborts on failure", async () => {
    const t = new FakeTransport((req) =>
      req.cmd === "RemoveObject" ? { status: "FAILED", token: "T", error: "no" } : { status: "OK", token: "T", result: null },
    );
    const client = new FreeCADClient(t);
    await client.transaction("D", "Edit", async () => client.ping());
    await expect(client.transaction("D", "Oops", () => client.removeObject("D", "Box"))).rejects.toBeInstanceOf(FreeCADApiError);
    expect(t.requests.map((r) => r.cmd)).toEqual([
      "OpenTransaction",
      "Ping",
      "CommitTransaction",
      "OpenTransaction",
      "RemoveObject",
      "AbortTransaction",
    ]);
  });

  test("one method per command sends the right envelope", async () => {
    const t = new FakeTransport(() => ({ status: "OK", token: "T", result: [] }));
    const c = new FreeCADClient(t);
    const data = new Uint8Array([1, 2]);
    await c.getTypes("Part::Feature");
    await c.openDocumentBytes(data, "a.FCStd");
    await c.recompute("D", true);
    await c.addObject("D", "Part::Box", { label: "L", group: "G", properties: { Length: 3 } });
    await c.addProperty("D", "Box", "App::PropertyFloat", "Weight", { group: "Mass", documentation: "kg" });
    await c.setExpression("D", "Box", "Width", null);
    await c.importFile("D", { data, fileName: "x.step" });
    await c.exportObjects("D", ["Box"], "stl");
    await c.runPython("1+1", "auto");
    await c.getBoundingBox("D", ["Box"]);
    expect(t.requests.map((r): unknown[] => [r.cmd, r.params])).toEqual([
      ["GetTypes", { base: "Part::Feature" }],
      ["OpenDocumentBytes", { data, fileName: "a.FCStd" }],
      ["Recompute", { doc: "D", force: true }],
      ["AddObject", { doc: "D", type: "Part::Box", label: "L", group: "G", properties: { Length: 3 } }],
      ["AddProperty", { doc: "D", object: "Box", type: "App::PropertyFloat", name: "Weight", group: "Mass", documentation: "kg" }],
      ["SetExpression", { doc: "D", object: "Box", path: "Width", expression: null }],
      ["Import", { doc: "D", data, fileName: "x.step" }],
      ["Export", { doc: "D", objects: ["Box"], format: "stl" }],
      ["RunPython", { code: "1+1", mode: "auto" }],
      ["GetBoundingBox", { doc: "D", objects: ["Box"] }],
    ]);
  });
});

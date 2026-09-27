import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessage, type Encoding, type Response } from "@fab-cad/protocol";
import { startMockServer, type MockServer } from "@fab-cad/mock-server/server";
import { FreeCADClient } from "../src/client";
import { TransportError } from "../src/transport/types";
import { WebSocketTransport } from "../src/transport/websocket";

/** A WebSocket server that accepts requests and never answers (for timeouts and close). */
function silentServer() {
  const received: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no");
    },
    websocket: {
      message(_ws, data) {
        received.push(data);
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/`, received, stop: () => server.stop(true) };
}

describe("WebSocketTransport against the mock server", () => {
  let server: MockServer;
  beforeEach(() => {
    server = startMockServer({ port: 0, demo: true });
  });
  afterEach(async () => {
    await server.stop();
  });

  for (const encoding of ["cbor", "json"] as Encoding[]) {
    test(`${encoding}: concurrent calls are matched to their replies by id`, async () => {
      const transport = await WebSocketTransport.connect(server.url);
      const client = new FreeCADClient(transport, { encoding });
      const [version, docs, objects, props, info] = await Promise.all([
        client.getVersion(),
        client.listDocuments(),
        client.getObjects("Demo"),
        client.getProperties("Demo", "Box", ["Length"]),
        client.getServerInfo(),
      ]);
      expect(version.api).toBe(1);
      expect(docs.map((d) => d.name)).toEqual(["Demo"]);
      expect(objects.map((o) => o.name)).toEqual(["Parts", "Box", "Cylinder", "Sphere"]);
      expect(props[0]!.name).toBe("Length");
      expect(info.transport).toBe("ws");
      expect(client.token).toBe(server.freecad.token);

      const meshes = await client.tessellate("Demo");
      expect(meshes.map((m) => m.object)).toEqual(["Box", "Cylinder", "Sphere"]);
      expect(meshes[0]!.positions).toBeInstanceOf(Float32Array);
      expect(meshes[0]!.faceCount).toBe(6);
      await client.close();
      expect(transport.state).toBe("closed");
    });
  }

  test("pipelined requests with raw ids resolve out of any order the caller issues them in", async () => {
    const transport = await WebSocketTransport.connect(server.url);
    const ids = Array.from({ length: 50 }, (_, i) => `r${i}`);
    const replies = await Promise.all(ids.map((id) => transport.send(encodeMessage({ id, cmd: "Ping" }, "cbor"))));
    expect(replies.map((r) => decodeMessage<Response>(r).id)).toEqual(ids);
    // without opts.id the transport reads the id from the message itself
    const r = await transport.send(encodeMessage({ id: 99, cmd: "GetVersion" }, "json"));
    expect(typeof r).toBe("string");
    await expect(transport.send(encodeMessage({ cmd: "Ping" }, "json"))).rejects.toThrow(/no id/);
    await transport.close();
  });

  test("events arrive after the reply of the request that raised them", async () => {
    const client = new FreeCADClient(await WebSocketTransport.connect(server.url), { clientName: "tab-1" });
    const log: string[] = [];
    client.on("*", (_d, m) => log.push(m.event));
    const created = client.next("ObjectCreated");
    await client.addObject("Demo", "Part::Box", { label: "Extra" }).then(() => log.push("reply"));
    const data = await created;
    expect(data).toMatchObject({ doc: "Demo", object: "Box001", type: "Part::Box", client: "tab-1" });
    await Bun.sleep(20);
    expect(log[0]).toBe("reply");
    expect(log.slice(1)).toEqual(["TransactionOpened", "ObjectCreated", "TransactionCommitted"]);
    await client.close();
  });

  test("a second client sees the first client's events", async () => {
    const a = new FreeCADClient(await WebSocketTransport.connect(server.url), { clientName: "a" });
    const b = new FreeCADClient(await WebSocketTransport.connect(server.url), { clientName: "b", encoding: "json" });
    await b.ping(); // b's connection now speaks JSON; events to it are JSON
    const seen = b.next("ObjectChanged", { timeoutMs: 2000, filter: (d) => d.property === "Length" });
    await a.setProperties("Demo", "Box", { Length: 12 });
    expect(await seen).toMatchObject({ object: "Box", property: "Length", client: "a" });
    await a.close();
    await b.close();
  });
});

describe("WebSocketTransport failure modes", () => {
  test("close rejects pending requests", async () => {
    const s = silentServer();
    try {
      const t = await WebSocketTransport.connect(s.url);
      const p1 = t.send(encodeMessage({ id: 1, cmd: "Ping" }, "cbor"));
      const p2 = t.send(encodeMessage({ id: 2, cmd: "Ping" }, "json"));
      await Bun.sleep(20);
      expect(t.inFlight).toBe(2);
      await t.close();
      await expect(p1).rejects.toBeInstanceOf(TransportError);
      await expect(p2).rejects.toThrow(/closed/);
      await expect(t.send(encodeMessage({ id: 3, cmd: "Ping" }, "json"))).rejects.toThrow(/closed/);
    } finally {
      await s.stop();
    }
  });

  test("requests time out; a duplicate id in flight is refused", async () => {
    const s = silentServer();
    try {
      const t = await WebSocketTransport.connect(s.url, { defaultTimeoutMs: 50 });
      const p = t.send(encodeMessage({ id: 1, cmd: "Ping" }, "json"));
      await expect(t.send(encodeMessage({ id: 1, cmd: "Ping" }, "json"))).rejects.toThrow(/already in flight/);
      const err = await p.catch((e) => e);
      expect(TransportError.is(err, "timeout")).toBe(true);
      await t.close();
    } finally {
      await s.stop();
    }
  });

  test("server going away closes the transport and reports the state", async () => {
    const server = startMockServer({ port: 0 });
    const t = await WebSocketTransport.connect(server.url);
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    await server.stop();
    for (let i = 0; i < 50 && t.state !== "closed"; i++) await Bun.sleep(10);
    expect(t.state).toBe("closed");
    expect(states).toEqual(["closed"]);
  });

  test("connecting to nothing fails with a connect error", async () => {
    const err = await WebSocketTransport.connect("ws://127.0.0.1:1/", { connectTimeoutMs: 2000 }).catch((e) => e);
    expect(TransportError.is(err, "connect")).toBe(true);
  });
});

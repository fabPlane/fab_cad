/**
 * The client against the real `FreeCADApiServer` from the fork, over both native transports.
 * Skipped unless FREECAD_API_SERVER names the executable:
 *
 *   FREECAD_API_SERVER=../freecad/build/bin/FreeCADApiServer bun run test:integration
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { FreeCADClient, WebSocketTransport, type Transport } from "../src";
import { StdioTransport } from "../src/transport/stdio";

const SERVER = process.env.FREECAD_API_SERVER ?? "";
const available = SERVER !== "" && existsSync(SERVER);

async function startWebSocketServer(): Promise<{ url: string; proc: Bun.Subprocess }> {
  const proc = Bun.spawn([SERVER, "--listen", "ws://127.0.0.1:0/"], { stdout: "pipe", stderr: "ignore" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("FreeCADApiServer exited before it was ready");
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const url = text.split("FCAPI_READY ")[1]?.trim();
  if (!url) throw new Error(`unexpected first line: ${text}`);
  return { url, proc };
}

function suite(name: string, connect: () => Promise<{ transport: Transport; stop: () => Promise<void> }>) {
  describe.skipIf(!available)(name, () => {
    let client: FreeCADClient;
    let stop: () => Promise<void>;

    beforeAll(async () => {
      const started = await connect();
      stop = started.stop;
      client = await FreeCADClient.connect(started.transport);
    });

    afterAll(async () => {
      await client?.close();
      await stop?.();
    });

    test("version and commands", async () => {
      const version = await client.getVersion();
      expect(version.api).toBe(1);
      const names = (await client.getCommands()).map((c) => c.name);
      expect(names).toContain("Tessellate");
    });

    test("a placed box tessellates in the global frame, one range per face", async () => {
      const doc = (await client.newDocument({ name: "Integration" })).name;
      const events: string[] = [];
      const off = client.on("*", (_data, message) => events.push(message.event));

      const box = await client.addObject(doc, "Part::Box", {
        properties: { Length: 20, Placement: { $type: "Placement", base: [100, 0, 0] } },
      });
      expect(box.name).toBe("Box");
      await client.recompute(doc);
      const [tess] = await client.tessellate(doc);
      expect(tess).toBeDefined();
      let minX = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < tess!.positions.length; i += 3) {
        minX = Math.min(minX, tess!.positions[i]!);
        maxX = Math.max(maxX, tess!.positions[i]!);
      }
      expect(minX).toBeCloseTo(100);
      expect(maxX).toBeCloseTo(120);
      expect(tess!.faces.length / 2).toBe(6);
      expect(tess!.edges.length / 2).toBe(12);

      await Bun.sleep(50);
      off();
      expect(events).toContain("ObjectCreated");

      const undo = await client.undo(doc);
      expect(undo.redo.length).toBe(1);
      expect(await client.getObjects(doc)).toHaveLength(0);
      await client.closeDocument(doc);
    });

    test("python and STEP export", async () => {
      const doc = (await client.newDocument({ name: "Step" })).name;
      await client.addObject(doc, "Part::Sphere");
      await client.recompute(doc);
      const volume = await client.runPython(`App.getDocument('${doc}').Sphere.Shape.Volume`, "eval");
      expect(volume.result as number).toBeCloseTo((4 / 3) * Math.PI * 125, 3);
      const step = await client.exportObjects(doc, ["Sphere"], "step");
      expect(new TextDecoder().decode(step.data.subarray(0, 12))).toBe("ISO-10303-21");
      await client.closeDocument(doc);
    });
  });
}

suite("FreeCADApiServer over WebSocket (CBOR)", async () => {
  const { url, proc } = await startWebSocketServer();
  const transport = await WebSocketTransport.connect(url);
  return {
    transport,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
});

suite("FreeCADApiServer over stdio", async () => {
  const transport = await StdioTransport.connect({ command: SERVER, args: ["--stdio"] });
  return { transport, stop: async () => {} };
});

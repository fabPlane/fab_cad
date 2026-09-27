import { describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessageBytes, type EventMessage, type Response } from "@fab-cad/protocol";
import { createMockDispatcher } from "@fab-cad/mock-server";
import { FreeCADClient } from "../src/client";
import { TransportError } from "../src/transport/types";
import { WasmTransport, type FreeCadWasmInstance } from "../src/transport/wasm";

/** An instance that records calls and emits one event per dispatch, from inside dispatch. */
function fakeInstance(opts: { throwOn?: string; abortOn?: string } = {}) {
  const listeners = new Set<(b: Uint8Array) => void>();
  const calls: string[] = [];
  let depth = 0;
  let maxDepth = 0;
  let shutdowns = 0;
  const inst: FreeCadWasmInstance = {
    dispatch(req) {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      try {
        const m = decodeMessage<{ id: number; cmd: string }>(req);
        calls.push(m.cmd);
        if (m.cmd === opts.throwOn) throw new Error("boom");
        if (m.cmd === opts.abortOn) throw new WebAssembly.RuntimeError("unreachable");
        for (const cb of listeners) cb(encodeMessageBytes({ event: "Recomputed", seq: calls.length, data: { doc: m.cmd } }, "cbor"));
        return encodeMessageBytes({ id: m.id, status: "OK", token: "t", result: m.cmd }, "cbor");
      } finally {
        depth--;
      }
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    shutdown() {
      shutdowns++;
    },
  };
  return {
    inst,
    calls,
    get maxDepth() {
      return maxDepth;
    },
    get shutdowns() {
      return shutdowns;
    },
  };
}

describe("WasmTransport", () => {
  test("never dispatches inside the caller's stack frame; FIFO, one at a time", async () => {
    const f = fakeInstance();
    const t = new WasmTransport(f.inst);
    const p = [1, 2, 3].map((i) => t.send(encodeMessageBytes({ id: i, cmd: `C${i}` }, "cbor")));
    expect(f.calls).toEqual([]); // queued, not run synchronously
    const replies = await Promise.all(p);
    expect(replies.map((r) => decodeMessage<Response>(r).id)).toEqual([1, 2, 3]);
    expect(f.calls).toEqual(["C1", "C2", "C3"]);
    expect(f.maxDepth).toBe(1);
  });

  test("events raised during a dispatch are delivered after its reply resolves", async () => {
    const f = fakeInstance();
    const t = new WasmTransport(f.inst);
    const log: string[] = [];
    t.onEvent((b) => log.push(`event:${decodeMessage<EventMessage<"Recomputed">>(b).data.doc}`));
    await Promise.all(
      ["A", "B"].map((cmd, i) =>
        t.send(encodeMessageBytes({ id: i, cmd }, "json")).then(() => {
          log.push(`reply:${cmd}`);
        }),
      ),
    );
    await Promise.resolve();
    expect(log).toEqual(["reply:A", "event:A", "reply:B", "event:B"]);
  });

  test("a failing dispatch rejects that request only; an abort closes the transport", async () => {
    const f = fakeInstance({ throwOn: "Bad", abortOn: "Abort" });
    const t = new WasmTransport(f.inst);
    await expect(t.send(encodeMessageBytes({ id: 1, cmd: "Bad" }, "cbor"))).rejects.toThrow(/boom/);
    expect(decodeMessage<Response>(await t.send(encodeMessageBytes({ id: 2, cmd: "Ok" }, "cbor"))).id).toBe(2);
    const abort = t.send(encodeMessageBytes({ id: 3, cmd: "Abort" }, "cbor"));
    const later = t.send(encodeMessageBytes({ id: 4, cmd: "Later" }, "cbor")).catch((e: Error) => e);
    await expect(abort).rejects.toBeInstanceOf(TransportError);
    expect(String(await later)).toMatch(/closed/); // queued behind the abort: the module is gone
    expect(t.state).toBe("closed");
    expect(f.calls).not.toContain("Later");
    expect(f.shutdowns).toBe(1);
  });

  test("close rejects queued requests and shuts the instance down once", async () => {
    const f = fakeInstance();
    const t = new WasmTransport(f.inst);
    const p = t.send(encodeMessageBytes({ id: 1, cmd: "X" }, "cbor"));
    await t.close();
    await t.close();
    await expect(p).rejects.toThrow(/closed/);
    expect(f.calls).toEqual([]);
    expect(f.shutdowns).toBe(1);
    await expect(t.send(encodeMessageBytes({ id: 2, cmd: "Y" }, "cbor"))).rejects.toThrow(/closed/);
  });

  test("dispatchAsync (a worker) keeps order and event buffering", async () => {
    const f = fakeInstance();
    const inst: FreeCadWasmInstance = {
      ...f.inst,
      dispatchAsync: async (req) => {
        await Bun.sleep(5);
        return f.inst.dispatch(req);
      },
    };
    const t = new WasmTransport(inst);
    const log: string[] = [];
    t.onEvent(() => log.push("event"));
    await Promise.all([1, 2].map((i) => t.send(encodeMessageBytes({ id: i, cmd: `C${i}` }, "cbor")).then(() => log.push(`reply${i}`))));
    await Promise.resolve();
    expect(log).toEqual(["reply1", "event", "reply2", "event"]);
    expect(f.maxDepth).toBe(1);
  });

  test("the whole client over the mock dispatcher, in-process", async () => {
    const client = new FreeCADClient(new WasmTransport(createMockDispatcher({ demo: true })));
    const log: string[] = [];
    client.on("*", (_d, m) => log.push(m.event));
    const box = await client.addObject("Demo", "Part::Box", { properties: { Length: "2 cm" } });
    expect(box.name).toBe("Box001");
    await client.recompute("Demo");
    const [mesh] = await client.tessellate("Demo", { objects: ["Box001"], normals: true });
    expect(mesh!.normals!.length).toBe(mesh!.positions.length);
    expect(Math.max(...mesh!.positions.filter((_, i) => i % 3 === 0))).toBeCloseTo(20);
    await Bun.sleep(0);
    expect(log).toContain("ObjectCreated");
    expect(log).toContain("ObjectRecomputed");
    await client.close();
  });
});

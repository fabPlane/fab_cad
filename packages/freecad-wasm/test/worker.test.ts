import { describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessageBytes, type EventMessage, type Response } from "@fab-cad/protocol";
import { FreeCADClient, WasmTransport } from "@fab-cad/client";
import { createFreeCadWasmInWorker, FreeCadWasmWorkerClient } from "../src/worker-client";
import { serveFreeCadWasm } from "../src/worker-core";
import type { FreeCadWasmWorkerLike, FreeCadWasmWorkerPort } from "../src/worker-protocol";
import { fakeFactory, type FakeModuleControl } from "./fake-module";

/** A worker and its port, in-process: messages are delivered asynchronously, as by postMessage. */
function fakeWorker(control: FakeModuleControl, opts: { hangOnStop?: boolean } = {}) {
  const posted: unknown[] = [];
  let terminated = false;
  const port: FreeCadWasmWorkerPort = {
    onmessage: null,
    postMessage(message) {
      setTimeout(() => worker.onmessage?.({ data: message } as MessageEvent), 0);
    },
    close() {},
  };
  const worker: FreeCadWasmWorkerLike & { posted: unknown[]; readonly terminated: boolean } = {
    onmessage: null,
    onerror: null,
    posted,
    get terminated() {
      return terminated;
    },
    postMessage(message) {
      posted.push(message);
      if (opts.hangOnStop && (message as { stop?: boolean }).stop) return;
      setTimeout(() => port.onmessage?.({ data: message } as MessageEvent), 0);
    },
    terminate() {
      terminated = true;
    },
  };
  serveFreeCadWasm(port, { loadFactory: async () => fakeFactory(control) });
  return worker;
}

const control = (over: Partial<FakeModuleControl> = {}): FakeModuleControl => ({ initCalls: 0, shutdownCalls: 0, frees: 0, ...over });

describe("worker protocol", () => {
  test("start seeds files before fcapi_init, then dispatches in order with events", async () => {
    const c = control();
    const w = await createFreeCadWasmInWorker({
      createWorker: () => fakeWorker(c),
      moduleUrl: "https://example/freecad_api.js",
      files: [{ path: "/work/seed.txt", bytes: new Uint8Array([7]) }],
      modules: ["Part"],
    });
    expect(w.state).toBe("running");
    expect(c.config!.modules).toEqual(["Part"]);
    expect(Array.from(await w.readFile("/work/seed.txt"))).toEqual([7]);

    const events: string[] = [];
    w.onEvent((b) => events.push(decodeMessage<EventMessage>(b).event));
    const replies = await Promise.all([1, 2, 3].map((i) => w.dispatchAsync(encodeMessageBytes({ id: i, cmd: "Ping" }, "cbor"))));
    expect(replies.map((r) => decodeMessage<Response>(r).id)).toEqual([1, 2, 3]);
    await w.dispatchAsync(encodeMessageBytes({ id: 4, cmd: "NewDocument" }, "cbor"));
    await Bun.sleep(5);
    expect(events).toEqual(["DocumentCreated", "ActiveDocumentChanged"]);
    expect(() => w.dispatch(new Uint8Array())).toThrow(/Worker/);
    await w.shutdown();
    expect(c.shutdownCalls).toBe(1);
  });

  test("MEMFS operations over messages", async () => {
    const w = await createFreeCadWasmInWorker({ createWorker: () => fakeWorker(control()), moduleUrl: "x:/m.js" });
    expect(await w.writeFiles([])).toBe(0);
    await w.writeFile("/w/a.FCStd", new Uint8Array([1, 2]));
    await w.mkdir("/w/sub");
    expect(await w.exists("/w/a.FCStd")).toBe(true);
    expect(await w.stat("/w/a.FCStd")).toEqual({ kind: "file", size: 2 });
    expect(await w.stat("/w/sub")).toMatchObject({ kind: "dir" });
    expect(await w.stat("/w/none")).toBeNull();
    expect(await w.listFiles("/w")).toEqual(["/w/a.FCStd"]);
    await w.remove("/w/a.FCStd");
    expect(await w.exists("/w/a.FCStd")).toBe(false);
    await expect(w.readFile("/w/none")).rejects.toThrow(/ENOENT/);
    await w.shutdown();
  });

  test("a failing fcapi_init rejects the start and terminates the worker", async () => {
    let worker: ReturnType<typeof fakeWorker> | undefined;
    const err = await createFreeCadWasmInWorker({
      createWorker: () => (worker = fakeWorker(control({ failInit: 3 }))),
      moduleUrl: "x:/m.js",
    }).catch((e) => e);
    expect(String(err.message)).toMatch(/fcapi_init returned 3/);
    expect(worker!.terminated).toBe(true);
  });

  test("an abort on the worker closes the WasmTransport", async () => {
    const c = control();
    const w = await createFreeCadWasmInWorker({ createWorker: () => fakeWorker(c), moduleUrl: "x:/m.js" });
    const t = new WasmTransport(w);
    const client = new FreeCADClient(t);
    await client.ping();
    c.abortNext = true;
    await expect(client.ping()).rejects.toThrow(/unreachable/);
    for (let i = 0; i < 20 && t.state !== "closed"; i++) await Bun.sleep(5);
    expect(t.state).toBe("closed");
    expect(w.isShutDown).toBe(true);
  });

  test("shutdown gives up on a worker that never answers stop, and terminate() is immediate", async () => {
    const worker = fakeWorker(control(), { hangOnStop: true });
    const w = new FreeCadWasmWorkerClient(worker);
    worker.postMessage({ start: { moduleUrl: "x:/m.js" } });
    await w.ready();
    const pending = w.dispatchAsync(encodeMessageBytes({ id: 1, cmd: "Ping" }, "json"));
    w.terminate("wedged");
    await expect(pending).rejects.toThrow(/wedged/);
    expect(worker.terminated).toBe(true);
    expect(w.state).toBe("failed");
  });

  test("the full client through a worker", async () => {
    const w = await createFreeCadWasmInWorker({ createWorker: () => fakeWorker(control()), moduleUrl: "x:/m.js" });
    const client = new FreeCADClient(new WasmTransport(w));
    const meshes = await client.tessellate("Demo");
    expect(meshes.map((m) => m.object)).toEqual(["Box", "Cylinder", "Sphere"]);
    await client.close();
    expect(w.isShutDown).toBe(true);
  });
});

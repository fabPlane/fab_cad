import { describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessageBytes, type Response } from "@fab-cad/protocol";
import { FreeCADClient, WasmTransport } from "@fab-cad/client";
import { createFreeCadWasm, FreeCadWasmError, sibling } from "../src/index";
import { exists, listFiles, mountDirectory, mountFile, readFile, readTextFile, remove, writeFile } from "../src/fs";
import { fakeFactory, type FakeModuleControl } from "./fake-module";

const control = (over: Partial<FakeModuleControl> = {}): FakeModuleControl => ({ initCalls: 0, shutdownCalls: 0, frees: 0, ...over });

describe("createFreeCadWasm", () => {
  test("passes the config to fcapi_init and creates the home directory", async () => {
    const c = control();
    const wasm = await createFreeCadWasm({
      module: fakeFactory(c),
      modules: ["Part", "Sketcher"],
      preload: "/work/a.FCStd",
      python: false,
    });
    expect(c.config).toEqual({
      argv0: "/freecad/bin/FreeCADApi",
      env: { FREECAD_USER_HOME: "/home/freecad" },
      modules: ["Part", "Sketcher"],
      preload: "/work/a.FCStd",
      python: false,
      events: true,
      eventEncoding: "cbor",
    });
    expect(exists(wasm, "/home/freecad")).toBe(true);
    expect(typeof c.moduleArg!.__fcapiEvent).toBe("function");
  });

  test("dispatch moves bytes through the heap (surviving heap growth) and frees the reply", async () => {
    const c = control();
    const wasm = await createFreeCadWasm({ module: fakeFactory(c) });
    for (let i = 0; i < 20; i++) {
      const reply = decodeMessage<Response>(
        wasm.dispatch(encodeMessageBytes({ id: i, cmd: "Tessellate", params: { doc: "Demo" } }, "cbor")),
      );
      expect(reply).toMatchObject({ id: i, status: "OK" });
    }
    expect(c.frees).toBe(20);
  });

  test("events are copied out of the heap and reach listeners and onEvent", async () => {
    const seen: Uint8Array[] = [];
    const wasm = await createFreeCadWasm({ module: fakeFactory(control()), onEvent: (b) => seen.push(b) });
    const viaListener: Uint8Array[] = [];
    wasm.onEvent((b) => viaListener.push(b));
    wasm.dispatch(encodeMessageBytes({ id: 1, cmd: "NewDocument" }, "json"));
    expect(seen.length).toBe(2);
    expect(viaListener.length).toBe(2);
    expect(seen[0]!.buffer.byteLength).toBe(seen[0]!.length); // a standalone copy, not a heap view
    expect(decodeMessage<{ event: string }>(seen[0]!).event).toBe("DocumentCreated");
  });

  test("fcapi_init failure carries fcapi_last_error", async () => {
    const err = await createFreeCadWasm({ module: fakeFactory(control({ failInit: 2 })) }).catch((e) => e);
    expect(err).toBeInstanceOf(FreeCadWasmError);
    expect(err.message).toBe("fcapi_init returned 2: no FreeCAD home");
  });

  test("accepts exports without the underscore; rejects a module missing the ABI", async () => {
    await createFreeCadWasm({ module: fakeFactory(control({ bareNames: true })) });
    const broken = async () => ({ HEAPU8: new Uint8Array(1) }) as never;
    await expect(createFreeCadWasm({ module: broken })).rejects.toThrow(/does not export _malloc/);
  });

  test("shutdown is idempotent and refuses later dispatches", async () => {
    const c = control();
    const wasm = await createFreeCadWasm({ module: fakeFactory(c) });
    wasm.shutdown();
    wasm.shutdown();
    expect(c.shutdownCalls).toBe(1);
    expect(() => wasm.dispatch(new Uint8Array([0xa0]))).toThrow(/shut down/);
  });

  test("locateFile resolves sidecars next to the glue", async () => {
    const c = control();
    await createFreeCadWasm({ module: fakeFactory(c), moduleUrl: "https://cdn.example/fc/freecad_api.js" });
    const locate = c.moduleArg!.locateFile as (p: string) => string;
    expect(locate("freecad_api.wasm")).toBe("https://cdn.example/fc/freecad_api.wasm");
    expect(locate("freecad_api.data")).toBe("https://cdn.example/fc/freecad_api.data");
    expect(sibling("file:///opt/fc%20build/freecad_api.js", "freecad_api.data")).toBe("/opt/fc build/freecad_api.data");
  });

  test("loading from a URL that does not exist explains how to get the build", async () => {
    await expect(createFreeCadWasm({ moduleUrl: "file:///nonexistent/freecad_api.js" })).rejects.toThrow(/fetch/);
  });

  test("the whole client over WasmTransport", async () => {
    const wasm = await createFreeCadWasm({ module: fakeFactory(control()) });
    const client = new FreeCADClient(new WasmTransport(wasm));
    const changed = client.next("ObjectChanged");
    await client.setProperties("Demo", "Box", { Length: 7 });
    expect(await changed).toMatchObject({ object: "Box", property: "Length" });
    expect((await client.getObjects("Demo")).length).toBe(4);
    await client.close();
    expect(wasm.isShutDown).toBe(true);
  });
});

describe("MEMFS helpers", () => {
  test("write, read, list, remove", async () => {
    const wasm = await createFreeCadWasm({ module: fakeFactory(control()) });
    writeFile(wasm, "/work/a/b.txt", "hello");
    writeFile(wasm, "/work/c.bin", new Uint8Array([1, 2, 3]));
    expect(readTextFile(wasm, "/work/a/b.txt")).toBe("hello");
    expect(Array.from(readFile(wasm, "/work/c.bin"))).toEqual([1, 2, 3]);
    expect(listFiles(wasm, "/work")).toEqual(["/work/a/b.txt", "/work/c.bin"]);
    remove(wasm, "/work/a");
    expect(listFiles(wasm, "/work")).toEqual(["/work/c.bin"]);
    expect(listFiles(wasm, "/nowhere")).toEqual([]);
  });

  test("mountFile and mountDirectory copy from the host", async () => {
    const wasm = await createFreeCadWasm({ module: fakeFactory(control()) });
    const dir = `${import.meta.dir}/../scripts`;
    const n = await mountFile(wasm, `${dir}/fetch.ts`, "/host/fetch.ts");
    expect(readFile(wasm, "/host/fetch.ts").length).toBe(n);
    const r = await mountDirectory(wasm, dir, "/mirror");
    expect(r.files).toBeGreaterThan(0);
    expect(listFiles(wasm, "/mirror")).toContain("/mirror/fetch.ts");
  });
});

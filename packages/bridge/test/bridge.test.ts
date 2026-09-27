/**
 * The bridge against the mock server standing in for `FreeCADApiServer` (the same arguments, the
 * same `FCAPI_READY` line, `--key`). Point `FREECAD_API_SERVER` at a real binary to run the same
 * lifecycle against FreeCAD; by default it is `bun <mock-server>/src/main.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FreeCADClient, FreeCADApiError, WebSocketTransport, type SessionInfo } from "@fab-cad/client";
import { MockFreeCAD } from "@fab-cad/mock-server";
import { configFromEnv, resolveServerCommand, splitCommand, type BridgeConfig } from "../src/config";
import { startBridge, type BridgeServer } from "../src/server";

const MOCK_MAIN = resolve(import.meta.dir, "../../mock-server/src/main.ts");
const SERVER = process.env.FREECAD_API_SERVER ?? `bun ${MOCK_MAIN} --quiet`;

let root: string;
let staticDir: string;
let bridge: BridgeServer;
const logs: string[] = [];

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    serverCommand: splitCommand(SERVER),
    serverArgs: [],
    useKey: true,
    workspaceRoot: root,
    staticDir,
    startTimeoutMs: 20_000,
    killGraceMs: 1000,
    maxPayloadBytes: 64 * 1024 * 1024,
    log: (m) => logs.push(m),
    ...over,
  };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${bridge.url}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function connect(sessionId: string, encoding: "cbor" | "json" = "cbor"): Promise<FreeCADClient> {
  const ws = bridge.url.replace("http:", "ws:") + `/ws?session=${sessionId}`;
  return new FreeCADClient(await WebSocketTransport.connect(ws), { encoding, clientName: `test/${encoding}` });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fab-cad-bridge-"));
  staticDir = join(root, "www");
  await mkdir(join(root, "models"), { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>fab-cad</title>");
  await writeFile(join(staticDir, "app.js"), "console.log(1)");
  // a document the mock can open: its own save format
  const fc = new MockFreeCAD({ demo: true });
  const saved = fc.handle({ id: 1, cmd: "SaveDocumentBytes", params: { doc: "Demo" } }).response as { result: { data: Uint8Array } };
  await writeFile(join(root, "models", "demo.FCStd"), saved.result.data);
  bridge = await startBridge(config());
});

afterAll(async () => {
  await bridge?.stop();
  await rm(root, { recursive: true, force: true });
});

describe("configuration", () => {
  test("splitCommand honours quotes", () => {
    expect(splitCommand(`bun "/a b/main.ts" --x 'y z' ""`)).toEqual(["bun", "/a b/main.ts", "--x", "y z", ""]);
    expect(() => splitCommand(`bun "oops`)).toThrow();
  });

  test("FREECAD_API_SERVER wins, else FreeCADApiServer on PATH, else null", () => {
    expect(resolveServerCommand({ FREECAD_API_SERVER: "bun main.ts" })).toEqual(["bun", "main.ts"]);
    expect(resolveServerCommand({ PATH: "/nonexistent" })).toBeNull();
    const cfg = configFromEnv({ PORT: "0", FREECAD_API_SERVER: "x", FREECAD_API_SERVER_ARGS: "--module Part", WORKSPACE_ROOT: "/tmp" });
    expect(cfg).toMatchObject({ port: 0, serverCommand: ["x"], serverArgs: ["--module", "Part"], useKey: true, workspaceRoot: "/tmp" });
  });
});

describe("sessions", () => {
  test("lifecycle: create, proxy requests and events, delete", async () => {
    const { status, json } = await post("/sessions", {});
    expect(status).toBe(201);
    const session = json.session as SessionInfo;
    expect(session.state).toBe("running");
    expect(session.token).toBeString();
    expect(session.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/);
    expect(json.wsUrl).toBe(`/ws?session=${session.id}`);

    // requests in both encodings, through the proxy
    const a = await connect(session.id, "cbor");
    const b = await connect(session.id, "json");
    expect((await a.listDocuments()).map((d) => d.name)).toEqual(["Demo"]);
    expect(a.token).toBe(session.token!);
    expect((await b.getServerInfo()).transport).toBe("ws");
    const meshes = await a.tessellate("Demo");
    expect(meshes.map((m) => m.object)).toEqual(["Box", "Cylinder", "Sphere"]);

    // each browser connection is its own upstream client: b sees a's events
    const seen = b.next("ObjectChanged", { timeoutMs: 5000, filter: (d) => d.property === "Length" });
    await a.setProperties("Demo", "Box", { Length: 33 });
    expect(await seen).toMatchObject({ object: "Box", client: "test/cbor" });
    expect(bridge.sessions.get(session.id)!.clients.size).toBe(2);

    const listed = (await (await fetch(`${bridge.url}/sessions`)).json()) as { sessions: SessionInfo[] };
    expect(listed.sessions.find((s) => s.id === session.id)?.clients).toBe(2);

    // delete: the process stops and the browser connections close
    const closed = new Promise<void>((r) => a.transport.onStateChange((s) => s === "closed" && r()));
    const del = await fetch(`${bridge.url}/sessions/${session.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    await closed;
    await expect(a.ping()).rejects.toThrow(/closed/);
    expect((await fetch(`${bridge.url}/sessions/${session.id}`)).status).toBe(404);
    await b.close();
  });

  test("a session can open a document from the workspace", async () => {
    const { status, json } = await post("/sessions", { path: "models/demo.FCStd", id: "with-doc" });
    expect(status).toBe(201);
    expect((json.session as SessionInfo).path).toEndWith("models/demo.FCStd");
    const c = await connect("with-doc");
    const docs = await c.listDocuments();
    // the mock opens the file (named after its saved name, uniquified); no demo document besides
    expect(docs.length).toBe(1);
    expect(docs[0]!.fileName).toEndWith("demo.FCStd");
    expect((await c.getObjects(docs[0]!.name)).length).toBe(4);
    await c.close();
    await fetch(`${bridge.url}/sessions/with-doc`, { method: "DELETE" });
  });

  test("bad requests: duplicate id, invalid id, missing file, path escaping the root", async () => {
    expect((await post("/sessions", { id: "bad id!" })).status).toBe(400);
    expect((await post("/sessions", { path: "models/nope.FCStd" })).status).toBe(400);
    expect((await post("/sessions", { path: "../../etc/passwd" })).status).toBe(403);
    const ok = await post("/sessions", { id: "dup" });
    expect(ok.status).toBe(201);
    expect((await post("/sessions", { id: "dup" })).status).toBe(400);
    await fetch(`${bridge.url}/sessions/dup`, { method: "DELETE" });
  });

  test("the WebSocket needs a live session", async () => {
    expect((await fetch(`${bridge.url}/ws?session=nope`)).status).toBe(404);
    const err = await WebSocketTransport.connect(`${bridge.url.replace("http:", "ws:")}/ws?session=nope`, { connectTimeoutMs: 2000 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
  });

  test("the server's key keeps other clients out; the bridge has it", async () => {
    const { json } = await post("/sessions", { id: "keyed" });
    const direct = (json.session as SessionInfo).url!;
    const refused = await WebSocketTransport.connect(direct, { connectTimeoutMs: 2000 }).catch((e) => e);
    expect(refused).toBeInstanceOf(Error);
    await fetch(`${bridge.url}/sessions/keyed`, { method: "DELETE" });
  });

  test("a server that dies closes its browser connections and the session reports it", async () => {
    const { json } = await post("/sessions", { id: "crashy" });
    const c = await connect("crashy");
    await c.ping();
    const closed = new Promise<void>((r) => c.transport.onStateChange((s) => s === "closed" && r()));
    process.kill((json.session as SessionInfo).pid!, "SIGKILL");
    await closed;
    for (let i = 0; i < 50 && bridge.sessions.get("crashy")!.state !== "exited"; i++) await Bun.sleep(20);
    const info = (await (await fetch(`${bridge.url}/sessions/crashy`)).json()) as { session: SessionInfo };
    expect(info.session.state).toBe("exited");
    expect((await fetch(`${bridge.url}/ws?session=crashy`)).status).toBe(409);
    await fetch(`${bridge.url}/sessions/crashy`, { method: "DELETE" });
  });

  test("a binary that is not there, or exits at once, fails with 502", async () => {
    const other = await startBridge(config({ serverCommand: ["/nonexistent/FreeCADApiServer"] }));
    try {
      const res = await fetch(`${other.url}/sessions`, { method: "POST" });
      expect(res.status).toBe(502);
    } finally {
      await other.stop();
    }
    const exits = await startBridge(config({ serverCommand: ["bun", "-e", "console.error('no FreeCAD here'); process.exit(3)"] }));
    try {
      const res = await fetch(`${exits.url}/sessions`, { method: "POST" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toMatch(/exited with code 3/);
      expect(exits.sessions.list()).toEqual([]);
    } finally {
      await exits.stop();
    }
    const none = await startBridge(config({ serverCommand: null }));
    try {
      const res = await fetch(`${none.url}/sessions`, { method: "POST" });
      expect(((await res.json()) as { error: string }).error).toMatch(/FREECAD_API_SERVER/);
    } finally {
      await none.stop();
    }
  });

  test("errors from FreeCAD come through the proxy untouched", async () => {
    await post("/sessions", { id: "errs" });
    const c = await connect("errs", "json");
    const err = await c.getObject("Demo", "Nope").catch((e) => e);
    expect(FreeCADApiError.is(err, "NOT_FOUND")).toBe(true);
    await c.close();
    await fetch(`${bridge.url}/sessions/errs`, { method: "DELETE" });
  });
});

describe("files and static hosting", () => {
  test("list, read, write inside the root", async () => {
    const list = (await (await fetch(`${bridge.url}/files?dir=models`)).json()) as { entries: { name: string; kind: string }[] };
    expect(list.entries.map((e) => [e.name, e.kind])).toEqual([["demo.FCStd", "file"]]);
    const top = (await (await fetch(`${bridge.url}/files`)).json()) as { dir: string; entries: { name: string; kind: string }[] };
    expect(top.dir).toBe(".");
    expect(top.entries.map((e) => e.name)).toEqual(["models", "www"]);

    const put = await fetch(`${bridge.url}/files/write?path=out/new.txt`, { method: "PUT", body: "hello" });
    expect(put.status).toBe(204);
    expect(await (await fetch(`${bridge.url}/files/read?path=out/new.txt`)).text()).toBe("hello");
    expect((await fetch(`${bridge.url}/files/read?path=out/none.txt`)).status).toBe(404);
  });

  test("paths cannot escape the root, not even through a symlink", async () => {
    expect((await fetch(`${bridge.url}/files?dir=../`)).status).toBe(403);
    expect((await fetch(`${bridge.url}/files/read?path=/etc/passwd`)).status).toBe(403);
    await symlink("/etc", join(root, "escape"));
    expect((await fetch(`${bridge.url}/files/read?path=escape/passwd`)).status).toBe(403);
  });

  test("serves the SPA with an index.html fallback for client routes", async () => {
    expect(await (await fetch(`${bridge.url}/app.js`)).text()).toBe("console.log(1)");
    expect(await (await fetch(`${bridge.url}/`)).text()).toContain("<title>fab-cad</title>");
    expect(await (await fetch(`${bridge.url}/documents/Demo`)).text()).toContain("<title>fab-cad</title>");
    expect((await fetch(`${bridge.url}/missing.js`)).status).toBe(404);
    const health = (await (await fetch(`${bridge.url}/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
  });
});

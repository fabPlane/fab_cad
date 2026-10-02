/**
 * The bridge's request checks (src/security.ts): Host (DNS rebinding), Origin / Sec-Fetch-Site
 * (other web pages), and the optional bearer token for non-browser callers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FreeCADClient, WebSocketTransport } from "@fab-cad/client";
import { configFromEnv, splitCommand, type BridgeConfig } from "../src/config";
import { BridgeSecurity, redactUrl, tokenMatches } from "../src/security";
import { startBridge, type BridgeServer } from "../src/server";

const MOCK_MAIN = resolve(import.meta.dir, "../../mock-server/src/main.ts");
const SERVER = process.env.FREECAD_API_SERVER ?? `bun ${MOCK_MAIN} --quiet`;
const TOKEN = "s3cret-token-for-tests";
const EVIL = "https://evil.example";

let root: string;
let staticDir: string;
let open: BridgeServer; // no token
let locked: BridgeServer; // FAB_CAD_BRIDGE_TOKEN set, one extra allowed origin
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

const API_GETS = ["/health", "/sessions", "/files", "/files/read?path=secret.txt"];

/** Every CORS-ish header of a response, to check none of them is `*`. */
function corsValues(res: Response): string[] {
  return [...res.headers.entries()].filter(([k]) => k.startsWith("access-control-")).map(([, v]) => v);
}

/** A raw WebSocket handshake through Bun's client (which can set Origin); resolves to "open" or "error". */
function tryWs(url: string, headers: Record<string, string> = {}): Promise<"open" | "error"> {
  return new Promise((done) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.addEventListener("open", () => (ws.close(), done("open")));
    ws.addEventListener("error", () => done("error"));
    ws.addEventListener("close", () => done("error"));
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fab-cad-bridge-sec-"));
  staticDir = join(root, "www");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>fab-cad</title>");
  await writeFile(join(root, "secret.txt"), "top secret");
  open = await startBridge(config());
  locked = await startBridge(
    config({ token: TOKEN, allowedOrigins: ["http://localhost:5173"], frameAncestors: "'self' http://localhost:5173" }),
  );
});

afterAll(async () => {
  await open?.stop();
  await locked?.stop();
  await rm(root, { recursive: true, force: true });
});

describe("configuration", () => {
  test("env vars", () => {
    const cfg = configFromEnv({
      FREECAD_API_SERVER: "x",
      FAB_CAD_BRIDGE_TOKEN: " t ",
      FAB_CAD_BRIDGE_ALLOWED_ORIGINS: "http://localhost:5173, https://app.example/",
      FAB_CAD_BRIDGE_ALLOWED_HOSTS: "bridge.test,other.test:9000",
      FAB_CAD_BRIDGE_FRAME_ANCESTORS: "'self'",
    });
    expect(cfg).toMatchObject({
      token: "t",
      allowedOrigins: ["http://localhost:5173", "https://app.example"],
      allowedHosts: ["bridge.test", "other.test:9000"],
      frameAncestors: "'self'",
    });
    expect(configFromEnv({ FREECAD_API_SERVER: "x" })).toMatchObject({
      token: null,
      allowedOrigins: [],
      allowedHosts: [],
      frameAncestors: null,
    });
    expect(() => configFromEnv({ FREECAD_API_SERVER: "x", FAB_CAD_BRIDGE_ALLOWED_ORIGINS: "http://a.example/path" })).toThrow();
  });

  test("hosts and origins the bridge accepts as itself", () => {
    const s = new BridgeSecurity({
      port: 4030,
      hostname: "::1",
      token: null,
      allowedOrigins: [],
      allowedHosts: ["bridge.test", "x.test:1"],
    });
    expect([...s.hosts].sort()).toEqual(["127.0.0.1:4030", "[::1]:4030", "bridge.test:4030", "localhost:4030", "x.test:1"]);
    expect(s.ownOrigins.has("http://localhost:4030")).toBe(true);
  });

  test("token comparison and URL redaction", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "")).toBe(false);
    expect(tokenMatches("abc", null)).toBe(false);
    expect(redactUrl(new URL("http://h/ws?session=a&access_token=xyz"))).toBe("/ws?session=a&access_token=REDACTED");
  });

  test("a missing token is warned about at startup", () => {
    expect(logs.some((l) => l.includes("FAB_CAD_BRIDGE_TOKEN is not set"))).toBe(true);
  });
});

describe("other web pages", () => {
  for (const path of API_GETS) {
    test(`cross-origin GET ${path} -> 403`, async () => {
      for (const b of [open, locked]) {
        const res = await fetch(`${b.url}${path}`, { headers: { origin: EVIL } });
        expect(res.status).toBe(403);
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
    });
  }

  test("cross-origin writes and session creation -> 403, nothing happens", async () => {
    const put = await fetch(`${open.url}/files/write?path=pwned.txt`, { method: "PUT", body: "x", headers: { origin: EVIL } });
    expect(put.status).toBe(403);
    expect(await Bun.file(join(root, "pwned.txt")).exists()).toBe(false);
    const post = await fetch(`${open.url}/sessions`, {
      method: "POST",
      body: "{}",
      headers: { origin: EVIL, "content-type": "application/json" },
    });
    expect(post.status).toBe(403);
    expect(open.sessions.list()).toEqual([]);
  });

  test("no Origin but Sec-Fetch-Site cross-site / same-site -> 403", async () => {
    for (const site of ["cross-site", "same-site"]) {
      expect((await fetch(`${open.url}/files/read?path=secret.txt`, { headers: { "sec-fetch-site": site } })).status).toBe(403);
    }
  });

  test("the literal null origin (sandboxed frames, file://) -> 403", async () => {
    expect((await fetch(`${open.url}/sessions`, { headers: { origin: "null" } })).status).toBe(403);
  });

  test("a preflight from a foreign origin -> 403, never a wildcard", async () => {
    const res = await fetch(`${open.url}/files/write?path=a`, {
      method: "OPTIONS",
      headers: { origin: EVIL, "access-control-request-method": "PUT" },
    });
    expect(res.status).toBe(403);
    expect(corsValues(res)).toEqual([]);
  });

  test("DNS rebinding: a foreign Host header -> 403, on the API and the SPA alike", async () => {
    const port = open.port;
    for (const host of [`evil.example:${port}`, `evil.example`, `127.0.0.1:${port + 1}`, `localhost.evil.example:${port}`]) {
      for (const path of ["/files/read?path=secret.txt", "/sessions", "/health", "/"]) {
        const res = await fetch(`${open.url}${path}`, { headers: { host } });
        expect(res.status).toBe(403);
      }
    }
    // a rebinding page is "same-origin" with itself: still refused by Host
    const res = await fetch(`${open.url}/files/read?path=secret.txt`, {
      headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` },
    });
    expect(res.status).toBe(403);
  });

  test("a WebSocket from a foreign origin is refused before the upgrade", async () => {
    const s = (await (await fetch(`${open.url}/sessions`, { method: "POST" })).json()) as { wsUrl: string; session: { id: string } };
    const ws = open.url.replace("http:", "ws:") + s.wsUrl;
    expect(await tryWs(ws, { origin: EVIL })).toBe("error");
    expect(await tryWs(ws, { origin: open.url })).toBe("open");
    // and over plain HTTP the refusal is a 403, not an upgrade
    const res = await fetch(`${open.url}${s.wsUrl}`, { headers: { origin: EVIL, upgrade: "websocket", connection: "upgrade" } });
    expect(res.status).toBe(403);
    await fetch(`${open.url}/sessions/${s.session.id}`, { method: "DELETE" });
  });
});

describe("the bridge's own page", () => {
  test("same-origin requests (Origin = the bridge, any loopback spelling) pass without a token", async () => {
    for (const b of [open, locked]) {
      for (const origin of [b.url, `http://localhost:${b.port}`]) {
        const res = await fetch(`${b.url}/files/read?path=secret.txt`, { headers: { origin } });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("top secret");
        expect(corsValues(res)).toEqual([]);
      }
    }
  });

  test("Sec-Fetch-Site: same-origin without Origin passes without a token", async () => {
    const res = await fetch(`${locked.url}/health`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
    const health = (await res.json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, name: "@fab-cad/bridge" });
    expect(health.workspaceRoot).toBe(root);
  });

  test("the SPA is served to anyone naming the bridge, with frame-ancestors when configured and no CORS", async () => {
    const plain = await fetch(`${open.url}/`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-security-policy")).toBeNull();
    expect(corsValues(plain)).toEqual([]);
    const framed = await fetch(`${locked.url}/`);
    expect(framed.status).toBe(200);
    expect(framed.headers.get("content-security-policy")).toBe("frame-ancestors 'self' http://localhost:5173");
  });
});

describe("FAB_CAD_BRIDGE_ALLOWED_ORIGINS", () => {
  test("an allowed origin is let in and gets its own origin echoed, never *", async () => {
    const res = await fetch(`${locked.url}/sessions`, { headers: { origin: "http://localhost:5173" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("vary")).toContain("origin");
    const pre = await fetch(`${locked.url}/files/write?path=a`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "PUT" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    for (const v of [...corsValues(res), ...corsValues(pre)]) expect(v).not.toBe("*");
  });

  test("an origin that is not listed is still refused", async () => {
    expect((await fetch(`${locked.url}/sessions`, { headers: { origin: "http://localhost:5174" } })).status).toBe(403);
  });
});

describe("FAB_CAD_BRIDGE_TOKEN", () => {
  test("without the token configured, non-browser callers get liveness only from /health", async () => {
    const health = (await (await fetch(`${open.url}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, name: "@fab-cad/bridge" });
    expect(health.workspaceRoot).toBeUndefined();
    expect(health.serverCommand).toBeUndefined();
    expect((await fetch(`${open.url}/sessions`)).status).toBe(200);
  });

  test("with it, a non-browser caller without the token -> 401 everywhere", async () => {
    for (const path of API_GETS) {
      const res = await fetch(`${locked.url}${path}`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await fetch(`${locked.url}/files/write?path=x.txt`, { method: "PUT", body: "x" })).status).toBe(401);
    expect((await fetch(`${locked.url}/sessions`, { method: "POST" })).status).toBe(401);
  });

  test("a wrong token -> 401, also with a same-origin Origin alongside", async () => {
    const res = await fetch(`${locked.url}/sessions`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    const res2 = await fetch(`${locked.url}/sessions`, { headers: { authorization: "Bearer nope", origin: locked.url } });
    expect(res2.status).toBe(401);
  });

  test("the query-parameter token works on /ws only", async () => {
    expect((await fetch(`${locked.url}/sessions?access_token=${TOKEN}`)).status).toBe(401);
  });

  test("Bearer -> 200, full /health", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const health = (await (await fetch(`${locked.url}/health`, { headers: auth })).json()) as Record<string, unknown>;
    expect(health.workspaceRoot).toBe(root);
    expect((await fetch(`${locked.url}/files/read?path=secret.txt`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${locked.url}/sessions`, { headers: auth })).status).toBe(200);
  });

  test("/ws: no token refused; access_token or a Bearer header (WebSocketTransport `token`) upgrades", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const created = (await (await fetch(`${locked.url}/sessions`, { method: "POST", headers: auth })).json()) as {
      wsUrl: string;
      session: { id: string };
    };
    const ws = locked.url.replace("http:", "ws:") + created.wsUrl;
    expect(await tryWs(ws)).toBe("error");
    expect(await tryWs(`${ws}&access_token=wrong`)).toBe("error");
    expect(await tryWs(`${ws}&access_token=${encodeURIComponent(TOKEN)}`)).toBe("open");
    expect(await tryWs(ws, { origin: EVIL })).toBe("error");

    for (const tokenIn of ["header", "query"] as const) {
      const t = await WebSocketTransport.connect(ws, { token: TOKEN, tokenIn });
      expect(t.url).not.toContain(TOKEN);
      const c = new FreeCADClient(t, { encoding: "json", clientName: `test/${tokenIn}` });
      expect((await c.listDocuments()).map((d) => d.name)).toEqual(["Demo"]);
      await c.close();
    }
    const refused = await WebSocketTransport.connect(ws, { token: "wrong", connectTimeoutMs: 2000 }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).not.toContain("wrong");

    await fetch(`${locked.url}/sessions/${created.session.id}`, { method: "DELETE", headers: auth });
  });

  test("the token never reaches the log", () => {
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.some((l) => l.includes("access_token=REDACTED"))).toBe(true);
  });
});

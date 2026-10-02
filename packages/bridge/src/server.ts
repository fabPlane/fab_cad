/**
 * `Bun.serve` front of the bridge:
 *
 *   GET    /health                 bridge and session overview
 *   GET    /sessions               [SessionInfo]
 *   POST   /sessions {path?, id?}  spawn FreeCADApiServer (optionally opening `path`); 201 {session, wsUrl}
 *   GET    /sessions/:id           SessionInfo (+ log tail)
 *   DELETE /sessions/:id           stop it
 *   GET    /ws?session=<id>        WebSocket, proxied frame for frame to the session's server
 *   /files…                        the workspace file API (./files)
 *   GET    anything else           the built SPA from STATIC_DIR (index.html for client routes)
 *
 * Every request must name the bridge in its `Host` header; the API routes (everything but the SPA)
 * also pass the origin and token checks of `./security`.
 */
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { BridgeConfig } from "./config";
import { FilesError, handleFiles } from "./files";
import { BridgeSecurity, isLoopbackHostname, redactUrl, type Verdict } from "./security";
import { SessionManager, type WsData } from "./session";

export interface BridgeServer {
  readonly url: string;
  readonly port: number;
  readonly hostname: string;
  readonly config: BridgeConfig;
  readonly sessions: SessionManager;
  stop(): Promise<void>;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers });
}

function isApiPath(path: string): boolean {
  return (
    path === "/ws" ||
    path === "/health" ||
    path === "/sessions" ||
    path.startsWith("/sessions/") ||
    path === "/files" ||
    path.startsWith("/files/")
  );
}

export async function startBridge(cfg: BridgeConfig): Promise<BridgeServer> {
  const sessions = new SessionManager(cfg);
  const startedAt = Date.now();
  if (!cfg.serverCommand) cfg.log("warning: no FreeCAD API server (set FREECAD_API_SERVER or put FreeCADApiServer on PATH)");
  if (!isLoopbackHostname(cfg.hostname) && !cfg.allowedHosts?.length) {
    cfg.log(
      `warning: HOST=${cfg.hostname} is not loopback; only loopback Host headers are accepted (list other names in FAB_CAD_BRIDGE_ALLOWED_HOSTS)`,
    );
  }
  if (!cfg.token) {
    cfg.log("warning: FAB_CAD_BRIDGE_TOKEN is not set; non-browser callers can use the API without a token (set it outside dev)");
  }
  let security: BridgeSecurity | null = null;
  const frameHeaders: Record<string, string> = cfg.frameAncestors
    ? { "content-security-policy": `frame-ancestors ${cfg.frameAncestors}` }
    : {};

  const server = Bun.serve<WsData>({
    port: cfg.port,
    hostname: cfg.hostname,
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      security ??= new BridgeSecurity({
        port: srv.port!,
        hostname: cfg.hostname,
        token: cfg.token ?? null,
        allowedOrigins: cfg.allowedOrigins ?? [],
        allowedHosts: cfg.allowedHosts ?? [],
      });
      const reject = (v: Extract<Verdict, { ok: false }>): Response => {
        cfg.log(`rejected ${req.method} ${redactUrl(url)} (${v.status}): ${v.reason}`);
        return jsonResponse(
          { error: v.status === 401 ? "unauthorized" : "forbidden" },
          v.status,
          v.status === 401 ? { "www-authenticate": "Bearer" } : {},
        );
      };

      if (!isApiPath(path)) {
        const bad = security.checkHost(req);
        if (bad && !bad.ok) return reject(bad);
        if (req.method === "OPTIONS") return new Response(null, { status: 204 });
        if (cfg.staticDir && req.method === "GET") {
          const res = await serveStatic(cfg.staticDir, path, frameHeaders);
          if (res) return res;
        }
        return jsonResponse({ error: "not found" }, 404);
      }

      if (req.method === "OPTIONS") {
        // A preflight carries no credentials; answer it for allowed origins only.
        const origin = req.headers.get("origin");
        const bad = security.checkHost(req);
        if (bad && !bad.ok) return reject(bad);
        if (origin === null) return new Response(null, { status: 204 });
        if (security.ownOrigins.has(origin.toLowerCase())) return new Response(null, { status: 204 });
        if (security.allowedOrigins.has(origin)) return new Response(null, { status: 204, headers: BridgeSecurity.corsHeaders(origin) });
        return reject({ ok: false, status: 403, reason: `origin "${origin}" is not allowed` });
      }

      const verdict = security.checkApi(req, url, { allowQueryToken: path === "/ws" });
      if (!verdict.ok) return reject(verdict);
      const CORS = BridgeSecurity.corsHeaders(verdict.corsOrigin);
      const json = (data: unknown, status = 200) => Response.json(data, { status, headers: CORS });

      if (path === "/ws") {
        const id = url.searchParams.get("session") ?? "";
        const session = sessions.get(id);
        if (!session) return json({ error: `unknown session "${id}"` }, 404);
        if (session.state !== "running") return json({ error: `session "${id}" is ${session.state}` }, 409);
        if (srv.upgrade(req, { data: { session, upstream: null, backlog: [] } })) return undefined;
        return json({ error: "WebSocket upgrade failed" }, 400);
      }

      if (path === "/health") {
        // Liveness for anyone who got this far; the details only for trusted callers.
        if (!verdict.trusted) return json({ ok: true, name: "@fab-cad/bridge", uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
        return json({
          ok: true,
          name: "@fab-cad/bridge",
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          serverCommand: cfg.serverCommand,
          workspaceRoot: cfg.workspaceRoot,
          staticDir: cfg.staticDir,
          sessions: sessions.list(),
        });
      }

      if (path === "/sessions") {
        if (req.method === "GET") return json({ sessions: sessions.list() });
        if (req.method === "POST") {
          let body: { path?: string | null; id?: string } = {};
          const text = await req.text();
          if (text.trim()) {
            try {
              body = JSON.parse(text);
            } catch {
              return json({ error: "body must be JSON" }, 400);
            }
          }
          try {
            const s = await sessions.create({ path: body.path ?? null, id: body.id });
            return json({ session: s.info(), wsUrl: `/ws?session=${encodeURIComponent(s.id)}` }, 201);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const status = e instanceof FilesError ? e.status : /not found|invalid|already exists/.test(msg) ? 400 : 502;
            return json({ error: msg }, status);
          }
        }
        return json({ error: "method not allowed" }, 405);
      }

      const m = /^\/sessions\/([^/]+)$/.exec(path);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const s = sessions.get(id);
        if (!s) return json({ error: `unknown session "${id}"` }, 404);
        if (req.method === "GET") return json({ session: s.info(), log: s.tailLog(50) });
        if (req.method === "DELETE") {
          await sessions.destroy(id);
          return new Response(null, { status: 204, headers: CORS });
        }
        return json({ error: "method not allowed" }, 405);
      }

      if (path === "/files" || path.startsWith("/files/")) return handleFiles(req, url, cfg.workspaceRoot, CORS);

      return json({ error: "not found" }, 404);
    },
    websocket: {
      maxPayloadLength: cfg.maxPayloadBytes,
      idleTimeout: 960,
      open(ws) {
        ws.data.session.attach(ws);
      },
      message(ws, message) {
        ws.data.session.forward(ws, typeof message === "string" ? message : new Uint8Array(message));
      },
      close(ws) {
        ws.data.session.detach(ws);
      },
    },
  });

  const url = `http://${cfg.hostname}:${server.port}`;
  cfg.log(
    `listening on ${url} (FreeCAD: ${cfg.serverCommand?.join(" ") ?? "none"}, workspace: ${cfg.workspaceRoot}${cfg.staticDir ? `, static: ${cfg.staticDir}` : ""})`,
  );
  return {
    url,
    port: server.port!,
    hostname: cfg.hostname,
    config: cfg,
    sessions,
    async stop() {
      await sessions.stopAll();
      await stopServer(server);
    },
  };
}

/**
 * `server.stop(true)` closes every connection, but its promise never settles once a WebSocket has
 * been closed from the server side (Bun 1.3). The connections are gone by then; don't wait forever.
 */
async function stopServer(server: { stop(closeActive?: boolean): Promise<void> }): Promise<void> {
  await Promise.race([server.stop(true), Bun.sleep(500)]);
}

const TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

/** A file under `dir`, or `index.html` for extension-less paths (client-side routes). */
async function serveStatic(dir: string, pathname: string, extra: Record<string, string>): Promise<Response | null> {
  const root = resolve(dir);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + "/")) return null;
  const candidates = [target];
  if (!extname(target)) candidates.push(resolve(target, "index.html"), resolve(root, "index.html"));
  for (const c of candidates) {
    const s = await stat(c).catch(() => null);
    if (s?.isFile()) {
      const type = TYPES[extname(c)];
      const headers: Record<string, string> = { "x-content-type-options": "nosniff", ...extra };
      if (type) headers["content-type"] = type;
      return new Response(Bun.file(c), { headers });
    }
  }
  return null;
}

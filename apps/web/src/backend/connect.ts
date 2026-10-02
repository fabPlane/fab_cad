/**
 * Picks and opens the FreeCAD API backend the page talks to.
 *
 *   ?ws=<url>     a FreeCADApiServer (or FreeCADApi.startServer() in a desktop FreeCAD), directly
 *   (served by @fab-cad/bridge)   the bridge's session API: POST /sessions, then its /ws proxy
 *   ?bridge=<url> the same, with the bridge somewhere else
 *   ?wasm=1       freecad_api.wasm in a Web Worker (@fab-cad/freecad-wasm); ?wasm=<url of freecad_api.js>
 *   ?mock=1       @fab-cad/mock-server's dispatcher in this page (demos, tests)
 *
 * Without a parameter the page asks the origin's `/health` whether it is a bridge; if not, the
 * start page offers the choices (and remembers a WebSocket URL the user typed).
 */
import { DocumentStore, FreeCADClient, WasmTransport, WebSocketTransport, type ServerInfo, type Transport } from "@fab-cad/client";
import { isMockBackend } from "./capabilities";

export type BackendKind = "ws" | "bridge" | "wasm" | "mock";

export type BackendChoice =
  | { kind: "ws"; url: string }
  | { kind: "bridge"; base: string }
  | { kind: "wasm"; moduleUrl: string }
  | { kind: "mock"; demo: boolean }
  | { kind: "auto" };

export const DEFAULT_WASM_URL = "/freecad-wasm/freecad_api.js";

/** Read the backend from the query string (and Vite env), see the module comment. */
export function chooseBackend(search: string, env: Record<string, string | undefined> = {}): BackendChoice {
  const p = new URLSearchParams(search);
  if (p.get("mock") === "1" || p.get("mock") === "demo" || env.VITE_BACKEND === "mock") {
    return { kind: "mock", demo: p.get("mock") === "demo" || p.get("demo") === "1" };
  }
  const wasm = p.get("wasm") ?? env.VITE_FREECAD_WASM;
  if (wasm) return { kind: "wasm", moduleUrl: wasm === "1" || wasm === "true" ? DEFAULT_WASM_URL : wasm };
  const ws = p.get("ws") ?? env.VITE_FREECAD_WS;
  if (ws) return { kind: "ws", url: ws };
  const bridge = p.get("bridge") ?? env.VITE_BRIDGE_URL;
  if (bridge !== null && bridge !== undefined) return { kind: "bridge", base: bridge === "1" || bridge === "" ? "" : bridge };
  return { kind: "auto" };
}

export interface Connection {
  kind: BackendKind;
  /** Human-readable, for the report view and the start page. */
  description: string;
  client: FreeCADClient;
  store: DocumentStore;
  serverInfo: ServerInfo | null;
  /** The bridge session id, when there is one. */
  session?: string;
  close(): Promise<void>;
}

export class BackendUnavailableError extends Error {
  override readonly name = "BackendUnavailableError";
}

const CLIENT_NAME = `fab-cad/web-${Math.random().toString(36).slice(2, 8)}`;

async function finish(kind: BackendKind, description: string, transport: Transport, extra: Partial<Connection> = {}): Promise<Connection> {
  const client = await FreeCADClient.connect(transport, { clientName: CLIENT_NAME });
  const store = new DocumentStore(client, { debounceMs: 15 });
  let serverInfo: ServerInfo | null = null;
  try {
    serverInfo = await client.getServerInfo();
  } catch {
    serverInfo = null;
  }
  // Load the workbench modules FreeCAD's GUI would import; the mock has none.
  const mock = isMockBackend({ kind, serverInfo });
  if (!mock) {
    for (const m of ["Part", "Sketcher", "PartDesign"]) await client.loadModule(m).catch(() => undefined);
  }
  await store.load();
  return {
    kind,
    description: mock && kind !== "mock" ? description.replace("FreeCAD", "Mock FreeCAD") : description,
    client,
    store,
    serverInfo,
    ...extra,
    async close() {
      store.dispose();
      await client.close();
    },
  };
}

/** Is the page served by `@fab-cad/bridge`? (`GET /health` answers with its name.) */
export async function detectBridge(base = "", fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(`${base}/health`, { headers: { accept: "application/json" } });
    if (!r.ok) return false;
    const j = (await r.json()) as { name?: string; ok?: boolean };
    return j.name === "@fab-cad/bridge" || (j.ok === true && "sessions" in j);
  } catch {
    return false;
  }
}

const SESSION_KEY = "fab-cad.bridge-session";

function wsUrlFrom(base: string, path: string): string {
  const origin = base || location.origin;
  const u = new URL(path, origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

async function openBridgeSession(base: string): Promise<{ session: string; wsUrl: string }> {
  let reuse: string | null = null;
  try {
    reuse = sessionStorage.getItem(SESSION_KEY);
  } catch {
    reuse = null;
  }
  if (reuse) {
    try {
      const r = await fetch(`${base}/sessions/${encodeURIComponent(reuse)}`);
      if (r.ok) {
        const j = (await r.json()) as { session: { id: string; state: string } };
        if (j.session.state === "running") return { session: reuse, wsUrl: `/ws?session=${encodeURIComponent(reuse)}` };
      }
    } catch {
      // start a new one
    }
  }
  const r = await fetch(`${base}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new BackendUnavailableError(`the bridge could not start FreeCAD: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { session: { id: string }; wsUrl: string };
  try {
    sessionStorage.setItem(SESSION_KEY, j.session.id);
  } catch {
    // private mode
  }
  return { session: j.session.id, wsUrl: j.wsUrl };
}

/** Is the wasm build there? Answers with a message saying what is missing when it is not. */
export async function checkWasmBuild(moduleUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const wasmUrl = moduleUrl.replace(/\.js(\?.*)?$/, ".wasm");
  for (const u of [moduleUrl, wasmUrl]) {
    try {
      const r = await fetchImpl(u, { method: "HEAD" });
      const type = r.headers.get("content-type") ?? "";
      if (!r.ok || type.includes("text/html")) return `${u} is not there`;
    } catch (e) {
      return `${u} cannot be fetched (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  return null;
}

export async function connectBackend(choice: Exclude<BackendChoice, { kind: "auto" }>): Promise<Connection> {
  switch (choice.kind) {
    case "mock": {
      const { createMockDispatcher } = await import("@fab-cad/mock-server");
      const dispatcher = createMockDispatcher({ demo: choice.demo, eventTiming: "during" });
      return finish("mock", "in-page mock FreeCAD (@fab-cad/mock-server)", new WasmTransport(dispatcher));
    }
    case "ws": {
      const t = await WebSocketTransport.connect(choice.url, { connectTimeoutMs: 8000 }).catch((e: unknown) => {
        throw new BackendUnavailableError(`cannot connect to ${choice.url}: ${e instanceof Error ? e.message : String(e)}`);
      });
      return finish("ws", `FreeCADApiServer at ${choice.url}`, t);
    }
    case "bridge": {
      const { session, wsUrl } = await openBridgeSession(choice.base);
      const url = wsUrlFrom(choice.base, wsUrl);
      const t = await WebSocketTransport.connect(url, { connectTimeoutMs: 15000 });
      return finish("bridge", `FreeCAD via the bridge at ${choice.base || location.origin} (session ${session})`, t, { session });
    }
    case "wasm": {
      const missing = await checkWasmBuild(choice.moduleUrl);
      if (missing) {
        throw new BackendUnavailableError(
          `The FreeCAD WebAssembly build is not available: ${missing}. Build it in the fork and copy it with ` +
            "`bun run wasm:fetch` (it lands in packages/freecad-wasm/dist and is served under /freecad-wasm/).",
        );
      }
      const { createFreeCadWasmInWorker } = await import("@fab-cad/freecad-wasm/worker-client");
      const abs = new URL(choice.moduleUrl, location.href).toString();
      const wasm = await createFreeCadWasmInWorker({ moduleUrl: abs, modules: ["Part", "Sketcher", "PartDesign"], python: true });
      return finish("wasm", `FreeCAD as WebAssembly in a Web Worker (${choice.moduleUrl})`, new WasmTransport(wasm));
    }
  }
}

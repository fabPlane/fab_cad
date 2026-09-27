/** Connects the page to a backend and keeps the UI's connection state (used by main.tsx and the start page). */
import { log } from "../state/console";
import { attachConnection, disconnect, useSession } from "../state/session";
import { BackendUnavailableError, chooseBackend, connectBackend, detectBridge, type BackendChoice } from "./connect";

const WS_KEY = "fab-cad.ws-url";

export function rememberedWsUrl(): string {
  try {
    return localStorage.getItem(WS_KEY) ?? "ws://127.0.0.1:8765/";
  } catch {
    return "ws://127.0.0.1:8765/";
  }
}

export async function connectTo(choice: Exclude<BackendChoice, { kind: "auto" }>): Promise<boolean> {
  await disconnect();
  useSession.setState({ status: "connecting", error: null, choice });
  if (choice.kind === "ws") {
    try {
      localStorage.setItem(WS_KEY, choice.url);
    } catch {
      // no storage
    }
  }
  try {
    const c = await connectBackend(choice);
    attachConnection(c, choice);
    log.message(`Connected: ${c.description}`);
    if (c.serverInfo && !c.serverInfo.python)
      log.warning("This FreeCAD API server refuses RunPython: the Python console, the Sketcher and Part Design need it.");
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useSession.setState({ status: "error", error: msg });
    log.error(e instanceof BackendUnavailableError ? msg : `Cannot connect: ${msg}`);
    return false;
  }
}

/** The page's backend from its URL; `auto` asks the origin whether it is a bridge. */
export async function autoConnect(): Promise<void> {
  const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
  const choice = chooseBackend(location.search, env);
  if (choice.kind !== "auto") {
    await connectTo(choice);
    return;
  }
  if (await detectBridge("")) {
    await connectTo({ kind: "bridge", base: "" });
    return;
  }
  useSession.setState({ status: "idle", error: null });
  log.message("No backend in the URL (?ws=…, ?mock=1, ?wasm=1) and no bridge here: choose one on the Start page.");
}

/**
 * Bridge configuration, from the environment (`configFromEnv`) or built directly in tests.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { normaliseOrigin, splitList } from "./security";

export interface BridgeConfig {
  /** HTTP + WebSocket port. `0` picks a free one. Env `PORT`, default 4030. */
  port: number;
  /** Env `HOST`, default `127.0.0.1`. */
  hostname: string;
  /**
   * The command that starts a FreeCAD API server, as argv. Env `FREECAD_API_SERVER` (split on
   * whitespace, quotes respected: `bun /path/to/mock-server/src/main.ts` works), else
   * `FreeCADApiServer` found on `PATH`. `null` when neither is there (sessions then fail to start).
   */
  serverCommand: string[] | null;
  /** Extra arguments for every server (`--module Part`, `--no-python`). Env `FREECAD_API_SERVER_ARGS`. */
  serverArgs: string[];
  /** Protect each session's server with a random `--key` (only the bridge can dial it). Env `FREECAD_API_KEY` (`0` disables), default on. */
  useKey: boolean;
  /** Root the `/files` API and session `path`s are confined to. Env `WORKSPACE_ROOT`, default the cwd. */
  workspaceRoot: string;
  /** Directory served for unmatched GET requests (the built SPA). Env `STATIC_DIR`; default `apps/web/dist` when it exists. */
  staticDir: string | null;
  /** How long a new server has to answer `Ping`. Env `FREECAD_START_TIMEOUT_MS`, default 60 000. */
  startTimeoutMs: number;
  /** How long `stop()` waits after SIGTERM before SIGKILL. Default 3000 ms. */
  killGraceMs: number;
  /** Largest WebSocket message accepted from a browser. Default 256 MiB. */
  maxPayloadBytes: number;
  /**
   * Shared secret for callers that are not the bridge's own page (a supervisor, a CLI): they send
   * `Authorization: Bearer <token>` (or `?access_token=<token>` on `/ws`). Env `FAB_CAD_BRIDGE_TOKEN`.
   * Unset: such callers are let through (a warning is logged). See `./security`.
   */
  token?: string | null;
  /** Extra origins whose pages may call the API (exact `scheme://host:port`). Env `FAB_CAD_BRIDGE_ALLOWED_ORIGINS`, comma separated. */
  allowedOrigins?: string[];
  /** Extra `Host` header values (`name` for the bridge's port, or `name:port`). Env `FAB_CAD_BRIDGE_ALLOWED_HOSTS`, comma separated. */
  allowedHosts?: string[];
  /** CSP `frame-ancestors` sources for the SPA (e.g. `'self' http://localhost:5173`). Env `FAB_CAD_BRIDGE_FRAME_ANCESTORS`; unset sends none. */
  frameAncestors?: string | null;
  log: (message: string) => void;
}

/** Split a command line on whitespace, honouring single and double quotes. */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (quote) throw new Error(`unterminated quote in ${JSON.stringify(s)}`);
  if (cur || any) out.push(cur);
  return out;
}

/** `FREECAD_API_SERVER`, else `FreeCADApiServer` on `PATH`. */
export function resolveServerCommand(env: Record<string, string | undefined> = process.env): string[] | null {
  const explicit = env.FREECAD_API_SERVER?.trim();
  if (explicit) return splitCommand(explicit);
  const found = Bun.which("FreeCADApiServer", env.PATH ? { PATH: env.PATH } : undefined);
  return found ? [found] : null;
}

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function int(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const defaultStatic = resolve(REPO_ROOT, "apps/web/dist");
  return {
    port: int(env.PORT, 4030),
    hostname: env.HOST ?? "127.0.0.1",
    serverCommand: resolveServerCommand(env),
    serverArgs: env.FREECAD_API_SERVER_ARGS ? splitCommand(env.FREECAD_API_SERVER_ARGS) : [],
    useKey: env.FREECAD_API_KEY !== "0",
    workspaceRoot: resolve(env.WORKSPACE_ROOT ?? process.cwd()),
    staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : existsSync(defaultStatic) ? defaultStatic : null,
    startTimeoutMs: int(env.FREECAD_START_TIMEOUT_MS, 60_000),
    killGraceMs: 3000,
    maxPayloadBytes: 256 * 1024 * 1024,
    token: env.FAB_CAD_BRIDGE_TOKEN?.trim() || null,
    allowedOrigins: splitList(env.FAB_CAD_BRIDGE_ALLOWED_ORIGINS).map(normaliseOrigin),
    allowedHosts: splitList(env.FAB_CAD_BRIDGE_ALLOWED_HOSTS),
    frameAncestors: env.FAB_CAD_BRIDGE_FRAME_ANCESTORS?.trim() || null,
    log: (m) => console.error(`[bridge] ${m}`),
  };
}

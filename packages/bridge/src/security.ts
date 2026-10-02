/**
 * Who may talk to the bridge. The bridge listens on loopback, but loopback is reachable from every
 * web page the user has open: a page can `fetch()` the API (CORS only hides the answer, the request
 * still runs), open `/ws` (WebSockets ignore CORS) and run Python through it, or rebind its own DNS
 * name to 127.0.0.1 and become "same-origin". So every request goes through `checkRequest`:
 *
 * 1. **Host** must name the bridge itself (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`,
 *    or an entry of `FAB_CAD_BRIDGE_ALLOWED_HOSTS`). Stops DNS rebinding. Applies to every path.
 * 2. **Browser checks** (API routes): an `Origin` must be the bridge's own origin or one listed in
 *    `FAB_CAD_BRIDGE_ALLOWED_ORIGINS`; without an `Origin`, a `Sec-Fetch-Site` must be `same-origin`
 *    or `none`. Anything else is a cross-site browser request: 403.
 * 3. **Token** (`FAB_CAD_BRIDGE_TOKEN`, API routes): callers that are not a verified same-origin (or
 *    allowed-origin) browser request must send `Authorization: Bearer <token>`, or on `/ws` only
 *    `?access_token=<token>`. A valid token is accepted whatever the browser headers say (a web page
 *    cannot know it). Without a token configured, such callers are let through (dev, tests).
 */
import { createHash, timingSafeEqual } from "node:crypto";

export interface SecurityOptions {
  /** The port the server actually bound. */
  port: number;
  /** The configured bind hostname. */
  hostname: string;
  token: string | null;
  allowedOrigins: readonly string[];
  allowedHosts: readonly string[];
}

export type Verdict =
  | {
      ok: true;
      /** Same-origin browser request, an allowed origin, or a valid token: may see everything. */
      trusted: boolean;
      /** The request's `Origin` when it is allowed and cross-origin (echoed in CORS headers). */
      corsOrigin: string | null;
    }
  | { ok: false; status: 401 | 403; reason: string };

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHostname(h: string): boolean {
  const name = h.toLowerCase();
  return LOOPBACK_NAMES.has(name) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) || name.endsWith(".localhost");
}

/** `::1` -> `[::1]`; others as they are, lowercased. */
function hostForUrl(h: string): string {
  const name = h.toLowerCase();
  return name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
}

/** Split a comma (or whitespace) separated env list. */
export function splitList(v: string | undefined): string[] {
  return (v ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalise an origin (`scheme://host[:port]`, or the literal `null`); throws on anything else. */
export function normaliseOrigin(o: string): string {
  if (o === "null") return o;
  const u = new URL(o);
  if (u.origin === "null" || u.pathname.length > 1 || u.search || u.hash) throw new Error(`not an origin: ${o}`);
  return u.origin;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time comparison (both sides hashed, so lengths always match). */
export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

/** The request URL as it may be logged: `access_token` replaced. */
export function redactUrl(url: URL): string {
  const u = new URL(url.toString());
  if (u.searchParams.has("access_token")) u.searchParams.set("access_token", "REDACTED");
  return `${u.pathname}${u.search}`;
}

export class BridgeSecurity {
  /** Lowercased `host:port` values accepted in the `Host` header. */
  readonly hosts: ReadonlySet<string>;
  /** Origins that are the bridge itself. */
  readonly ownOrigins: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
  private readonly token: string | null;

  constructor(opts: SecurityOptions) {
    this.token = opts.token || null;
    const port = opts.port;
    const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (isLoopbackHostname(opts.hostname) && opts.hostname !== "0.0.0.0") hosts.add(`${hostForUrl(opts.hostname)}:${port}`);
    for (const h of opts.allowedHosts) {
      const name = h.toLowerCase();
      // `host` (the bridge's port) or `host:port` / `[v6]:port`
      hosts.add(/:\d+$/.test(name) && (!name.includes("::") || name.startsWith("[")) ? name : `${hostForUrl(name)}:${port}`);
    }
    this.hosts = hosts;
    this.ownOrigins = new Set([...hosts].map((h) => `http://${h}`));
    this.allowedOrigins = new Set(opts.allowedOrigins.map(normaliseOrigin));
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** Host check only (used for every request, static files included). */
  checkHost(req: Request): Verdict | null {
    const host = req.headers.get("host")?.toLowerCase() ?? "";
    if (!this.hosts.has(host)) return { ok: false, status: 403, reason: `host "${host}" is not this bridge` };
    return null;
  }

  /** Full check for an API route (`/sessions*`, `/files*`, `/health`, `/ws`). */
  checkApi(req: Request, url: URL, opts: { allowQueryToken?: boolean } = {}): Verdict {
    const bad = this.checkHost(req);
    if (bad) return bad;

    if (this.token) {
      const auth = req.headers.get("authorization");
      const bearer = auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : null;
      const query = opts.allowQueryToken ? url.searchParams.get("access_token") : null;
      if (bearer !== null || query !== null) {
        if (tokenMatches(this.token, bearer ?? query)) {
          const origin = req.headers.get("origin");
          const corsOrigin = origin && this.allowedOrigins.has(origin) ? origin : null;
          return { ok: true, trusted: true, corsOrigin };
        }
        return { ok: false, status: 401, reason: "invalid bridge token" };
      }
    }

    const origin = req.headers.get("origin");
    if (origin !== null) {
      if (this.ownOrigins.has(origin.toLowerCase())) return { ok: true, trusted: true, corsOrigin: null };
      if (this.allowedOrigins.has(origin)) return { ok: true, trusted: true, corsOrigin: origin };
      return { ok: false, status: 403, reason: `origin "${origin}" is not allowed` };
    }
    const site = req.headers.get("sec-fetch-site");
    if (site !== null) {
      if (site === "same-origin") return { ok: true, trusted: true, corsOrigin: null };
      if (site !== "none") return { ok: false, status: 403, reason: `cross-site request (sec-fetch-site: ${site})` };
    }
    // A non-browser caller (or a browser navigation: sec-fetch-site none).
    if (this.token) return { ok: false, status: 401, reason: "missing bridge token" };
    return { ok: true, trusted: false, corsOrigin: null };
  }

  /** CORS headers for an allowed cross-origin request; never `*`. */
  static corsHeaders(origin: string | null): Record<string, string> {
    if (!origin) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-expose-headers": "x-file-path",
      vary: "origin",
    };
  }
}

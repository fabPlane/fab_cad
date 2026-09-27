/**
 * A session = one `FreeCADApiServer --listen ws://127.0.0.1:<port>/` process + the browser
 * WebSockets proxied to it. Each browser connection gets its own upstream connection, so the
 * server sees one client per tab (and sends each its events in the encoding that tab uses); frames
 * pass through byte for byte, text as text and binary as binary. The bridge never decodes them.
 *
 * `SessionManager` spawns, supervises and tears sessions down.
 */
import { createServer } from "node:net";
import type { ServerWebSocket } from "bun";
import { FreeCADClient, WebSocketTransport } from "@fab-cad/client";
import type { BridgeConfig } from "./config";
import { resolveInRoot } from "./files";

export type SessionState = "starting" | "running" | "exited" | "failed";

export interface WsData {
  session: Session;
  upstream: WebSocket | null;
  /** Frames from the browser waiting for the upstream connection to open. */
  backlog: (string | Uint8Array)[];
}

export interface SessionInfo {
  id: string;
  state: SessionState;
  path: string | null;
  /** The server's WebSocket URL (without the key). */
  url: string | null;
  pid: number | null;
  /** The FreeCAD instance token (from `GetServerInfo`). */
  token: string | null;
  exitCode: number | null;
  error: string | null;
  startedAt: string;
  readyAt: string | null;
  clients: number;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOG_LINES = 200;

/** A free TCP port on the loopback interface (closed again before it is returned). */
export function freePort(hostname = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, hostname, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function randomId(bytes = 8): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class Session {
  state: SessionState = "starting";
  url: string | null = null;
  token: string | null = null;
  exitCode: number | null = null;
  error: string | null = null;
  readonly startedAt = new Date();
  readyAt: Date | null = null;
  readonly clients = new Set<ServerWebSocket<WsData>>();
  readonly logLines: string[] = [];
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readonly key: string | null;
  private stopping = false;
  private readonly exitListeners = new Set<() => void>();

  constructor(
    private readonly cfg: BridgeConfig,
    readonly id: string,
    readonly path: string | null,
  ) {
    this.key = cfg.useKey ? randomId(16) : null;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** The URL the bridge dials, key included. */
  get upstreamUrl(): string | null {
    if (!this.url) return null;
    return this.key ? `${this.url}${this.url.includes("?") ? "&" : "?"}key=${encodeURIComponent(this.key)}` : this.url;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      state: this.state,
      path: this.path,
      url: this.url,
      pid: this.pid,
      token: this.token,
      exitCode: this.exitCode,
      error: this.error,
      startedAt: this.startedAt.toISOString(),
      readyAt: this.readyAt?.toISOString() ?? null,
      clients: this.clients.size,
    };
  }

  tailLog(lines = 20): string {
    return this.logLines.slice(-lines).join("\n");
  }

  onExit(cb: () => void): () => void {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  }

  /** Spawn the server and wait until it answers `Ping`. Throws (and cleans up) when it does not. */
  async start(): Promise<void> {
    const command = this.cfg.serverCommand;
    if (!command || command.length === 0) {
      this.fail("no FreeCAD API server: set FREECAD_API_SERVER or put FreeCADApiServer on PATH");
      throw new Error(this.error!);
    }
    const port = await freePort();
    const listen = `ws://127.0.0.1:${port}/`;
    this.url = listen;
    const argv = [
      ...command,
      "--listen",
      listen,
      ...(this.key ? ["--key", this.key] : []),
      ...this.cfg.serverArgs,
      ...(this.path ? [this.path] : []),
    ];
    this.log(`spawning ${argv.map((a) => (a === this.key ? "<key>" : a)).join(" ")}`);
    try {
      this.proc = Bun.spawn(argv, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (e) {
      this.fail(`spawning ${command[0]} failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(this.error!);
    }
    const proc = this.proc;
    void this.readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      // `FCAPI_READY <url>` tells the URL the server really bound (it may differ from ours).
      const m = /^FCAPI_READY (\S+)/.exec(line);
      if (m) this.url = m[1]!;
      this.log(line);
    });
    void this.readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => this.log(line));
    void proc.exited.then((code) => this.onProcessExit(code));

    try {
      await this.waitUntilReady();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await this.stop();
      this.state = "failed";
      this.error = why;
      throw new Error(why);
    }
    this.state = "running";
    this.readyAt = new Date();
    this.log(`ready at ${this.url} (token ${this.token})`);
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.cfg.startTimeoutMs;
    let lastError = "";
    let delay = 50;
    while (Date.now() < deadline) {
      if (this.exitCode !== null || this.state === "exited") {
        const tail = this.tailLog(5);
        throw new Error(`the FreeCAD API server exited with code ${this.exitCode} before it was ready${tail ? `:\n${tail}` : ""}`);
      }
      try {
        const transport = await WebSocketTransport.connect(this.upstreamUrl!, { connectTimeoutMs: 2000, defaultTimeoutMs: 5000 });
        try {
          const client = new FreeCADClient(transport, { clientName: `fab-cad/bridge/${this.id}`, encoding: "json" });
          await client.ping();
          this.token = (await client.getServerInfo()).token;
          return;
        } finally {
          await transport.close();
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(delay);
      delay = Math.min(500, delay * 2);
    }
    throw new Error(`the FreeCAD API server did not answer Ping within ${this.cfg.startTimeoutMs} ms (${lastError})`);
  }

  private onProcessExit(code: number | null): void {
    this.exitCode = code;
    if (this.state !== "failed") this.state = "exited";
    this.log(`server exited with code ${code}`);
    for (const ws of this.clients) {
      try {
        ws.close(this.stopping ? 1001 : 1011, this.stopping ? "session closed" : `FreeCAD exited with code ${code}`);
      } catch {
        /* gone */
      }
    }
    for (const cb of Array.from(this.exitListeners)) cb();
  }

  /** SIGTERM, then SIGKILL after the grace period. Closes every browser connection. */
  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, this.cfg.killGraceMs);
      await proc.exited;
      clearTimeout(t);
    }
    for (const ws of this.clients) {
      try {
        ws.close(1001, "session closed");
      } catch {
        /* gone */
      }
    }
    if (this.state === "starting" || this.state === "running") this.state = "exited";
  }

  // ------------------------------------------------------------------------------ proxy

  /** A browser connected: dial the server for it. */
  attach(ws: ServerWebSocket<WsData>): void {
    this.clients.add(ws);
    const url = this.upstreamUrl;
    if (this.state !== "running" || !url) {
      ws.close(1011, `session ${this.id} is ${this.state}`);
      return;
    }
    const up = new WebSocket(url);
    up.binaryType = "arraybuffer";
    ws.data.upstream = up;
    up.addEventListener("open", () => {
      for (const m of ws.data.backlog) up.send(m);
      ws.data.backlog = [];
    });
    up.addEventListener("message", (ev) => {
      const d = ev.data;
      try {
        ws.send(typeof d === "string" ? d : new Uint8Array(d as ArrayBuffer));
      } catch {
        /* the browser is gone */
      }
    });
    up.addEventListener("close", (ev) => {
      try {
        ws.close(ev.code === 1000 || ev.code === 1001 ? 1001 : 1011, "FreeCAD connection closed");
      } catch {
        /* already closed */
      }
    });
    up.addEventListener("error", () => {
      /* the close event follows */
    });
  }

  /** A browser frame: forward it (or hold it until the upstream connection is open). */
  forward(ws: ServerWebSocket<WsData>, message: string | Uint8Array): void {
    const up = ws.data.upstream;
    if (!up) return;
    if (up.readyState === WebSocket.OPEN) up.send(message);
    else if (up.readyState === WebSocket.CONNECTING) ws.data.backlog.push(message);
  }

  detach(ws: ServerWebSocket<WsData>): void {
    this.clients.delete(ws);
    const up = ws.data.upstream;
    ws.data.upstream = null;
    if (up && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) up.close(1000, "browser disconnected");
  }

  // ------------------------------------------------------------------------------ helpers

  private fail(message: string): void {
    this.state = "failed";
    this.error = message;
    this.log(message);
  }

  private log(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
    this.cfg.log(`session ${this.id}: ${line}`);
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      }
    } catch {
      /* the process is gone */
    }
    if (buf.trim()) onLine(buf.trim());
  }
}

export interface CreateSessionOptions {
  /** A `.FCStd` to open, relative to the workspace root (or absolute inside it). */
  path?: string | null;
  /** `[A-Za-z0-9_-]{1,64}`; random by default. */
  id?: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly cfg: BridgeConfig) {}

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  async create(opts: CreateSessionOptions = {}): Promise<Session> {
    const id = opts.id ?? randomId();
    if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id "${id}": must be [A-Za-z0-9_-]{1,64}`);
    if (this.sessions.has(id)) throw new Error(`session "${id}" already exists`);
    let path: string | null = null;
    if (opts.path) {
      path = await resolveInRoot(this.cfg.workspaceRoot, opts.path);
      if (!(await Bun.file(path).exists())) throw new Error(`file not found: ${opts.path}`);
    }
    const s = new Session(this.cfg, id, path);
    this.sessions.set(id, s);
    try {
      await s.start();
    } catch (e) {
      this.sessions.delete(id);
      throw e;
    }
    return s;
  }

  async destroy(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    await s.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }
}

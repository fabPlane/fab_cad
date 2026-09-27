/**
 * `startMockServer()` — the mock behind a WebSocket, the way `FreeCADApiServer --listen ws://…`
 * serves the real API: a text frame is a JSON request, a binary frame a CBOR (or UTF-8 JSON) one;
 * the reply goes back in the same encoding, and every event is pushed to every connection after
 * the reply of the request that raised it, in the encoding that connection used last.
 */
import type { Server, ServerWebSocket } from "bun";
import { decodeMessage, detectEncoding, encodeMessage, toMessage, type Encoding, type EventMessage } from "@fab-cad/protocol";
import { MockFreeCAD, type MockFreeCADOptions } from "./freecad";

export interface MockServerOptions extends MockFreeCADOptions {
  /** `0` picks a free port. Default 8765. */
  port?: number;
  hostname?: string;
  freecad?: MockFreeCAD;
  /** Require `?key=KEY` on the connection URL, like `FreeCADApiServer --key`. */
  key?: string;
  log?: (line: string) => void;
}

export interface MockServer {
  readonly url: string;
  readonly port: number;
  readonly hostname: string;
  readonly freecad: MockFreeCAD;
  /** Open WebSocket connections. */
  readonly connections: number;
  stop(): Promise<void>;
}

interface ConnData {
  encoding: Encoding;
}

export function startMockServer(opts: MockServerOptions = {}): MockServer {
  const hostname = opts.hostname ?? "127.0.0.1";
  const log = opts.log ?? (() => {});
  const sockets = new Set<ServerWebSocket<ConnData>>();
  let freecad: MockFreeCAD | undefined = opts.freecad;

  const server: Server<ConnData> = Bun.serve<ConnData>({
    port: opts.port ?? 8765,
    hostname,
    fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (opts.key && new URL(req.url).searchParams.get("key") !== opts.key) return new Response("Wrong or missing key", { status: 403 });
        if (srv.upgrade(req, { data: { encoding: "json" } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return Response.json({ name: "fab-cad mock FreeCAD API", protocol: 1, ws: url, token: freecad?.token });
    },
    websocket: {
      maxPayloadLength: 256 * 1024 * 1024,
      open(ws) {
        sockets.add(ws);
        log(`client connected (${sockets.size} open)`);
      },
      close(ws) {
        sockets.delete(ws);
        log(`client disconnected (${sockets.size} open)`);
      },
      message(ws, data) {
        const msg = toMessage(data);
        ws.data.encoding = detectEncoding(msg);
        let decoded: unknown;
        try {
          decoded = decodeMessage(msg);
        } catch (e) {
          const error = `cannot decode request: ${e instanceof Error ? e.message : String(e)}`;
          ws.send(encodeMessage({ id: null, status: "BAD_REQUEST", token: freecad!.token, error }, ws.data.encoding));
          return;
        }
        const { response, events } = freecad!.handle(decoded);
        ws.send(encodeMessage(response, ws.data.encoding));
        freecad!.publish(events);
      },
    },
  });

  const url = `ws://${hostname}:${server.port}/`;
  freecad ??= new MockFreeCAD({ transport: "ws", url, ...opts });
  const fc = freecad;
  const off = fc.onEvent((ev: EventMessage) => {
    const cache: Partial<Record<Encoding, string | Uint8Array>> = {};
    for (const ws of sockets) {
      const enc = ws.data.encoding;
      ws.send((cache[enc] ??= encodeMessage(ev, enc)));
    }
  });

  return {
    url,
    port: server.port!,
    hostname,
    freecad: fc,
    get connections() {
      return sockets.size;
    },
    async stop() {
      off();
      // `stop(true)` closes every connection itself. Its promise never settles once a WebSocket has
      // been closed from the server side (Bun 1.3), so closing them first would hang here, and the
      // wait is bounded for the same reason.
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    },
  };
}

# @fab-cad/bridge

A Bun server between the browser and FreeCAD, for the native backend:

- **Sessions**: `POST /sessions {path?, id?}` spawns `FreeCADApiServer --listen ws://127.0.0.1:<free port>/ --key <random> [path]`
  (found through `FREECAD_API_SERVER`, else on `PATH`), learns the bound URL from its `FCAPI_READY` line
  and waits until it answers `Ping`. `DELETE /sessions/:id` stops it (SIGTERM, then SIGKILL).
- **Proxy**: `GET /ws?session=<id>` upgrades to a WebSocket; each browser connection gets its own
  connection to the session's server and frames pass through unchanged (text = JSON, binary = CBOR).
  The per-session `--key` means only the bridge can dial the server.
- **Files**: `GET /files?dir=`, `GET /files/read?path=`, `PUT /files/write?path=`, confined to
  `WORKSPACE_ROOT` (symlinks included).
- **Static**: the built SPA from `STATIC_DIR` (default `apps/web/dist`), `index.html` for client routes.

```sh
FREECAD_API_SERVER="bun packages/mock-server/src/main.ts" bun packages/bridge/src/main.ts   # with the mock
FREECAD_API_SERVER=/path/to/FreeCADApiServer PORT=4030 WORKSPACE_ROOT=~/models bun packages/bridge/src/main.ts
```

Environment: `PORT` (4030), `HOST` (127.0.0.1), `FREECAD_API_SERVER`, `FREECAD_API_SERVER_ARGS`,
`FREECAD_API_KEY=0` (no key), `WORKSPACE_ROOT` (cwd), `STATIC_DIR`, `FREECAD_START_TIMEOUT_MS` (60000),
and the security settings below: `FAB_CAD_BRIDGE_TOKEN`, `FAB_CAD_BRIDGE_ALLOWED_ORIGINS`,
`FAB_CAD_BRIDGE_ALLOWED_HOSTS`, `FAB_CAD_BRIDGE_FRAME_ANCESTORS`.
The tests run the mock server as the FreeCAD binary; set `FREECAD_API_SERVER` to run them against a real one.

## Bridge security

The API reads and writes files under `WORKSPACE_ROOT`, and `/ws` reaches a FreeCAD that runs any
Python it is sent (`RunPython`). Listening on `127.0.0.1` does not keep that private:

- **Any web page the user has open** can send requests to `http://127.0.0.1:4030`. CORS only stops
  the page from reading some answers; the request (a file write, a new session) still runs, and
  WebSockets are not covered by CORS at all.
- **DNS rebinding**: a page on `evil.example` can re-point that name at `127.0.0.1` and then talk to
  the bridge as its own origin, reading every answer.

So every request is checked (`src/security.ts`):

1. **Host** (every path, the SPA too): the `Host` header must be the bridge itself:
   `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (plus `HOST`:`<port>` when `HOST` is a
   loopback name). Anything else is `403`, which defeats DNS rebinding. Only loopback is supported
   out of the box; to serve under another name (a reverse proxy, a container), list it in
   `FAB_CAD_BRIDGE_ALLOWED_HOSTS` (comma separated, `name` for the bridge's port or `name:port`).
2. **Browser checks** (API routes: `/health`, `/sessions*`, `/files*`, `/ws`): when a request has an
   `Origin`, it must be the bridge's own origin (any of the loopback spellings above) or be listed in
   `FAB_CAD_BRIDGE_ALLOWED_ORIGINS` (comma separated, exact `scheme://host:port`); otherwise `403`.
   Without an `Origin`, a `Sec-Fetch-Site` header must be `same-origin` or `none`; `same-site` and
   `cross-site` are `403`. The WebSocket upgrade is checked the same way (browsers always send
   `Origin` on it). There is no wildcard CORS: CORS headers are sent only to allowed cross-origin
   pages, echoing their own origin. `Origin: null` (sandboxed frames, `file://`) is refused unless
   `null` is listed, which is not advised.
3. **Token** (API routes): with `FAB_CAD_BRIDGE_TOKEN` set, a caller that is not a verified browser
   request from the bridge's own page (or an allowed origin) must send `Authorization: Bearer <token>`;
   on `/ws` only, `?access_token=<token>` is accepted too, for WebSocket clients that cannot set
   headers. The comparison is constant time; a missing token is `401`, a wrong one `401`. A valid
   token is accepted whatever the browser headers say (no web page can know it). Without
   `FAB_CAD_BRIDGE_TOKEN`, such callers are let through (dev, tests, the mock) and the bridge logs a
   warning at startup; set it whenever something else supervises the bridge. The token is never
   logged, and `access_token` is redacted from logged URLs.
4. **`/health`** is an API route under the same rules. Callers that are not trusted (no token
   configured and none of the above) get only `{ ok, name, uptimeSec }`; `workspaceRoot`,
   `serverCommand`, `staticDir` and the session list need a same-origin page or the token.
5. **The SPA** (`STATIC_DIR`) is public apart from the Host check: it holds no data. It is sent
   without CORS headers and with `X-Content-Type-Options: nosniff`. Set
   `FAB_CAD_BRIDGE_FRAME_ANCESTORS` (a CSP source list, e.g. `'self' http://localhost:5173`) to send
   `Content-Security-Policy: frame-ancestors …` and limit who may frame it. It is not set by default
   because the page is meant to be embedded: a desktop shell that frames it from `file://` or a
   custom scheme cannot be named reliably in `frame-ancestors`, and framing alone gives the parent
   no access to the API (the frame's own requests are same-origin, the parent's are not).

The bridge's own page needs no token: its `fetch` calls and `/ws` are same-origin. A supervising
process passes the token as a header, and `WebSocketTransport` takes it as an option:

```ts
await fetch(`${bridge}/sessions`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
const t = await WebSocketTransport.connect(`${wsBase}/ws?session=${id}`, { token }); // header in Bun, ?access_token= elsewhere
```

In development, Vite's proxy (`apps/web/vite.config.ts`) rewrites `Host` to the bridge and passes
requests whose `Origin` is the dev server itself on as the bridge's own; requests from other
origins are forwarded unchanged and refused. A page served from another origin with
`?bridge=<url>` needs that origin in `FAB_CAD_BRIDGE_ALLOWED_ORIGINS`.

Limits: the token keeps out callers that do not have it, but a local process can forge browser
headers (`Origin`, `Sec-Fetch-Site`) and pass as the bridge's own page; these checks are aimed at
browsers, not at other local users. Do not expose the bridge beyond loopback.

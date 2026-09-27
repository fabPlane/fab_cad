# 01 — Architecture: FreeCAD in the browser over the FreeCAD API

## What we build on

The fabPlane FreeCAD fork adds `src/Api`: a dispatcher that turns request bytes into reply bytes
over FreeCAD's application core (`App::Application`, no GUI), plus transports around it. The wire
format is `src/Api/PROTOCOL.md`; `packages/protocol/FREECAD_COMMIT` records the fork commit this
repository matches.

| Fact                                                                                                                                            | Where (fork)                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A message is a JSON object sent as JSON text or CBOR; the first byte tells them apart. Binary data is a CBOR byte string or `{"$bytes"}`.       | `Codec.cpp`                  |
| Request `{id, cmd, params, token, client}` → reply `{id, status, token, result \| error}`; events `{event, seq, data}`.                         | `Server.cpp`                 |
| Requests run one at a time, in order, on FreeCAD's main thread. Events a request raises go out after its reply.                                 | `Server.cpp`, `Executor.cpp` |
| Property values go through Python: tagged `Vector`, `Rotation`, `Placement`, `Matrix`, `Quantity`, `Object`, `Repr`.                            | `Values.cpp`                 |
| `Tessellate` sends per-face triangle ranges, edge polylines and vertices as little-endian bytes, in the global frame, with a shape `revision`.  | `HandlersGeometry.cpp`       |
| Each editing command is one undo step unless a transaction is open.                                                                             | `Transaction.h`              |
| `FreeCADApiServer --listen ws://…` prints `FCAPI_READY <url>`; `--key` guards the socket; `--stdio` uses length-prefixed pipes, events on fd 3. | `Main/MainApi.cpp`           |
| The C ABI (`fcapi_init/dispatch/free/shutdown/last_error`, events via `Module.__fcapiEvent`) is what the wasm build exports.                    | `ApiC.h`                     |

## System shape

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser (apps/web, docs/02-web-ui.md)                                        │
│  FreeCAD-like shell: tree, property editor, 3D view, workbench toolbars      │
│  @fab-cad/client: DocumentStore (live mirror + mesh cache) · FreeCADClient   │
│  @fab-cad/protocol: types, JSON/CBOR envelope, tessellation views            │
└──────────▲─────────────────────────────▲─────────────────────────▲───────────┘
           │ WebSocket (text = JSON,     │ WasmTransport           │ WasmTransport
           │ binary = CBOR)              │ (dispatchAsync)         │ (in-process)
┌──────────┴──────────────────┐ ┌────────┴───────────────────┐ ┌──┴──────────────────────┐
│ @fab-cad/bridge (Bun)       │ │ Web Worker                 │ │ @fab-cad/mock-server    │
│  • FreeCADApiServer per     │ │  @fab-cad/freecad-wasm     │ │  createMockDispatcher() │
│    session (--key, ping)    │ │  freecad_api.wasm + MEMFS  │ │  (also a ws:// server   │
│  • /ws proxy, frame for     │ └────────────────────────────┘ │   and a CLI that takes  │
│    frame, one upstream      │                                │   FreeCADApiServer's    │
│    connection per tab       │                                │   arguments)            │
│  • /files, static SPA       │                                └─────────────────────────┘
└──────────▲──────────────────┘
           │ ws://127.0.0.1:<port>/?key=…
┌──────────┴──────────────────────────────────────────────────┐
│ FreeCADApiServer (fork) — or FreeCADApi.startServer() in a  │
│ running desktop FreeCAD, which the page can dial directly   │
│  Api::Server::dispatch → App::Application (no GUI)          │
└─────────────────────────────────────────────────────────────┘
```

Why a bridge when the server speaks WebSocket itself: process supervision (one FreeCAD per
session, restarted or killed independently), a key only the bridge knows, the workspace file API
and static hosting. A page may still dial a `FreeCADApiServer` or a desktop FreeCAD directly (the
server's origin check allows `localhost` pages by default).

## Client layers

1. **Transport** — moves encoded messages. `WebSocketTransport` matches replies by `id` and
   pipelines; `StdioTransport` (Bun) and `WasmTransport` queue FIFO and match by position.
   `WasmTransport` dispatches from a microtask and delivers a request's events after its reply,
   the order the sockets give for free (the C ABI delivers them before `fcapi_dispatch` returns).
2. **`FreeCADClient`** — typed `call()` from the `Commands` map and one method per command; CBOR by
   default; pins the server token from the first reply and signals `restarted` when it changes;
   typed events with gap detection.
3. **`DocumentStore`** — `ListDocuments` + `GetObjects` + `GetProperties` once, then incremental:
   events mark objects stale and a debounced flush refetches just their info and changed
   properties. Meshes are cached by `(document, object, revision)` and refetched only when
   `ObjectRecomputed` or a `Placement`/`Shape` change says so. A restart or an event gap reloads.

## Session model

- One bridge serves many tabs; each **session** owns one `FreeCADApiServer` (its own documents,
  undo stacks and Python state). Each tab's WebSocket gets its own upstream connection, so FreeCAD
  sees one client per tab and reports it in `data.client` of the events the tab caused.
- The client pins the server's `token`; `TOKEN_MISMATCH` means the server restarted and the store
  reloads.
- In the wasm backend the session is the Worker: the same messages, no bridge, no host disk
  (documents enter and leave through MEMFS or `OpenDocumentBytes` / `SaveDocumentBytes`).

## Repo layout

```
fab_cad/
  apps/web/              the web UI (docs/02-web-ui.md)
  packages/protocol/     PROTOCOL.md in TypeScript; FREECAD_COMMIT pins the fork
  packages/client/       transports, FreeCADClient, DocumentStore
  packages/mock-server/  in-memory FreeCAD API (dispatcher, ws server, CLI)
  packages/freecad-wasm/ loader for freecad_api.wasm, worker host, fetch script
  packages/bridge/       Bun: FreeCADApiServer supervision, ws proxy, files, static
  tooling/ci/            per-package test runner
  tooling/icons/         FreeCAD icons and command texts for apps/web
  e2e/                   Playwright suites (mock smoke, real server, screenshots)
  docs/                  this
```

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
`FREECAD_API_KEY=0` (no key), `WORKSPACE_ROOT` (cwd), `STATIC_DIR`, `FREECAD_START_TIMEOUT_MS` (60000).
The tests run the mock server as the FreeCAD binary; set `FREECAD_API_SERVER` to run them against a real one.

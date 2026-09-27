# @fab-cad/mock-server

An in-memory fake of FreeCAD's API (PROTOCOL.md v1) for UI work and tests, until the real
`FreeCADApiServer` exists.

- Documents; objects of type `App::DocumentObjectGroup`, `Part::Box`, `Part::Cylinder`, `Part::Sphere`
  with FreeCAD's properties (`Label`, `Visibility`, `Placement`, `Length`/`Width`/`Height`, `Radius`, …),
  quantity coercion (`"1 in"`, `{"$type": "Quantity", …}`, plain numbers), dynamic properties and
  simple expressions (`Length * 2`, `Box.Width + 1 mm`, `<<Label>>.Height`).
- `Recompute` builds real triangulations (per-face ranges, edges, vertices, normals) in the global
  frame, with a `revision` that changes only when the shape does (undo restores the old one).
- Transactions: explicit (`OpenTransaction` …) and automatic (a modifying command outside a transaction
  gets its own, named like the GUI names it), undo/redo, and the events FreeCAD raises, coalesced
  per request and delivered after the reply.

Three ways to run it:

```ts
import { createMockDispatcher, MockFreeCAD } from "@fab-cad/mock-server";
import { startMockServer } from "@fab-cad/mock-server/server";

const wasmLike = createMockDispatcher({ demo: true }); // dispatch(bytes) -> bytes, like fcapi_dispatch
const server = startMockServer({ port: 0, demo: true }); // ws://127.0.0.1:<port>
```

```sh
bun packages/mock-server/src/main.ts --port 8765          # WebSocket, with the demo document
bun packages/mock-server/src/main.ts --listen ws://127.0.0.1:9000 --token secret --empty
bun packages/mock-server/src/main.ts --stdio              # length-prefixed stdin/stdout, events on fd 3
```

The CLI takes `FreeCADApiServer`'s arguments, so the bridge can run it in place of the real binary.

Deliberate differences from FreeCAD: `.FCStd` bytes are a JSON stand-in (not a zip), `Export` writes
only `stl` / `obj`, `Import` and `RunPython` are refused, and cylinder/sphere angles do not cut the mesh.

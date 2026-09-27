# @fab-cad/client

The FreeCAD API (`src/Api/PROTOCOL.md` in the fork) from TypeScript, in three layers.

## 1. Transports (`@fab-cad/client/transport`)

A `Transport` moves whole encoded messages: `send(message) → reply`, `onEvent`, `state`,
`onStateChange`, `close`.

| Transport            | Talks to                                                                       | Replies matched by |
| -------------------- | ------------------------------------------------------------------------------ | ------------------ |
| `WebSocketTransport` | `FreeCADApiServer --listen ws://…`, or the bridge's `/ws`                      | `id` (pipelined)   |
| `StdioTransport`     | a child `FreeCADApiServer --stdio` (Bun only; events on fd 3)                  | position (FIFO)    |
| `WasmTransport`      | a `FreeCadWasmInstance` (`@fab-cad/freecad-wasm`, or `createMockDispatcher()`) | position (FIFO)    |

`WasmTransport` never runs the module inside the caller's stack frame and delivers the events a
request raised after its reply has resolved, the order the socket transports get from the server.

## 2. `FreeCADClient`

```ts
const client = await FreeCADClient.connect(await WebSocketTransport.connect("ws://127.0.0.1:8765/"));
const box = await client.addObject(doc, "Part::Box", { properties: { Length: "25 mm" } });
await client.recompute(doc);
const [mesh] = await client.tessellate(doc, { objects: [box.name], normals: true });
client.on("ObjectChanged", ({ object, property }) => …);
```

- `call(cmd, params)` is typed from `Commands`; every command also has a method:
  `ping`, `getVersion`, `getServerInfo`, `getCommands`, `getTypes`, `loadModule`,
  `listDocuments`, `newDocument`, `openDocument`, `openDocumentBytes`, `saveDocument`,
  `saveDocumentAs`, `saveDocumentBytes`, `closeDocument`, `setActiveDocument`, `recompute`,
  `undo`, `redo`, `getUndoStack`, `openTransaction`, `commitTransaction`, `abortTransaction`,
  `getObjects`, `getObject`, `getProperties`, `setProperties`, `setExpression`, `addObject`,
  `removeObject`, `addProperty`, `removeProperty`, `tessellate` (decoded to typed arrays),
  `getBoundingBox`, `importFile` (`Import`), `exportObjects` (`Export`), `runPython`; plus
  `setProperty` and `transaction(doc, name, body)`.
- Requests go out as CBOR by default (`encoding: "json"` for readable traffic).
- The first reply's token is pinned and sent with every request. A restarted server (token
  mismatch) fires `onRestarted`, the new token is pinned, and the call throws `FreeCADApiError`.
- A non-`OK` reply throws `FreeCADApiError` with `status`, `command` and `serverMessage`.
- `on(event, cb)` / `on("*", cb)` / `next(event)`; `onGap` fires when a `seq` jumps.

## 3. `DocumentStore` (`@fab-cad/client/store`)

A live mirror of documents, objects (in document order) and properties: `load()` reads it all,
events mark what is stale, and a debounced flush refetches only that (one `GetProperties` and one
`GetObject` per touched object per burst). `subscribe(cb)` reports changes; `tessellate(doc)`
returns meshes from a `TessellationCache` keyed by `(doc, object, revision)` and fetches only
those invalidated by `ObjectRecomputed` or a `Placement`/`Shape` change. A restart or a sequence
gap reloads everything.

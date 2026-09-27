# @fab-cad/protocol

The FreeCAD API wire protocol (`src/Api/PROTOCOL.md` in the FreeCAD fork, version 1) in TypeScript.
No I/O: it runs the same in a page, a worker and Bun.

- `Commands` — command name → `{params, result}`; `Events` — event name → `data`. `COMMAND_NAMES` /
  `EVENT_NAMES` are the runtime lists (a compile-time check keeps them complete).
- `encodeMessage` / `encodeMessageBytes` / `decodeMessage` — the envelope in JSON or CBOR (`cbor-x`,
  plain RFC 8949: no records, no tag 64). Byte data is a plain `Uint8Array` after decoding in both
  encodings (JSON `{"$bytes": …}` is converted on the way in and out). `peekEnvelope` reads `id` /
  `event` without decoding a CBOR payload.
- `Vector`, `Rotation`, `Placement`, `Matrix`, `Quantity`, `ObjectRef`, `Repr` with `fromWire` /
  `toWire`; `vec()`, `quantity()`, `placement()`, `objectRef()` build wire values directly.
- `decodeTessellation` — `Float32Array` / `Uint32Array` views over the tessellation bytes (copied
  when a byte string is not 4-byte aligned).
- `parseQuantity` — lengths and angles, for input validation and the mock server.

`FREECAD_COMMIT` pins the fork commit this package matches (`unpinned` until the server lands).

## Where PROTOCOL.md was open

Settled by reading the fork's server (`src/Api/*.cpp`, uncommitted at the time), where its prose
and its code differ this package follows the code:

| Topic                      | What the server does, and what this package does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Tessellation.faces/edges` | Sent as **bytes** (uint32 pairs), not JSON arrays. Both forms decode; `decodeTessellation` gives `Uint32Array`s.      |
| `ObjectInfo.status`        | A string (`getStatusString()`: `Valid`, `Touched`, `Freezed` or the error text), not a list.                          |
| `typeHierarchy`            | Most derived first, up to (not including) `Base::BaseClass`.                                                          |
| `Placement` values         | Sent with `axis` and `angle` next to the quaternion; `rotation` is accepted as `[x,y,z,w]`, `{q}` or `{axis, angle}`. |
| Angle unit                 | `deg` (`Unit::getString()`); the user string is `90 °`.                                                               |
| `GetTypes`                 | Only types that can be instantiated; `NOT_FOUND` for an unknown base.                                                 |
| `GetServerInfo`            | `transport` is `ws`, `stdio` or `inproc`; there is also `gui`.                                                        |
| `PropertyInfo`             | May carry `expressionPath` when an expression binds a sub-path.                                                       |
| Events on WebSocket/stdio  | In the encoding of the connection's last request (JSON before the first); every connection gets every event.          |
| Events from the C ABI      | In `fcapi_init`'s `eventEncoding` (default CBOR), delivered before `fcapi_dispatch` returns.                          |
| `GetBoundingBox`           | `null` when nothing selected has geometry.                                                                            |
| `Import` result            | Internal names of the created objects.                                                                                |
| `Recompute.recomputed`     | A count.                                                                                                              |
| Unparseable request        | Reply with `id: null`, `status: "BAD_REQUEST"`.                                                                       |

Still open (the client sends what is described; the server may need a change):

| Topic                  | Issue                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `AddProperty` tooltip  | PROTOCOL.md lists `doc` twice and the server reads the tooltip from `doc`, i.e. the document name. This package sends `documentation`. |
| `GetObject.properties` | Read as a boolean (`params.value("properties", false)`); the spec does not say.                                                        |

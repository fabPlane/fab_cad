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

## Where PROTOCOL.md was open, and what this package assumes

| Topic                           | Assumption                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AddProperty` params            | The spec lists `doc` twice. `doc` is the document; the property's tooltip is `documentation`.                |
| `GetObject.properties`          | A boolean; `true` adds `properties: PropertyInfo[]` to the `ObjectInfo`.                                     |
| `ObjectInfo` lists              | `inList`, `outList`, `children`, `parents` are arrays of internal object names; `status` is flag names.      |
| `typeHierarchy`                 | Most derived type first, ending at `App::DocumentObject`.                                                    |
| `Tessellation.revision`         | A number (typed `number \| string`; the client only uses it as a cache key).                                 |
| `Tessellation.placement`        | A `Placement` tagged value (informational; positions are already global).                                    |
| `Tessellate` params             | `edges` defaults to `true`; `deflection` is an absolute length in mm; `angularDeflection` in degrees.        |
| `GetBoundingBox` result         | `{min: [x,y,z], max: [x,y,z]}`, or `null` when nothing selected has geometry.                                |
| `Import` result                 | Internal names of the created objects.                                                                       |
| `Recompute.recomputed`          | The number of objects recomputed.                                                                            |
| Event encoding on WebSocket     | Events use the encoding of the last request on that connection (JSON before the first); clients accept both. |
| Event fan-out                   | Every connection receives every event (so a tab sees changes other clients made).                            |
| JSON `$bytes`                   | Only an object whose single key is `$bytes` is bytes.                                                        |
| Reply to an unparseable request | `id: null`, `status: "BAD_REQUEST"`.                                                                         |

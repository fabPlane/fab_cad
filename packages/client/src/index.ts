/**
 * `@fab-cad/client` — the FreeCAD API from TypeScript, in three layers:
 *
 *   1. transports (`./transport`): `WebSocketTransport`, `StdioTransport` (Bun), `WasmTransport`;
 *   2. `FreeCADClient`: typed `call()`, one method per command, token pinning, typed events;
 *   3. `DocumentStore` (`./store`): a live mirror of documents, objects and properties, with a
 *      tessellation cache keyed by shape revision.
 *
 * The wire types and value helpers are re-exported from `@fab-cad/protocol`.
 */
export * from "@fab-cad/protocol";
export * from "./client";
export * from "./errors";
export * from "./transport/types";
export * from "./transport/websocket";
export * from "./transport/wasm";
export * from "./store/index";

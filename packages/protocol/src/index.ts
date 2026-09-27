/**
 * `@fab-cad/protocol` — the FreeCAD API wire protocol in TypeScript: command and event types
 * (`Commands`, `Events`), tagged property values, JSON / CBOR envelopes and tessellation views.
 * No I/O; everything here runs the same in a page, a worker and Bun.
 */
export * from "./commands";
export * from "./envelope";
export * from "./tessellation";
export * from "./units";
export * from "./values";

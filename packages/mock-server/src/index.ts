/**
 * `@fab-cad/mock-server` — an in-memory fake of FreeCAD's API for UI work and tests: the core
 * (`MockFreeCAD`), a bytes-in/bytes-out dispatcher shaped like the wasm C ABI
 * (`createMockDispatcher`), and a WebSocket server (`startMockServer`). `./stdio` (Bun only) and
 * `src/main.ts` (the CLI) complete the set.
 */
export * from "./freecad";
export * from "./dispatcher";
export * from "./geometry";
export * from "./expressions";
export { TYPES, typesDerivedFrom } from "./types";
export type { Prop, TypeDef } from "./types";

import type { Connection } from "./connect";

type Backend = Pick<Connection, "kind" | "serverInfo"> | null;

/** The transport does not identify the engine: a bridge can launch the mock too. */
export function isMockBackend(connection: Backend): boolean {
  return connection?.kind === "mock" || connection?.serverInfo?.platform === "mock";
}

export function backendLabel(connection: Backend): string {
  if (isMockBackend(connection)) return "Mock FreeCAD";
  return connection?.kind === "wasm" ? "FreeCAD (wasm)" : "FreeCAD";
}

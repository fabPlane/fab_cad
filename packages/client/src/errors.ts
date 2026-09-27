/**
 * Errors raised above the transport layer. `TransportError` (connection, timeout, framing) lives in
 * `./transport`; `FreeCADApiError` is about what the server answered.
 */
import type { Status } from "@fab-cad/protocol";

/** The server answered a request with a status other than `OK`. */
export class FreeCADApiError extends Error {
  override readonly name = "FreeCADApiError";

  constructor(
    readonly status: Exclude<Status, "OK">,
    /** The server's `error` text. */
    readonly serverMessage: string,
    readonly command: string,
  ) {
    super(`${command}: ${status}${serverMessage ? ` - ${serverMessage}` : ""}`);
  }

  static is(e: unknown, status?: Exclude<Status, "OK">): e is FreeCADApiError {
    return e instanceof FreeCADApiError && (status === undefined || e.status === status);
  }
}

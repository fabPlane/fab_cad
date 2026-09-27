/**
 * `createMockDispatcher()` — the mock behind the same shape as the wasm C ABI: one request's bytes
 * in, the reply's bytes out, synchronously, and events through a callback. The returned object
 * satisfies `FreeCadWasmInstance` from `@fab-cad/client`, so
 *
 *   const transport = new WasmTransport(createMockDispatcher({ demo: true }));
 *
 * runs the whole client stack in-process with no module and no socket.
 */
import { decodeMessage, detectEncoding, encodeMessageBytes, type Encoding, type EventMessage } from "@fab-cad/protocol";
import { MockFreeCAD, type MockFreeCADOptions } from "./freecad";

export interface MockDispatcherOptions extends MockFreeCADOptions {
  /** Share an existing instance (several dispatchers, one FreeCAD). */
  freecad?: MockFreeCAD;
  /**
   * When events reach `onEvent` listeners: `during` (default) calls them from inside `dispatch`,
   * before it returns — the worst case a real module can do, which `WasmTransport` must reorder;
   * `after` calls them from a microtask once `dispatch` has returned.
   */
  eventTiming?: "during" | "after";
  /** Encoding of event messages, fixed like `fcapi_init`'s `eventEncoding`. Default `cbor`. */
  eventEncoding?: Encoding;
}

export interface MockDispatcher {
  readonly freecad: MockFreeCAD;
  dispatch(request: Uint8Array): Uint8Array;
  onEvent(cb: (bytes: Uint8Array) => void): () => void;
  shutdown(): void;
  readonly isShutDown: boolean;
}

export function createMockDispatcher(opts: MockDispatcherOptions = {}): MockDispatcher {
  const freecad = opts.freecad ?? new MockFreeCAD({ transport: "inproc", ...opts });
  const timing = opts.eventTiming ?? "during";
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const eventEncoding: Encoding = opts.eventEncoding ?? "cbor";
  let closed = false;

  const offFreecad = freecad.onEvent((ev: EventMessage) => {
    if (closed) return;
    const bytes = encodeMessageBytes(ev, eventEncoding);
    for (const cb of Array.from(listeners)) cb(bytes);
  });

  return {
    freecad,
    dispatch(request: Uint8Array): Uint8Array {
      if (closed) throw new Error("the mock dispatcher has been shut down");
      let decoded: unknown;
      const encoding = detectEncoding(request);
      try {
        decoded = decodeMessage(request);
      } catch (e) {
        return encodeMessageBytes(
          {
            id: null,
            status: "BAD_REQUEST",
            token: freecad.token,
            error: `cannot decode request: ${e instanceof Error ? e.message : String(e)}`,
          },
          encoding,
        );
      }
      const { response, events } = freecad.handle(decoded);
      const reply = encodeMessageBytes(response, encoding);
      if (timing === "during") freecad.publish(events);
      else if (events.length) queueMicrotask(() => freecad.publish(events));
      return reply;
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    shutdown() {
      if (closed) return;
      closed = true;
      offFreecad();
      listeners.clear();
    },
    get isShutDown() {
      return closed;
    },
  };
}

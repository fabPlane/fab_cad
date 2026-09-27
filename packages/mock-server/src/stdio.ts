/**
 * The mock behind the stdio framing of `FreeCADApiServer --stdio`: `uint32 big-endian length ||
 * payload` requests on stdin, replies on stdout, events on fd 3 (each after the reply of the
 * request that raised it, in that request's encoding). Bun only.
 */
import { writeSync } from "node:fs";
import { decodeMessage, detectEncoding, encodeMessageBytes, type Encoding } from "@fab-cad/protocol";
import type { MockFreeCAD } from "./freecad";

export function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let off = 0;
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
}

/** Serve until stdin closes. Resolves then. */
export async function runStdioHost(freecad: MockFreeCAD, opts: { eventsFd?: number | null } = {}): Promise<void> {
  const eventsFd = opts.eventsFd === undefined ? 3 : opts.eventsFd;
  let encoding: Encoding = "json";
  let eventsOk = eventsFd !== null;
  freecad.onEvent((ev) => {
    if (!eventsOk) return;
    try {
      writeAll(eventsFd!, frame(encodeMessageBytes(ev, encoding)));
    } catch {
      eventsOk = false; // the parent did not open fd 3
    }
  });

  let buf = new Uint8Array(0);
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
    while (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (buf.length < 4 + len) break;
      const payload = buf.slice(4, 4 + len);
      buf = buf.subarray(4 + len);
      encoding = detectEncoding(payload);
      let decoded: unknown;
      try {
        decoded = decodeMessage(payload);
      } catch (e) {
        const error = `cannot decode request: ${e instanceof Error ? e.message : String(e)}`;
        writeAll(1, frame(encodeMessageBytes({ id: null, status: "BAD_REQUEST", token: freecad.token, error }, encoding)));
        continue;
      }
      const { response, events } = freecad.handle(decoded);
      writeAll(1, frame(encodeMessageBytes(response, encoding)));
      freecad.publish(events);
    }
  }
}

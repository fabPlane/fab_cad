#!/usr/bin/env bun
/**
 * A stand-in for `FreeCADApiServer --stdio` used by `stdio.test.ts`: the same framing
 * (`uint32be length || payload` on stdin/stdout, events on fd 3) but it echoes the request's `cmd`
 * as the result instead of running FreeCAD, so the transport can be tested without a build.
 *
 *   --delay <ms>       wait this long before answering each request
 *   --event-per-reply  publish one event per request on fd 3, right after the reply
 *   --exit-after <n>   exit(7) after answering n requests
 */
import { writeSync } from "node:fs";
import { decodeMessage, encodeMessageBytes, type Request } from "@fab-cad/protocol";

const argv = Bun.argv.slice(2);
const value = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback;
};
const delayMs = value("--delay", 0);
const exitAfter = value("--exit-after", 0);
const eventPerReply = argv.includes("--event-per-reply");

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

function write(fd: number, bytes: Uint8Array): void {
  let off = 0;
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
}

let buf = new Uint8Array(0);
let answered = 0;
let seq = 0;
const reader = Bun.stdin.stream().getReader();
for (;;) {
  const { done, value: chunk } = await reader.read();
  if (done) break;
  const next = new Uint8Array(buf.length + chunk.length);
  next.set(buf);
  next.set(chunk, buf.length);
  buf = next;
  while (buf.length >= 4) {
    const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
    if (buf.length < 4 + len) break;
    const payload = buf.slice(4, 4 + len);
    buf = buf.subarray(4 + len);
    const req = decodeMessage<Request>(payload);
    const enc = payload[0] === 0x7b ? "json" : "cbor";
    if (delayMs) await Bun.sleep(delayMs);
    write(1, frame(encodeMessageBytes({ id: req.id, status: "OK", token: "stdio-token", result: req.cmd }, enc)));
    if (eventPerReply) write(3, frame(encodeMessageBytes({ event: "Recomputed", seq: ++seq, data: { doc: String(req.cmd) } }, enc)));
    answered++;
    if (exitAfter && answered >= exitAfter) process.exit(7);
  }
}

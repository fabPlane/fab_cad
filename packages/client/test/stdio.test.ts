import { describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessage, type EventMessage, type Response } from "@fab-cad/protocol";
import { FreeCADClient } from "../src/client";
import { StdioFrameParser, StdioTransport, encodeStdioFrame } from "../src/transport/stdio";
import { TransportError } from "../src/transport/types";

const FAKE = `${import.meta.dir}/stdio-fake-server.ts`;
const MOCK = `${import.meta.dir}/../../mock-server/src/main.ts`;

describe("stdio framing", () => {
  test("frames split and merged across chunks", () => {
    const a = encodeStdioFrame(new Uint8Array([1, 2, 3]));
    const b = encodeStdioFrame(new Uint8Array([]));
    const c = encodeStdioFrame(new Uint8Array(1000).fill(9));
    const all = new Uint8Array([...a, ...b, ...c]);
    const p = new StdioFrameParser();
    const out: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += 7) out.push(...p.push(all.slice(i, i + 7)));
    expect(out.map((f) => f.length)).toEqual([3, 0, 1000]);
    expect(p.pending).toBe(0);
    expect(() => new StdioFrameParser(10).push(encodeStdioFrame(new Uint8Array(11)))).toThrow(/exceeds/);
  });
});

describe("StdioTransport", () => {
  test("replies are matched positionally; events come on fd 3", async () => {
    const t = await StdioTransport.connect({ command: "bun", args: [FAKE, "--event-per-reply"] });
    const events: string[] = [];
    t.onEvent((m) => events.push(decodeMessage<EventMessage<"Recomputed">>(m).data.doc));
    const replies = await Promise.all(["A", "B", "C"].map((cmd, i) => t.send(encodeMessage({ id: i, cmd }, i % 2 ? "json" : "cbor"))));
    expect(replies.map((r) => decodeMessage<Response>(r)).map((r) => (r.status === "OK" ? (r.result as unknown) : null))).toEqual([
      "A",
      "B",
      "C",
    ]);
    for (let i = 0; i < 50 && events.length < 3; i++) await Bun.sleep(10);
    expect(events).toEqual(["A", "B", "C"]);
    expect(t.eventsOpen).toBe(true);
    await t.close();
    expect(t.state).toBe("closed");
  });

  test("a timed-out request's late reply is dropped, not handed to the next caller", async () => {
    const t = await StdioTransport.connect({ command: "bun", args: [FAKE, "--delay", "150"] });
    const slow = t.send(encodeMessage({ id: 1, cmd: "Slow" }, "json"), { timeoutMs: 50 });
    const next = t.send(encodeMessage({ id: 2, cmd: "Next" }, "json"));
    expect(TransportError.is(await slow.catch((e) => e), "timeout")).toBe(true);
    const r = decodeMessage<Response>(await next);
    expect(r.status === "OK" && (r.result as unknown)).toBe("Next");
    await t.close();
  });

  test("the server exiting rejects pending requests", async () => {
    const t = await StdioTransport.connect({ command: "bun", args: [FAKE, "--exit-after", "1"] });
    await t.send(encodeMessage({ id: 1, cmd: "One" }, "cbor"));
    const err = await t.send(encodeMessage({ id: 2, cmd: "Two" }, "cbor")).catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.code).toBe("closed"); // "exited with code 7", or EPIPE if the write raced the exit
    expect(t.state).toBe("closed");
  });

  test("close() SIGTERMs, then SIGKILLs a server that ignores it", async () => {
    const script = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const t = await StdioTransport.connect({ command: "bun", args: ["-e", script], killGraceMs: 200 });
    await Bun.sleep(300); // let it install the handler
    const t0 = performance.now();
    await t.close();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(150);
    expect(t.state).toBe("closed");
  });

  test("the full client over the mock server's --stdio mode", async () => {
    const t = await StdioTransport.connect({ command: "bun", args: [MOCK, "--stdio", "--token", "abc"] });
    const client = new FreeCADClient(t);
    expect((await client.getServerInfo()).transport).toBe("stdio");
    expect(client.token).toBe("abc");
    const changed = client.next("ObjectChanged", { timeoutMs: 3000 });
    await client.setProperties("Demo", "Box", { Height: 3 });
    expect(await changed).toMatchObject({ object: "Box", property: "Height" });
    await client.close();
  });

  test("spawning a missing binary fails with a connect error", async () => {
    const err = await StdioTransport.connect({ command: "/nonexistent/FreeCADApiServer" }).catch((e) => e);
    expect(TransportError.is(err, "connect")).toBe(true);
  });
});

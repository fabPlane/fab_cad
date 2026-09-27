import { afterEach, describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessage, encodeMessageBytes, toMessage, type EventMessage, type Response } from "@fab-cad/protocol";
import { createMockDispatcher } from "../src/dispatcher";
import { startMockServer, type MockServer } from "../src/server";

describe("createMockDispatcher", () => {
  test("bytes in, bytes out, in the request's encoding; events during dispatch", () => {
    const d = createMockDispatcher({ eventEncoding: "json" });
    const log: string[] = [];
    d.onEvent((b) => log.push(`event:${decodeMessage<EventMessage>(b).event}`));
    for (const enc of ["json", "cbor"] as const) {
      const req = encodeMessageBytes({ id: 1, cmd: "NewDocument", params: {} }, enc);
      const reply = d.dispatch(req);
      log.push("reply");
      expect(reply[0] === 0x7b).toBe(enc === "json");
      expect(decodeMessage<Response>(reply).status).toBe("OK");
    }
    expect(log).toEqual([
      "event:DocumentCreated",
      "event:ActiveDocumentChanged",
      "reply",
      "event:DocumentCreated",
      "event:ActiveDocumentChanged",
      "reply",
    ]);
    const bad = decodeMessage<Response>(d.dispatch(new TextEncoder().encode("{nope")));
    expect(bad).toMatchObject({ id: null, status: "BAD_REQUEST" });
    d.shutdown();
    expect(() => d.dispatch(new Uint8Array([0xa0]))).toThrow();
  });

  test("eventTiming after", async () => {
    const d = createMockDispatcher({ eventTiming: "after" });
    const log: string[] = [];
    d.onEvent(() => log.push("event"));
    d.dispatch(encodeMessageBytes({ id: 1, cmd: "NewDocument" }, "cbor"));
    log.push("reply");
    await Promise.resolve();
    expect(log).toEqual(["reply", "event", "event"]);
  });
});

describe("startMockServer", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  interface Received {
    binary: boolean;
    m: Record<string, unknown>;
  }

  function open(url: string): Promise<{ ws: WebSocket; next: () => Promise<Received> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      const queue: Received[] = [];
      const waiters: ((m: Received) => void)[] = [];
      ws.onmessage = (ev) => {
        const r = { binary: typeof ev.data !== "string", m: decodeMessage<Record<string, unknown>>(toMessage(ev.data)) };
        const w = waiters.shift();
        if (w) w(r);
        else queue.push(r);
      };
      const next = () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Received>((r) => waiters.push(r)));
      ws.onopen = () => resolve({ ws, next });
      ws.onerror = () => reject(new Error("ws error"));
    });
  }

  test("text frames are JSON, binary frames CBOR; events follow the reply and reach every client", async () => {
    server = startMockServer({ port: 0 });
    const a = await open(server.url);
    const b = await open(server.url);
    a.ws.send(encodeMessage({ id: 1, cmd: "NewDocument", params: {}, client: "a" }, "json"));
    const r1 = await a.next();
    expect(r1.binary).toBe(false);
    expect(r1.m).toMatchObject({ id: 1, status: "OK", token: server.freecad.token });
    expect((await a.next()).m).toMatchObject({ event: "DocumentCreated", seq: 1, data: { client: "a" } });
    expect((await a.next()).m).toMatchObject({ event: "ActiveDocumentChanged", seq: 2 });
    expect((await b.next()).m).toMatchObject({ event: "DocumentCreated", seq: 1 });
    expect((await b.next()).m).toMatchObject({ event: "ActiveDocumentChanged", seq: 2 });

    b.ws.send(encodeMessage({ id: "x", cmd: "Recompute", params: { doc: "Unnamed" } }, "cbor"));
    const r2 = await b.next();
    expect(r2.binary).toBe(true);
    expect(r2.m).toMatchObject({ id: "x", status: "OK" });
    // the event reaches b as CBOR (its last encoding) and a as JSON
    const eb = await b.next();
    expect(eb).toMatchObject({ binary: true, m: { event: "Recomputed", seq: 3 } });
    expect(await a.next()).toMatchObject({ binary: false, m: { event: "Recomputed", seq: 3 } });
    a.ws.close();
    b.ws.close();
  });

  test("HTTP GET answers with server info", async () => {
    server = startMockServer({ port: 0, demo: true });
    const res = await fetch(server.url.replace("ws:", "http:"));
    expect(await res.json()).toMatchObject({ protocol: 1, token: server.freecad.token });
  });

  test("CLI --stdio speaks the length-prefixed framing", async () => {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/main.ts`, "--stdio", "--empty", "--token", "t1"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const payload = encodeMessageBytes({ id: 5, cmd: "GetServerInfo" }, "cbor");
    const framed = new Uint8Array(4 + payload.length);
    new DataView(framed.buffer).setUint32(0, payload.length, false);
    framed.set(payload, 4);
    proc.stdin.write(framed);
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    let buf = new Uint8Array(0);
    while (buf.length < 4 || buf.length < 4 + new DataView(buf.buffer).getUint32(0, false)) {
      const { value, done } = await reader.read();
      if (done) break;
      const n = new Uint8Array(buf.length + value.length);
      n.set(buf);
      n.set(value, buf.length);
      buf = n;
    }
    const len = new DataView(buf.buffer).getUint32(0, false);
    const reply = decodeMessage<Response<"GetServerInfo">>(buf.subarray(4, 4 + len));
    expect(reply).toMatchObject({ id: 5, status: "OK", token: "t1", result: { transport: "stdio", gui: false } });
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  test("CLI --listen prints FCAPI_READY with the port it got and enforces --key", async () => {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/main.ts`, "--listen", "ws://127.0.0.1:0/", "--key", "k1", "--quiet"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      const reader = proc.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      const m = /^FCAPI_READY (ws:\/\/127\.0\.0\.1:(\d+)\/)$/m.exec(text);
      expect(m).not.toBeNull();
      const url = m![1]!;
      const refused = await fetch(url.replace("ws:", "http:"), { headers: { upgrade: "websocket", connection: "upgrade" } });
      expect(refused.status).toBe(403);
      const ws = new WebSocket(`${url}?key=k1`);
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, cmd: "GetServerInfo" }));
        ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
        ws.onerror = () => reject(new Error("ws error"));
      });
      expect(reply).toMatchObject({ id: 1, status: "OK", result: { transport: "ws", url } });
      ws.close();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

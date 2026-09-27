import { describe, expect, test } from "bun:test";
import {
  decodeCbor,
  decodeIncoming,
  decodeJson,
  decodeMessage,
  detectEncoding,
  encodeCbor,
  encodeJson,
  encodeMessage,
  encodeMessageBytes,
  peekEnvelope,
  type Encoding,
  type EventMessage,
  type Request,
  type Response,
} from "../src/envelope";
import { base64ToBytes, bytesToBase64, objectRef, placement, quantity, vec } from "../src/values";

const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);

const request: Request<"SetProperties"> = {
  id: 7,
  cmd: "SetProperties",
  params: {
    doc: "Unnamed",
    object: "Box",
    values: {
      Length: quantity(25.4, "mm"),
      Placement: placement([1, 2, 3], [0, 0, 0.7071067811865476, 0.7071067811865476]),
      Direction: vec(0, 0, 1),
      Link: objectRef("Unnamed", "Cylinder"),
      LinkSub: [objectRef("Unnamed", "Cylinder"), ["Face1", "Edge2"]],
      Blob: bytes,
      Nested: { list: [1, "two", true, null, { deep: bytes }] },
    },
  },
  token: "",
  client: "fab-cad/test",
};

describe("envelope round trips", () => {
  for (const encoding of ["json", "cbor"] as Encoding[]) {
    test(`${encoding}: request with tagged values and bytes`, () => {
      const wire = encodeMessage(request, encoding);
      expect(typeof wire === "string").toBe(encoding === "json");
      const back = decodeMessage<Request<"SetProperties">>(wire);
      expect(back).toEqual(request);
      const blob = back.params!.values.Blob as Uint8Array;
      expect(blob).toBeInstanceOf(Uint8Array);
      expect(blob.constructor).toBe(Uint8Array);
      expect(Array.from(blob)).toEqual(Array.from(bytes));
      const deep = ((back.params!.values.Nested as { list: unknown[] }).list[4] as { deep: Uint8Array }).deep;
      expect(deep.constructor).toBe(Uint8Array);
    });

    test(`${encoding}: byte-channel encoding decodes the same`, () => {
      const wire = encodeMessageBytes(request, encoding);
      expect(wire).toBeInstanceOf(Uint8Array);
      expect(detectEncoding(wire)).toBe(encoding);
      expect(decodeMessage<object>(wire)).toEqual(request);
    });

    test(`${encoding}: responses and events`, () => {
      const ok: Response<"SaveDocumentBytes"> = { id: 3, status: "OK", token: "tok", result: { data: bytes, fileName: "a.FCStd" } };
      const err: Response = { id: null, status: "BAD_REQUEST", token: "tok", error: "no cmd" };
      const ev: EventMessage<"ObjectChanged"> = {
        event: "ObjectChanged",
        seq: 42,
        data: { doc: "D", object: "Box", property: "Length", client: "x" },
      };
      for (const m of [ok, err, ev]) expect(decodeIncoming(encodeMessage(m, encoding))).toEqual(m);
    });
  }

  test("CBOR byte strings are plain major-type-2, not tagged", () => {
    const enc = encodeCbor({ b: new Uint8Array([9]) });
    // a1 61 62 41 09 : map(1) "b" bytes(1) 0x09
    expect(Array.from(enc)).toEqual([0xa1, 0x61, 0x62, 0x41, 0x09]);
  });

  test("undefined members are dropped in both encodings", () => {
    const m = { id: 1, cmd: "Ping", params: { a: undefined, b: 1 }, token: undefined };
    expect(decodeJson<object>(encodeJson(m))).toEqual({ id: 1, cmd: "Ping", params: { b: 1 } });
    expect(decodeCbor<object>(encodeCbor(m))).toEqual({ id: 1, cmd: "Ping", params: { b: 1 } });
  });

  test("JSON $bytes is only recognised as a single-key object", () => {
    const v = decodeJson<{ a: unknown; b: unknown }>('{"a":{"$bytes":"AAE="},"b":{"$bytes":"AAE=","x":1}}');
    expect(v.a).toBeInstanceOf(Uint8Array);
    expect(v.b).toEqual({ $bytes: "AAE=", x: 1 });
  });

  test("detectEncoding", () => {
    expect(detectEncoding("{}")).toBe("json");
    expect(detectEncoding(new TextEncoder().encode('  {"id":1}'))).toBe("json");
    expect(detectEncoding(encodeCbor({ id: 1 }))).toBe("cbor");
  });
});

describe("peekEnvelope", () => {
  for (const encoding of ["json", "cbor"] as Encoding[]) {
    test(`${encoding}: finds id and event without the payload`, () => {
      const big = new Uint8Array(100_000).fill(7);
      expect(peekEnvelope(encodeMessage({ status: "OK", result: { big }, id: 12345, token: "t" }, encoding))).toEqual({ id: 12345 });
      expect(peekEnvelope(encodeMessage({ id: "abc", status: "OK" }, encoding))).toEqual({ id: "abc" });
      expect(peekEnvelope(encodeMessage({ id: null, status: "BAD_REQUEST" }, encoding))).toEqual({ id: null });
      expect(peekEnvelope(encodeMessage({ id: -3, status: "OK" }, encoding))).toEqual({ id: -3 });
      expect(peekEnvelope(encodeMessage({ event: "Recomputed", seq: 1, data: { doc: "D" } }, encoding))).toEqual({ event: "Recomputed" });
    });
  }

  test("cbor: float ids and nested maps are skipped correctly", () => {
    expect(peekEnvelope(encodeCbor({ result: { a: [1.5, { b: "x" }], c: -1e300 }, id: 2.5 }))).toEqual({ id: 2.5 });
  });
});

describe("base64", () => {
  test("round trips every length", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      const s = bytesToBase64(b);
      expect(s).toBe(Buffer.from(b).toString("base64"));
      expect(Array.from(base64ToBytes(s))).toEqual(Array.from(b));
    }
  });

  test("large input", () => {
    const b = Uint8Array.from({ length: 300_001 }, (_, i) => i & 255);
    expect(bytesToBase64(b)).toBe(Buffer.from(b).toString("base64"));
  });

  test("url-safe and unpadded input", () => {
    expect(Array.from(base64ToBytes("-_8"))).toEqual([0xfb, 0xff]);
    expect(() => base64ToBytes("a*b")).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES, EVENT_NAMES, isCommandName, isEventName } from "../src/commands";
import {
  decodeTessellation,
  faceIndexRange,
  faceOfTriangle,
  float32Bytes,
  float32View,
  uint32Bytes,
  uint32View,
} from "../src/tessellation";
import { parseQuantity } from "../src/units";
import { Matrix, ObjectRef, Placement, Quantity, Repr, Rotation, Vector, fromWire, toWire, type WireValue } from "../src/values";

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("value classes", () => {
  test("fromWire / toWire round trip, recursively", () => {
    const wire: WireValue = {
      v: { $type: "Vector", x: 1, y: 2, z: 3 },
      p: { $type: "Placement", base: [1, 2, 3], rotation: [0, 0, 0, 1] },
      q: { $type: "Quantity", value: 10, unit: "mm", text: "10 mm" },
      o: [{ $type: "Object", doc: "D", name: "Box" }, ["Face1"]],
      r: { $type: "Repr", type: "Part.Shape", repr: "<Shape>" },
      m: { $type: "Matrix", a: [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1] },
      plain: [1, "a", true, null],
    };
    const v = fromWire(wire) as Record<string, unknown>;
    expect(v.v).toBeInstanceOf(Vector);
    expect(v.p).toBeInstanceOf(Placement);
    expect(v.q).toBeInstanceOf(Quantity);
    expect((v.o as unknown[])[0]).toBeInstanceOf(ObjectRef);
    expect(v.r).toBeInstanceOf(Repr);
    expect(v.m).toBeInstanceOf(Matrix);
    expect(toWire(v as never)).toEqual(wire);
  });

  test("rotation from axis/angle and back", () => {
    const r = Rotation.fromWire({ $type: "Rotation", axis: [0, 0, 2], angle: 90 });
    close(r.angle, 90);
    expect(r.axis.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([0, 0, 1]);
    const p = r.apply(new Vector(1, 0, 0));
    close(p.x, 0);
    close(p.y, 1);
    expect(Rotation.identity().axis).toEqual([0, 0, 1]);
  });

  test("placement composition, inverse and matrix", () => {
    const a = new Placement(new Vector(10, 0, 0), Rotation.fromAxisAngle([0, 0, 1], 90));
    const pt = a.apply(new Vector(1, 0, 0));
    close(pt.x, 10);
    close(pt.y, 1);
    const back = a.inverse().apply(pt);
    close(back.x, 1);
    close(back.y, 0);
    const m = a.toMatrix();
    close(m.at(0, 3), 10);
    close(m.at(1, 0), 1);
    const cm = m.toColumnMajor();
    expect(cm[12]).toBe(10);
    const ab = a.multiply(a);
    close(ab.rotation.angle, 180);
  });
});

describe("tessellation views", () => {
  test("aligned bytes are viewed in place, misaligned copied", () => {
    const f = new Float32Array([1.5, -2, 3]);
    const aligned = float32Bytes(f);
    const v = float32View(aligned);
    expect(v.buffer).toBe(aligned.buffer);
    expect(Array.from(v)).toEqual([1.5, -2, 3]);

    const backing = new Uint8Array(aligned.length + 1);
    backing.set(aligned, 1);
    const mis = backing.subarray(1);
    const c = float32View(mis);
    expect(c.buffer).not.toBe(backing.buffer);
    expect(Array.from(c)).toEqual([1.5, -2, 3]);
    expect(Array.from(uint32View(uint32Bytes([1, 2, 4294967295])))).toEqual([1, 2, 4294967295]);
    expect(() => float32View(new Uint8Array(3))).toThrow();
  });

  test("decodeTessellation and face lookup", () => {
    const t = decodeTessellation({
      object: "Box",
      placement: { $type: "Placement", base: [0, 0, 0], rotation: [0, 0, 0, 1] },
      revision: 3,
      positions: float32Bytes([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      indices: uint32Bytes([0, 1, 2, 1, 3, 2]),
      faces: [
        [0, 1],
        [1, 1],
      ],
      edges: [[0, 2]],
      edgePositions: float32Bytes([0, 0, 0, 1, 0, 0]),
      vertices: float32Bytes([0, 0, 0]),
    });
    expect(t.vertexCount).toBe(4);
    expect(t.triangleCount).toBe(2);
    expect(t.normals).toBeUndefined();
    expect(faceOfTriangle(t, 1)).toBe(1);
    expect(faceOfTriangle(t, 5)).toBe(-1);
    expect(faceIndexRange(t, 1)).toEqual([3, 6]);
  });
});

describe("units", () => {
  test("parses lengths and angles", () => {
    expect(parseQuantity("25.4 mm")).toEqual({ value: 25.4, dimension: "length", unit: "mm" });
    expect(parseQuantity("1 in").value).toBeCloseTo(25.4);
    expect(parseQuantity("1ft 1in").value).toBeCloseTo(330.2);
    expect(parseQuantity("90°")).toEqual({ value: 90, dimension: "angle", unit: "°" });
    expect(parseQuantity("3.5").dimension).toBe("none");
    expect(parseQuantity("2,5 cm").value).toBeCloseTo(25);
    expect(() => parseQuantity("1 mm 2 deg")).toThrow();
    expect(() => parseQuantity("abc")).toThrow();
  });
});

test("command and event lists", () => {
  expect(COMMAND_NAMES.length).toBe(36);
  expect(EVENT_NAMES.length).toBe(16);
  expect(isCommandName("Tessellate")).toBe(true);
  expect(isCommandName("Nope")).toBe(false);
  expect(isEventName("Undo")).toBe(true);
});

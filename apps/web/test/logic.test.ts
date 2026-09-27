import { describe, expect, test } from "bun:test";
import type { ObjectInfo } from "@fab-cad/protocol";
import { chooseBackend, checkWasmBuild, detectBridge } from "../src/backend/connect";
import { fixed, formatPoint, formatQuantity, pyNum, pyStr, splitCamelCase } from "../src/lib/format";
import { buildTree, claimedChildren, flattenTree, pathsTo } from "../src/tree/buildTree";
import { objectIcon } from "../src/ui/icons";
import { buttonsFromMask, dragAction } from "../src/viewer/navigation";
import { chooseCandidate, parseSubName, pickEdge, pickVertex, pointSegmentDistance, subName } from "../src/viewer/picking";
import { autoHorVer, constraintPy, gridStep, rectanglePy, sketchVertices, type SketchGeo } from "../src/sketcher/model";

describe("format", () => {
  test("FreeCAD's two-decimal user strings", () => {
    expect(fixed(10)).toBe("10.00");
    expect(fixed(-0.0001)).toBe("0.00");
    expect(formatQuantity(25.4, "mm")).toBe("25.40 mm");
    expect(formatQuantity(90, "deg")).toBe("90.00 °");
    expect(formatPoint([12.3, 4.5, 10])).toBe("(12.30 mm, 4.50 mm, 10.00 mm)");
  });

  test("property names are split like PropertyItem::setPropertyName", () => {
    expect(splitCamelCase("ShapeColor")).toBe("Shape Color");
    expect(splitCamelCase("AttachmentSupport")).toBe("Attachment Support");
    expect(splitCamelCase("MapMode")).toBe("Map Mode");
    expect(splitCamelCase("X2min")).toBe("X2min");
    expect(splitCamelCase("UseAllEdges")).toBe("Use All Edges");
  });

  test("python literals", () => {
    expect(pyStr("a'b")).toBe("'a\\'b'");
    expect(pyNum(10)).toBe("10.0");
    expect(pyNum(0.1 + 0.2)).toBe("0.3");
  });
});

const O = (name: string, type: string, extra: Partial<ObjectInfo> = {}): ObjectInfo => ({
  name,
  label: name,
  type,
  typeHierarchy: [type],
  isGeo: true,
  isValid: true,
  isTouched: false,
  isError: false,
  status: "Valid",
  inList: [],
  outList: [],
  children: [],
  parents: [],
  visibility: true,
  ...extra,
});

/** What the real server reports for a body with a padded sketch (see docs/02-web-ui.md). */
const bodyDoc: ObjectInfo[] = [
  O("Box", "Part::Box"),
  O("Body", "PartDesign::Body", { children: ["Origin", "Sketch", "Pad"], outList: ["Origin", "Sketch", "Pad"] }),
  O("Origin", "App::Origin", {
    parents: ["Body"],
    inList: ["Body"],
    outList: ["X_Axis", "Y_Axis", "Z_Axis", "XY_Plane", "XZ_Plane", "YZ_Plane", "Origin001"],
  }),
  O("X_Axis", "App::Line", { inList: ["Origin"] }),
  O("Y_Axis", "App::Line", { inList: ["Origin"] }),
  O("Z_Axis", "App::Line", { inList: ["Origin"] }),
  O("XY_Plane", "App::Plane", { inList: ["Origin", "Sketch"] }),
  O("XZ_Plane", "App::Plane", { inList: ["Origin"] }),
  O("YZ_Plane", "App::Plane", { inList: ["Origin"] }),
  O("Origin001", "App::Point", { inList: ["Origin"] }),
  O("Sketch", "Sketcher::SketchObject", { parents: ["Body", "Pad"], inList: ["Body", "Pad"] }),
  O("Pad", "PartDesign::Pad", { children: ["Sketch"], parents: ["Body"], inList: ["Body"] }),
];

describe("tree building", () => {
  test("bodies nest their origin and features; the origin claims its datum features; a profile sits under its feature", () => {
    const tree = buildTree(bodyDoc);
    expect(tree.map((n) => n.name)).toEqual(["Box", "Body"]);
    const body = tree[1]!;
    expect(body.children.map((n) => n.name)).toEqual(["Origin", "Pad"]);
    expect(body.children[0]!.children.map((n) => n.name)).toEqual([
      "X_Axis",
      "Y_Axis",
      "Z_Axis",
      "XY_Plane",
      "XZ_Plane",
      "YZ_Plane",
      "Origin001",
    ]);
    expect(body.children[1]!.children.map((n) => n.name)).toEqual(["Sketch"]);
  });

  test("keys are unique paths; flatten follows the expanded set", () => {
    const tree = buildTree(bodyDoc);
    const rows = flattenTree(tree, new Set(["Body"]));
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual(["0:Box", "0:Body", "1:Origin", "1:Pad"]);
    expect(rows[3]!.node.key).toBe("Body/Pad");
    const all = flattenTree(tree, new Set(["Body", "Body/Pad"]));
    expect(all.at(-1)!.node.key).toBe("Body/Pad/Sketch");
    expect(pathsTo(tree, "Sketch")).toEqual(["Body", "Body/Pad"]);
  });

  test("groups nest their members, cycles do not recurse forever", () => {
    const objs = [
      O("Group", "App::DocumentObjectGroup", { children: ["A"] }),
      O("A", "Part::Box", { parents: ["Group"], children: ["Group"] }),
    ];
    const tree = buildTree(objs);
    expect(tree.map((n) => n.name)).toEqual([]);
    const loose = buildTree([
      O("G", "App::DocumentObjectGroup", { children: ["B"] }),
      O("B", "Part::Box", { parents: ["G"] }),
      O("C", "Part::Sphere"),
    ]);
    expect(loose.map((n) => `${n.name}[${n.children.map((c) => c.name).join(",")}]`)).toEqual(["G[B]", "C[]"]);
    expect(claimedChildren(bodyDoc).get("Body")).toEqual(["Origin", "Pad"]);
  });

  test("tree icons follow the view providers' pixmaps", () => {
    expect(objectIcon("Part::Box")).toBe("Part_Box_Parametric");
    expect(objectIcon("PartDesign::Body")).toBe("PartDesign_Body");
    expect(objectIcon("Sketcher::SketchObject")).toBe("Sketcher_Sketch");
    expect(objectIcon("Part::MultiFuse")).toBe("Part_Fuse");
    expect(objectIcon("Part::Something", ["Part::Something", "Part::Feature"])).toBe("Part_3D_object");
    expect(objectIcon("Foo::Bar")).toBe("Feature");
  });
});

describe("picking", () => {
  const project = (x: number, y: number, z: number): [number, number, number] => [x, y, z];

  test("point to segment distance", () => {
    expect(pointSegmentDistance(5, 3, 0, 0, 10, 0)).toEqual({ d: 3, t: 0.5 });
    expect(pointSegmentDistance(-4, 3, 0, 0, 10, 0).d).toBe(5);
  });

  test("edges and vertices within the pick radius", () => {
    // two edges: (0,0)-(10,0) and (0,10)-(10,10)
    const pts = [0, 0, 0.5, 10, 0, 0.5, 0, 10, 0.2, 10, 10, 0.2];
    const edges = [0, 2, 2, 2];
    expect(pickEdge(pts, edges, 5, 2, project)?.edge).toBe(0);
    expect(pickEdge(pts, edges, 5, 8, project)?.edge).toBe(1);
    expect(pickEdge(pts, edges, 5, 5, project, 4)).toBeNull();
    const v = pickVertex([0, 0, 0, 10, 10, 0], 9, 11, project);
    expect(v?.vertex).toBe(1);
    expect(pickVertex([0, 0, 0], 20, 20, project)).toBeNull();
  });

  test("vertices beat edges beat faces unless they are behind the face", () => {
    const face = { depth: 0.5, n: "face" };
    const edge = { depth: 0.5, n: "edge" };
    const vertex = { depth: 0.9, n: "vertex" };
    expect(chooseCandidate(face, edge, vertex)?.n).toBe("edge");
    expect(chooseCandidate(face, edge, { depth: 0.5, n: "v" })?.n).toBe("v");
    expect(chooseCandidate(face, { depth: 0.8, n: "hidden edge" }, null)?.n).toBe("face");
    expect(chooseCandidate(null, edge, null)?.n).toBe("edge");
  });

  test("sub-element names", () => {
    expect(subName("Face", 0)).toBe("Face1");
    expect(parseSubName("Edge12")).toEqual({ kind: "Edge", index: 11 });
    expect(parseSubName("Body")).toBeNull();
  });
});

describe("navigation styles", () => {
  const none = { shift: false, ctrl: false, alt: false };
  test("Gesture: left rotates, right and middle pan", () => {
    expect(dragAction("Gesture", buttonsFromMask(1), none)).toBe("rotate");
    expect(dragAction("Gesture", buttonsFromMask(2), none)).toBe("pan");
    expect(dragAction("Gesture", buttonsFromMask(4), none)).toBe("pan");
  });
  test("CAD: middle pans, middle + left rotates, left alone selects", () => {
    expect(dragAction("CAD", buttonsFromMask(4), none)).toBe("pan");
    expect(dragAction("CAD", buttonsFromMask(5), none)).toBe("rotate");
    expect(dragAction("CAD", buttonsFromMask(1), none)).toBeNull();
  });
  test("OpenInventor, Blender, TinkerCAD", () => {
    expect(dragAction("OpenInventor", buttonsFromMask(1), none)).toBe("rotate");
    expect(dragAction("OpenInventor", buttonsFromMask(5), none)).toBe("zoom");
    expect(dragAction("Blender", buttonsFromMask(4), none)).toBe("rotate");
    expect(dragAction("Blender", buttonsFromMask(4), { ...none, shift: true })).toBe("pan");
    expect(dragAction("TinkerCAD", buttonsFromMask(2), none)).toBe("rotate");
  });
});

describe("sketcher model", () => {
  const geo: SketchGeo[] = [
    { i: 0, type: "LineSegment", construction: false, start: [0, 0], end: [10, 0] },
    { i: 1, type: "Circle", construction: false, center: [5, 5], radius: 2 },
    { i: 2, type: "ArcOfCircle", construction: false, center: [0, 0], radius: 1, start: [1, 0], end: [0, 1], a1: 0, a2: Math.PI / 2 },
    { i: 3, type: "Point", construction: false, point: [3, 3] },
  ];

  test("vertices are numbered like SketchObject::getGeoVertexIndex", () => {
    expect(sketchVertices(geo).map((v) => `${v.n}:${v.geo}.${v.pos}`)).toEqual([
      "1:0.1",
      "2:0.2",
      "3:1.3",
      "4:2.1",
      "5:2.2",
      "6:2.3",
      "7:3.1",
    ]);
  });

  test("the rectangle tool writes FreeCAD's geometry and constraint lists", () => {
    const lines = rectanglePy([0, 0], [10, 5], 4);
    expect(lines[0]).toBe("geoList = []");
    expect(lines[1]).toBe("geoList.append(Part.LineSegment(App.Vector(0.0,0.0,0),App.Vector(10.0,0.0,0)))");
    expect(lines).toContain("constraintList.append(Sketcher.Constraint('Coincident', 7, 2, 4, 1))");
    expect(lines).toContain("constraintList.append(Sketcher.Constraint('Horizontal', 6))");
    expect(lines).toContain("constraintList.append(Sketcher.Constraint('Vertical', 5))");
    expect(lines.at(-2)).toBe("ActiveSketch.addConstraint(constraintList)");
  });

  test("constraints, auto horizontal/vertical, grid", () => {
    expect(constraintPy("Distance", 0, 12.5)).toBe("Sketcher.Constraint('Distance', 0, 12.5)");
    expect(autoHorVer([0, 0], [10, 0.1])).toBe("Horizontal");
    expect(autoHorVer([0, 0], [-0.2, -10])).toBe("Vertical");
    expect(autoHorVer([0, 0], [10, 5])).toBeNull();
    expect(gridStep(100, 20)).toBe(5);
    expect(gridStep(1000, 20)).toBe(50);
  });
});

describe("backend choice", () => {
  test("URL parameters", () => {
    expect(chooseBackend("?mock=1")).toEqual({ kind: "mock", demo: false });
    expect(chooseBackend("?mock=demo")).toEqual({ kind: "mock", demo: true });
    expect(chooseBackend("?ws=ws://127.0.0.1:8765/")).toEqual({ kind: "ws", url: "ws://127.0.0.1:8765/" });
    expect(chooseBackend("?wasm=1")).toEqual({ kind: "wasm", moduleUrl: "/freecad-wasm/freecad_api.js" });
    expect(chooseBackend("?wasm=/x/freecad_api.js")).toEqual({ kind: "wasm", moduleUrl: "/x/freecad_api.js" });
    expect(chooseBackend("?bridge=1")).toEqual({ kind: "bridge", base: "" });
    expect(chooseBackend("")).toEqual({ kind: "auto" });
    expect(chooseBackend("", { VITE_BACKEND: "mock" })).toEqual({ kind: "mock", demo: false });
  });

  test("the bridge is recognised by its /health answer", async () => {
    const ok = (async () => new Response(JSON.stringify({ ok: true, name: "@fab-cad/bridge", sessions: [] }))) as unknown as typeof fetch;
    const other = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await detectBridge("", ok)).toBe(true);
    expect(await detectBridge("", other)).toBe(false);
    expect(await detectBridge("", down)).toBe(false);
  });

  test("a missing wasm build is reported, not loaded", async () => {
    const missing = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const spa = (async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const present = (async () =>
      new Response("", { status: 200, headers: { "content-type": "application/wasm" } })) as unknown as typeof fetch;
    expect(await checkWasmBuild("/freecad-wasm/freecad_api.js", missing)).toContain("freecad_api.js is not there");
    expect(await checkWasmBuild("/freecad-wasm/freecad_api.js", spa)).toContain("is not there");
    expect(await checkWasmBuild("/freecad-wasm/freecad_api.js", present)).toBeNull();
  });
});

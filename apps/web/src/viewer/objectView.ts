/**
 * One document object in the 3D view: faces (a mesh), edges (fat line segments), vertices
 * (points), built from its `Tessellation`, styled from its view properties and the view's draw
 * style, with sub-element highlight overlays (FreeCAD's `SoBrepFaceSet` / `SoBrepEdgeSet` /
 * `SoBrepPointSet` highlight and selection).
 */
import { computeVertexNormals, type Tessellation } from "@fab-cad/protocol";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { DrawStyle } from "../state/view3d";
import type { ViewProps } from "../state/viewprops";

/** FreeCAD's preselection (yellow) and selection (green) colours. */
export const PRESELECT_COLOR = new THREE.Color("#e1e114");
export const SELECT_COLOR = new THREE.Color("#1cad1c");
export const HIDDEN_LINE_FACE = new THREE.Color("#ffffff");

export type Highlight = { kind: "whole" } | { kind: "Face" | "Edge" | "Vertex"; index: number };

function segmentPositions(t: Tessellation, edgeIndex?: number): Float32Array {
  const pts = t.edgePositions;
  const out: number[] = [];
  const range = edgeIndex === undefined ? [...Array(t.edgeCount).keys()] : [edgeIndex];
  for (const e of range) {
    const first = t.edges[2 * e]!;
    const count = t.edges[2 * e + 1]!;
    for (let k = 0; k + 1 < count; k++) {
      const a = (first + k) * 3;
      const b = (first + k + 1) * 3;
      out.push(pts[a]!, pts[a + 1]!, pts[a + 2]!, pts[b]!, pts[b + 1]!, pts[b + 2]!);
    }
  }
  return new Float32Array(out);
}

function lineGeometry(positions: Float32Array): LineSegmentsGeometry {
  const g = new LineSegmentsGeometry();
  if (positions.length) g.setPositions(positions);
  return g;
}

export class ObjectView {
  readonly group = new THREE.Group();
  mesh: THREE.Mesh | null = null;
  edges: LineSegments2 | null = null;
  points: THREE.Points | null = null;
  private faceMaterial: THREE.MeshPhongMaterial | THREE.MeshBasicMaterial | null = null;
  private edgeMaterial: LineMaterial;
  private pointMaterial: THREE.PointsMaterial;
  private overlays = new THREE.Group();
  private overlayKey = "";
  private baseColors = { face: new THREE.Color(0xcccccc), line: new THREE.Color(0x000000), point: new THREE.Color(0x191919) };
  private wholeHighlight: THREE.Color | null = null;
  private hiddenLine = false;
  bounds = new THREE.Box3();
  sphere = new THREE.Sphere();

  constructor(
    readonly name: string,
    public tess: Tessellation,
    public type: string,
    private resolution: THREE.Vector2,
  ) {
    this.edgeMaterial = new LineMaterial({ color: 0x000000, linewidth: 2, worldUnits: false });
    this.edgeMaterial.resolution = resolution;
    this.pointMaterial = new THREE.PointsMaterial({ color: 0x191919, size: 4, sizeAttenuation: false });
    this.group.name = name;
    this.group.userData.object = name;
    this.group.add(this.overlays);
    this.build();
  }

  /** Replace the geometry (a new revision). */
  update(t: Tessellation, type: string): void {
    this.tess = t;
    this.type = type;
    this.disposeGeometry();
    this.build();
    this.overlayKey = "";
  }

  private build(): void {
    const t = this.tess;
    if (t.triangleCount > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(t.normals ?? computeVertexNormals(t.positions, t.indices), 3));
      g.setIndex(new THREE.BufferAttribute(t.indices, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      this.faceMaterial = new THREE.MeshPhongMaterial({
        color: 0xcccccc,
        specular: 0x111111,
        shininess: 16,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      this.mesh = new THREE.Mesh(g, this.faceMaterial);
      this.mesh.userData.object = this.name;
      this.group.add(this.mesh);
    }
    if (t.edgeCount > 0) {
      this.edges = new LineSegments2(lineGeometry(segmentPositions(t)), this.edgeMaterial);
      this.edges.userData.object = this.name;
      this.group.add(this.edges);
    }
    if (t.vertices.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(t.vertices, 3));
      this.points = new THREE.Points(g, this.pointMaterial);
      this.group.add(this.points);
    }
    this.bounds.makeEmpty();
    const pts = [t.positions, t.edgePositions, t.vertices];
    const v = new THREE.Vector3();
    for (const arr of pts) for (let i = 0; i < arr.length; i += 3) this.bounds.expandByPoint(v.set(arr[i]!, arr[i + 1]!, arr[i + 2]!));
    if (!this.bounds.isEmpty()) this.bounds.getBoundingSphere(this.sphere);
  }

  /** Apply view properties and the view's draw style (`View3DInventorViewer::setOverrideMode`). */
  style(vp: ViewProps, drawStyle: DrawStyle, dimmed: boolean): void {
    const mode = drawStyle === "As Is" ? vp.DisplayMode : drawStyle;
    const showFaces = mode === "Flat Lines" || mode === "Shaded" || mode === "Hidden Line" || mode === "No Shading";
    const showEdges = mode === "Flat Lines" || mode === "Wireframe" || mode === "Hidden Line" || mode === "No Shading";
    const showPoints = mode === "Points" || (mode === "Flat Lines" && this.tess.triangleCount === 0 && this.tess.edgeCount === 0);
    const opacity = (1 - vp.Transparency / 100) * (dimmed ? 0.25 : 1);
    this.hiddenLine = mode === "Hidden Line";
    if (this.mesh && this.faceMaterial) {
      const wantBasic = mode === "No Shading" || mode === "Hidden Line";
      if (wantBasic !== this.faceMaterial instanceof THREE.MeshBasicMaterial) {
        this.faceMaterial.dispose();
        this.faceMaterial = wantBasic
          ? new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
          : new THREE.MeshPhongMaterial({
              specular: 0x111111,
              shininess: 16,
              side: THREE.DoubleSide,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            });
        this.mesh.material = this.faceMaterial;
      }
      this.baseColors.face.set(mode === "Hidden Line" ? HIDDEN_LINE_FACE : vp.ShapeColor);
      this.faceMaterial.side = vp.Lighting === "One side" ? THREE.FrontSide : THREE.DoubleSide;
      this.faceMaterial.transparent = opacity < 1;
      this.faceMaterial.opacity = opacity;
      this.faceMaterial.depthWrite = opacity >= 1;
      this.mesh.visible = showFaces;
    }
    if (this.edges) {
      this.baseColors.line.set(vp.LineColor);
      this.edgeMaterial.linewidth = vp.LineWidth;
      this.edgeMaterial.transparent = dimmed;
      this.edgeMaterial.opacity = dimmed ? 0.3 : 1;
      this.edgeMaterial.dashed = false;
      this.edges.visible = showEdges || (this.tess.triangleCount === 0 && mode !== "Points");
    }
    if (this.points) {
      this.baseColors.point.set(vp.PointColor);
      this.pointMaterial.size = Math.max(vp.PointSize, 1) * 2;
      this.pointMaterial.transparent = dimmed;
      this.pointMaterial.opacity = dimmed ? 0.3 : 1;
      this.points.visible = showPoints;
    }
    this.applyColors();
  }

  /** Whole-object (pre)selection recolours the object, as Coin's highlight does; sub-elements get overlays. */
  private applyColors(): void {
    const h = this.wholeHighlight;
    // Hidden Line keeps its faces the background colour; only the lines light up.
    this.faceMaterial?.color.copy(this.hiddenLine ? this.baseColors.face : (h ?? this.baseColors.face));
    this.edgeMaterial.color.copy(h ?? this.baseColors.line);
    this.pointMaterial.color.copy(h ?? this.baseColors.point);
  }

  /** Show preselection and selection overlays; rebuilt only when they change. */
  setHighlights(pre: Highlight | null, selected: Highlight[], lineWidth: number): void {
    const key = JSON.stringify([pre, selected, lineWidth]);
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    for (const c of [...this.overlays.children]) {
      this.overlays.remove(c);
      disposeObject(c);
    }
    const wholeSel = selected.some((h) => h.kind === "whole");
    this.wholeHighlight = wholeSel ? SELECT_COLOR : pre?.kind === "whole" ? PRESELECT_COLOR : null;
    this.applyColors();
    for (const h of selected) if (h.kind !== "whole") this.addOverlay(h, SELECT_COLOR, lineWidth, 2);
    if (pre && pre.kind !== "whole" && !selected.some((s) => JSON.stringify(s) === JSON.stringify(pre)))
      this.addOverlay(pre, PRESELECT_COLOR, lineWidth, 3);
  }

  private addOverlay(h: Highlight, color: THREE.Color, lineWidth: number, order: number): void {
    const t = this.tess;
    if (h.kind === "whole") {
      if (this.mesh) this.addFaceOverlay(0, t.triangleCount, color, order);
      if (t.edgeCount) this.addEdgeOverlay(segmentPositions(t), color, lineWidth + 1, order);
      if (!t.triangleCount && !t.edgeCount && t.vertices.length) this.addPointOverlay(t.vertices, color, order);
      return;
    }
    if (h.kind === "Face") {
      const first = t.faces[2 * h.index];
      const count = t.faces[2 * h.index + 1];
      if (first !== undefined && count !== undefined) this.addFaceOverlay(first, count, color, order);
    } else if (h.kind === "Edge") {
      if (h.index < t.edgeCount) this.addEdgeOverlay(segmentPositions(t, h.index), color, lineWidth + 1, order);
    } else if (h.kind === "Vertex") {
      const v = t.vertices.slice(h.index * 3, h.index * 3 + 3);
      if (v.length === 3) this.addPointOverlay(v, color, order);
    }
  }

  private addFaceOverlay(firstTriangle: number, count: number, color: THREE.Color, order: number): void {
    if (!this.mesh || count <= 0) return;
    const base = this.mesh.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", base.getAttribute("position"));
    g.setAttribute("normal", base.getAttribute("normal"));
    g.setIndex(base.getIndex());
    g.setDrawRange(firstTriangle * 3, count * 3);
    g.userData.shared = true;
    // In front of the object's own faces (offset 1, 1), behind its edges (no offset).
    const m = new THREE.MeshPhongMaterial({
      color,
      specular: 0x111111,
      shininess: 16,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 0,
      depthFunc: THREE.LessEqualDepth,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = order;
    mesh.raycast = () => {};
    this.overlays.add(mesh);
  }

  private addEdgeOverlay(positions: Float32Array, color: THREE.Color, width: number, order: number): void {
    if (!positions.length) return;
    const m = new LineMaterial({ color: color.getHex(), linewidth: width, worldUnits: false, depthTest: true });
    m.resolution = this.resolution;
    const l = new LineSegments2(lineGeometry(positions), m);
    l.renderOrder = order + 2;
    l.raycast = () => {};
    this.overlays.add(l);
  }

  private addPointOverlay(v: Float32Array, color: THREE.Color, order: number): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false, depthTest: false }));
    p.renderOrder = order + 4;
    this.overlays.add(p);
  }

  private disposeGeometry(): void {
    for (const o of [this.mesh, this.edges, this.points]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
    }
    this.faceMaterial?.dispose();
    this.faceMaterial = null;
    this.mesh = null;
    this.edges = null;
    this.points = null;
    for (const c of [...this.overlays.children]) {
      this.overlays.remove(c);
      disposeObject(c);
    }
  }

  dispose(): void {
    this.disposeGeometry();
    this.edgeMaterial.dispose();
    this.pointMaterial.dispose();
  }
}

export function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const any = c as THREE.Mesh;
    // Overlays share their attributes with the object's mesh: disposing them would drop the
    // mesh's GPU buffers too.
    if (any.geometry && !any.geometry.userData?.shared) any.geometry.dispose();
    const m = any.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m?.dispose();
  });
}

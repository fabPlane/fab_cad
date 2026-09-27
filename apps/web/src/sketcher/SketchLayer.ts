/**
 * The sketch in edit mode, drawn into the 3D view (`EditModeCoinManager`): a grid on the sketch
 * plane, the sketch axes, the geometry coloured by state (free white, construction blue, fully
 * constrained green, preselected yellow, selected green), its vertices, constraint badges and the
 * active tool's preview. Tools take clicks in sketch coordinates and snap to existing points
 * (adding coincident constraints) and to horizontal / vertical (adding those constraints).
 */
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { fixed, formatQuantity } from "../lib/format";
import { iconUrl } from "../ui/icons";
import { addKeyHandler } from "../ui/shortcuts";
import type { EditLayer, Viewer } from "../viewer/Viewer";
import { pointSegmentDistance } from "../viewer/picking";
import {
  arcPy,
  autoHorVer,
  circlePy,
  constraintAnchor,
  constraintIcon,
  constraintPy,
  geoPolyline,
  gridStep,
  isDimensional,
  lineSegmentPy,
  pointPy,
  rectanglePy,
  sketchVertices,
  type SketchData,
  type Vec2,
} from "./model";
import { nextGeoIndex, selKey, sketchOp, useSketch, type SketchSel, type SketchTool } from "./session";

const COLORS = {
  free: new THREE.Color("#ffffff"),
  construction: new THREE.Color("#3355ff"),
  fully: new THREE.Color("#00e000"),
  pre: new THREE.Color("#e1e114"),
  sel: new THREE.Color("#1cad1c"),
  vertex: new THREE.Color("#ffffff"),
  preview: new THREE.Color("#ffff66"),
  hAxis: new THREE.Color("#ff3030"),
  vAxis: new THREE.Color("#30c030"),
  grid: new THREE.Color("#c8c8d8"),
  root: new THREE.Color("#ff3030"),
};

const SNAP_PX = 8;
const PICK_PX = 6;

interface Snap {
  geo: number;
  pos: number;
}

export class SketchLayer implements EditLayer {
  readonly group = new THREE.Group();
  private readonly geoGroup = new THREE.Group();
  private readonly gridGroup = new THREE.Group();
  private readonly previewGroup = new THREE.Group();
  private readonly overlay: HTMLElement | null;
  private readonly cursorInfo: HTMLDivElement | null;
  private gridKey = "";
  private points: Vec2[] = [];
  private snaps: (Snap | null)[] = [];
  private cursor: Vec2 | null = null;
  private cursorSnap: Snap | null = null;
  private readonly unsub: () => void;
  private readonly offKey: () => void;
  private badges: HTMLDivElement[] = [];

  constructor(private readonly v: Viewer) {
    this.group.add(this.gridGroup, this.geoGroup, this.previewGroup);
    v.editRoot.add(this.group);
    this.overlay = document.getElementById("sketch-overlay");
    this.cursorInfo = this.overlay ? document.createElement("div") : null;
    if (this.cursorInfo) {
      this.cursorInfo.className = "sketch-cursor-info";
      this.overlay!.appendChild(this.cursorInfo);
    }
    this.unsub = useSketch.subscribe((s, prev) => {
      if (s.data !== prev.data || s.selected !== prev.selected || s.pre !== prev.pre) this.rebuild();
      if (s.tool !== prev.tool) this.resetTool();
    });
    this.offKey = addKeyHandler((e) => handleSketchKey(e, this));
    this.rebuild();
  }

  // ------------------------------------------------------------------------------ frame

  private get data(): SketchData | null {
    return useSketch.getState().data;
  }

  private placement(): THREE.Matrix4 {
    const d = this.data;
    if (!d) return new THREE.Matrix4();
    return new THREE.Matrix4().compose(
      new THREE.Vector3(...d.placement.base),
      new THREE.Quaternion(...d.placement.q),
      new THREE.Vector3(1, 1, 1),
    );
  }

  /** Screen point → sketch coordinates (the ray meets the sketch plane). */
  toSketch(x: number, y: number): Vec2 | null {
    const m = this.placement();
    const inv = m.clone().invert();
    const ray = this.v.rayAt(x, y).applyMatrix4(inv);
    if (Math.abs(ray.direction.z) < 1e-9) return null;
    const t = -ray.origin.z / ray.direction.z;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    return [p.x, p.y];
  }

  toScreen(p: Vec2): [number, number] {
    const w = new THREE.Vector3(p[0], p[1], 0).applyMatrix4(this.placement());
    const s = this.v.project(w.x, w.y, w.z);
    return [s[0], s[1]];
  }

  // ------------------------------------------------------------------------------ drawing

  private rebuild(): void {
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(this.placement());
    this.group.matrixWorldNeedsUpdate = true;
    for (const c of [...this.geoGroup.children]) (this.geoGroup.remove(c), dispose(c));
    const d = this.data;
    if (!d) return;
    const { selected, pre } = useSketch.getState();
    const isSel = (s: SketchSel) => selected.some((x) => selKey(x) === selKey(s));
    const isPre = (s: SketchSel) => !!pre && selKey(pre) === selKey(s);
    const pos: number[] = [];
    const col: number[] = [];
    for (const g of d.geo) {
      const sel: SketchSel = { kind: "edge", geo: g.i };
      const c = isSel(sel)
        ? COLORS.sel
        : isPre(sel)
          ? COLORS.pre
          : g.construction
            ? COLORS.construction
            : d.fully
              ? COLORS.fully
              : COLORS.free;
      const pl = geoPolyline(g);
      for (let k = 0; k + 1 < pl.length; k++) {
        pos.push(pl[k]![0], pl[k]![1], 0.001, pl[k + 1]![0], pl[k + 1]![1], 0.001);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    if (pos.length) {
      const lg = new LineSegmentsGeometry();
      lg.setPositions(pos);
      lg.setColors(col);
      const m = new LineMaterial({ linewidth: 2.5, vertexColors: true, worldUnits: false, depthTest: false });
      m.resolution = this.v.resolution;
      const l = new LineSegments2(lg, m);
      l.renderOrder = 10;
      this.geoGroup.add(l);
    }
    // vertices + root point
    const vp: number[] = [0, 0, 0.002];
    const vc: number[] = [...(isSel({ kind: "root" }) ? COLORS.sel : isPre({ kind: "root" }) ? COLORS.pre : COLORS.root).toArray()];
    for (const vx of sketchVertices(d.geo)) {
      const s: SketchSel = { kind: "vertex", n: vx.n };
      const c = isSel(s) ? COLORS.sel : isPre(s) ? COLORS.pre : d.fully ? COLORS.fully : COLORS.vertex;
      vp.push(vx.p[0], vx.p[1], 0.002);
      vc.push(c.r, c.g, c.b);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.Float32BufferAttribute(vp, 3));
    pg.setAttribute("color", new THREE.Float32BufferAttribute(vc, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false }));
    pts.renderOrder = 11;
    this.geoGroup.add(pts);
    this.buildBadges();
    this.gridKey = "";
    this.v.invalidate();
  }

  private buildGrid(): void {
    const c = this.toSketch(this.v.resolution.x / 2, this.v.resolution.y / 2) ?? [0, 0];
    const span = this.v.cameraState.height * Math.max(1, this.v.resolution.x / Math.max(1, this.v.resolution.y));
    const step = gridStep(span, 24);
    const cx = Math.round(c[0] / step) * step;
    const cy = Math.round(c[1] / step) * step;
    const key = `${step}:${cx}:${cy}`;
    if (key === this.gridKey) return;
    this.gridKey = key;
    for (const ch of [...this.gridGroup.children]) (this.gridGroup.remove(ch), dispose(ch));
    const half = Math.ceil(span / step) * step;
    const lines: number[] = [];
    for (let x = cx - half; x <= cx + half + 1e-9; x += step) lines.push(x, cy - half, 0, x, cy + half, 0);
    for (let y = cy - half; y <= cy + half + 1e-9; y += step) lines.push(cx - half, y, 0, cx + half, y, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    const grid = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: COLORS.grid, transparent: true, opacity: 0.35, depthTest: false }),
    );
    grid.renderOrder = 5;
    this.gridGroup.add(grid);
    const axes = new THREE.BufferGeometry();
    axes.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([cx - half, 0, 0, cx + half, 0, 0, 0, cy - half, 0, 0, cy + half, 0], 3),
    );
    axes.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        [...COLORS.hAxis.toArray(), ...COLORS.hAxis.toArray(), ...COLORS.vAxis.toArray(), ...COLORS.vAxis.toArray()],
        3,
      ),
    );
    const ax = new THREE.LineSegments(axes, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }));
    ax.renderOrder = 6;
    this.gridGroup.add(ax);
  }

  private buildBadges(): void {
    for (const b of this.badges) b.remove();
    this.badges = [];
    const d = this.data;
    if (!d || !this.overlay) return;
    const { selected } = useSketch.getState();
    for (const c of d.cons) {
      if (c.type === "Coincident" || c.type === "PointOnObject" || c.type === "InternalAlignment" || c.type === "None") continue;
      const el = document.createElement("div");
      el.className = "constraint-badge";
      el.dataset.constraint = String(c.i);
      el.style.pointerEvents = "auto";
      el.style.cursor = "pointer";
      if (selected.some((s) => s.kind === "constraint" && s.i === c.i)) el.style.color = "#1cad1c";
      if (isDimensional(c.type)) {
        const unit = c.type === "Angle" ? "deg" : "mm";
        const value = c.type === "Angle" ? (c.value * 180) / Math.PI : c.value;
        el.textContent = `${c.type === "Radius" ? "R" : c.type === "Diameter" ? "⌀" : ""}${formatQuantity(Math.abs(value), unit)}`;
        if (!c.driving) el.style.color = "#6060ff";
      } else {
        const img = document.createElement("img");
        img.src = iconUrl(constraintIcon(c.type));
        el.appendChild(img);
      }
      el.title = `${c.name || `Constraint${c.i + 1}`}: ${c.type}`;
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const s = useSketch.getState();
        const item: SketchSel = { kind: "constraint", i: c.i };
        s.setSelected(e.ctrlKey ? [...s.selected, item] : [item]);
      });
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (isDimensional(c.type)) void import("./tools").then((m) => m.editDatum(c.i));
      });
      this.overlay.appendChild(el);
      this.badges.push(el);
    }
  }

  beforeRender(): void {
    this.buildGrid();
    const d = this.data;
    if (!d) return;
    let k = 0;
    const offsets = new Map<string, number>();
    for (const c of d.cons) {
      if (c.type === "Coincident" || c.type === "PointOnObject" || c.type === "InternalAlignment" || c.type === "None") continue;
      const el = this.badges[k++];
      const a = constraintAnchor(d.geo, c);
      if (!el || !a) continue;
      const [x, y] = this.toScreen(a);
      const key = `${Math.round(x / 10)}:${Math.round(y / 10)}`;
      const n = offsets.get(key) ?? 0;
      offsets.set(key, n + 1);
      el.style.left = `${x + n * 18}px`;
      el.style.top = `${y - (isDimensional(c.type) ? 12 : 14)}px`;
    }
  }

  // ------------------------------------------------------------------------------ picking

  /** The sketch element under a screen point: vertices first, then edges, the root point, the axes. */
  pickElement(x: number, y: number): SketchSel | null {
    const d = this.data;
    if (!d) return null;
    let best: { s: SketchSel; d: number } | null = null;
    const root = this.toScreen([0, 0]);
    if (Math.hypot(root[0] - x, root[1] - y) <= SNAP_PX) best = { s: { kind: "root" }, d: Math.hypot(root[0] - x, root[1] - y) };
    for (const vx of sketchVertices(d.geo)) {
      const s = this.toScreen(vx.p);
      const dist = Math.hypot(s[0] - x, s[1] - y);
      if (dist <= SNAP_PX && (!best || dist < best.d)) best = { s: { kind: "vertex", n: vx.n }, d: dist };
    }
    if (best) return best.s;
    for (const g of d.geo) {
      const pl = geoPolyline(g).map((p) => this.toScreen(p));
      for (let k = 0; k + 1 < pl.length; k++) {
        const { d: dist } = pointSegmentDistance(x, y, pl[k]![0], pl[k]![1], pl[k + 1]![0], pl[k + 1]![1]);
        if (dist <= PICK_PX && (!best || dist < best.d)) best = { s: { kind: "edge", geo: g.i }, d: dist };
      }
      if (g.type === "Point") {
        const s = pl[0]!;
        const dist = Math.hypot(s[0] - x, s[1] - y);
        if (dist <= SNAP_PX && (!best || dist < best.d)) best = { s: { kind: "edge", geo: g.i }, d: dist };
      }
    }
    if (best) return best.s;
    const p = this.toSketch(x, y);
    if (p) {
      const px = this.v.cameraState.height / Math.max(1, this.v.resolution.y);
      if (Math.abs(p[1]) < PICK_PX * px) return { kind: "hAxis" };
      if (Math.abs(p[0]) < PICK_PX * px) return { kind: "vAxis" };
    }
    return null;
  }

  /** Snap to an existing point (or the origin) near a screen position. */
  private snapAt(x: number, y: number): { p: Vec2; snap: Snap | null } | null {
    const p = this.toSketch(x, y);
    if (!p) return null;
    const d = this.data;
    const root = this.toScreen([0, 0]);
    let best: { p: Vec2; snap: Snap; d: number } | null = null;
    if (Math.hypot(root[0] - x, root[1] - y) <= SNAP_PX)
      best = { p: [0, 0], snap: { geo: -1, pos: 1 }, d: Math.hypot(root[0] - x, root[1] - y) };
    for (const vx of d ? sketchVertices(d.geo) : []) {
      const s = this.toScreen(vx.p);
      const dist = Math.hypot(s[0] - x, s[1] - y);
      if (dist <= SNAP_PX && (!best || dist < best.d)) best = { p: vx.p, snap: { geo: vx.geo, pos: vx.pos }, d: dist };
    }
    // the polyline's own start closes it
    if (this.points.length > 1 && useSketch.getState().tool === "polyline") {
      const s = this.toScreen(this.points[0]!);
      const dist = Math.hypot(s[0] - x, s[1] - y);
      if (dist <= SNAP_PX && (!best || dist < best.d)) best = { p: this.points[0]!, snap: { geo: -100, pos: 0 }, d: dist };
    }
    return best ? { p: best.p, snap: best.snap } : { p, snap: null };
  }

  // ------------------------------------------------------------------------------ tools

  private resetTool(): void {
    this.points = [];
    this.snaps = [];
    this.cursorSnap = null;
    this.drawPreview();
  }

  private drawPreview(): void {
    for (const c of [...this.previewGroup.children]) (this.previewGroup.remove(c), dispose(c));
    const tool = useSketch.getState().tool;
    const cur = this.cursor;
    if (this.cursorInfo) {
      if (tool && cur) {
        const [sx, sy] = this.toScreen(cur);
        this.cursorInfo.style.left = `${sx}px`;
        this.cursorInfo.style.top = `${sy}px`;
        let extra = "";
        const last = this.points[this.points.length - 1];
        if (last && (tool === "line" || tool === "polyline")) extra = `  length ${fixed(Math.hypot(cur[0] - last[0], cur[1] - last[1]))}`;
        if (last && (tool === "circle" || tool === "arc"))
          extra = `  R ${fixed(Math.hypot(cur[0] - this.points[0]![0], cur[1] - this.points[0]![1]))}`;
        this.cursorInfo.textContent = `(${fixed(cur[0])}, ${fixed(cur[1])})${extra}${this.cursorSnap ? "  ●" : ""}`;
        this.cursorInfo.style.display = "";
      } else this.cursorInfo.style.display = "none";
    }
    if (!tool || !cur) return this.v.invalidate();
    const pts = this.points;
    const segs: [Vec2, Vec2][] = [];
    if ((tool === "line" || tool === "polyline") && pts.length) {
      for (let k = 0; k + 1 < pts.length; k++) segs.push([pts[k]!, pts[k + 1]!]);
      segs.push([pts[pts.length - 1]!, cur]);
    } else if (tool === "rectangle" && pts.length === 1) {
      const [a, b] = [pts[0]!, cur];
      segs.push([a, [b[0], a[1]]], [[b[0], a[1]], b], [b, [a[0], b[1]]], [[a[0], b[1]], a]);
    } else if ((tool === "circle" || tool === "arc") && pts.length >= 1) {
      const c = pts[0]!;
      const r = Math.hypot((pts[1] ?? cur)[0] - c[0], (pts[1] ?? cur)[1] - c[1]);
      let a1 = 0;
      let a2 = 2 * Math.PI;
      if (tool === "arc" && pts.length === 2) {
        a1 = Math.atan2(pts[1]![1] - c[1], pts[1]![0] - c[0]);
        a2 = Math.atan2(cur[1] - c[1], cur[0] - c[0]);
        while (a2 <= a1) a2 += 2 * Math.PI;
      }
      const n = 64;
      let prev: Vec2 | null = null;
      for (let k = 0; k <= n; k++) {
        const a = a1 + ((a2 - a1) * k) / n;
        const p: Vec2 = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
        if (prev) segs.push([prev, p]);
        prev = p;
      }
      if (tool === "arc" && pts.length < 2) segs.push([c, cur]);
    }
    if (segs.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(segs.flatMap(([a, b]) => [a[0], a[1], 0.003, b[0], b[1], 0.003]));
      const m = new LineMaterial({ color: COLORS.preview.getHex(), linewidth: 1.5, worldUnits: false, depthTest: false, dashed: false });
      m.resolution = this.v.resolution;
      const l = new LineSegments2(g, m);
      l.renderOrder = 12;
      this.previewGroup.add(l);
    }
    this.v.invalidate();
  }

  private async click(p: Vec2, snap: Snap | null): Promise<void> {
    const tool = useSketch.getState().tool;
    if (!tool) return;
    this.points.push(p);
    this.snaps.push(snap);
    const n = this.points.length;
    const g = nextGeoIndex();
    const coin = (geo: number, pos: number, s: Snap | null): string[] =>
      s && s.geo !== -100 ? [`ActiveSketch.addConstraint(${constraintPy("Coincident", geo, pos, s.geo, s.pos)})`] : [];
    if (tool === "point") {
      const ok = await sketchOp("Add sketch point", [`ActiveSketch.addGeometry(${pointPy(p)},False)`, ...coin(g, 1, snap)]);
      if (ok) this.resetTool();
    } else if (tool === "line" && n === 2) {
      const [a, b] = this.points as [Vec2, Vec2];
      const hv = autoHorVer(a, b);
      const bb: Vec2 = hv === "Horizontal" && !this.snaps[1] ? [b[0], a[1]] : hv === "Vertical" && !this.snaps[1] ? [a[0], b[1]] : b;
      await sketchOp("Add sketch line", [
        `ActiveSketch.addGeometry(${lineSegmentPy(a, bb)},False)`,
        ...coin(g, 1, this.snaps[0]!),
        ...coin(g, 2, this.snaps[1]!),
        ...(hv && !(this.snaps[0] && this.snaps[1]) ? [`ActiveSketch.addConstraint(${constraintPy(hv, g)})`] : []),
      ]);
      this.resetTool();
    } else if (tool === "polyline") {
      if (snap?.geo === -100) await this.finishPolyline(true);
      else this.drawPreview();
    } else if (tool === "rectangle" && n === 2) {
      const [a, b] = this.points as [Vec2, Vec2];
      if (Math.abs(a[0] - b[0]) > 1e-9 && Math.abs(a[1] - b[1]) > 1e-9) {
        await sketchOp("Add sketch box", [...rectanglePy(a, b, g), ...coin(g, 1, this.snaps[0]!), ...coin(g + 2, 1, this.snaps[1]!)]);
      }
      this.resetTool();
    } else if (tool === "circle" && n === 2) {
      const [c, e] = this.points as [Vec2, Vec2];
      const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      if (r > 1e-9)
        await sketchOp("Add sketch circle", [`ActiveSketch.addGeometry(${circlePy(c, r)},False)`, ...coin(g, 3, this.snaps[0]!)]);
      this.resetTool();
    } else if (tool === "arc" && n === 3) {
      const [c, s, e] = this.points as [Vec2, Vec2, Vec2];
      const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      const a1 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      let a2 = Math.atan2(e[1] - c[1], e[0] - c[0]);
      while (a2 <= a1) a2 += 2 * Math.PI;
      if (r > 1e-9)
        await sketchOp("Add sketch arc", [
          `ActiveSketch.addGeometry(${arcPy(c, r, a1, a2)},False)`,
          ...coin(g, 3, this.snaps[0]!),
          ...coin(g, 1, this.snaps[1]!),
        ]);
      this.resetTool();
    } else this.drawPreview();
  }

  /** End the polyline: one transaction with the segments, their coincidences and H/V constraints. */
  async finishPolyline(close = false): Promise<void> {
    const pts = this.points.slice();
    const snaps = this.snaps.slice();
    if (close) {
      pts.pop();
      snaps.pop();
    }
    this.resetTool();
    if (pts.length < 2) return;
    const g0 = nextGeoIndex();
    const lines: string[] = [];
    const segs = pts.length - 1 + (close ? 1 : 0);
    for (let k = 0; k < segs; k++) {
      const a = pts[k]!;
      const b = pts[(k + 1) % pts.length]!;
      lines.push(`ActiveSketch.addGeometry(${lineSegmentPy(a, b)},False)`);
    }
    for (let k = 0; k + 1 < segs; k++) lines.push(`ActiveSketch.addConstraint(${constraintPy("Coincident", g0 + k, 2, g0 + k + 1, 1)})`);
    if (close) lines.push(`ActiveSketch.addConstraint(${constraintPy("Coincident", g0 + segs - 1, 2, g0, 1)})`);
    for (let k = 0; k < pts.length; k++) {
      const s = snaps[k];
      if (!s || s.geo === -100) continue;
      const [geo, pos] = k === 0 ? [g0, 1] : k === pts.length - 1 && !close ? [g0 + k - 1, 2] : [g0 + k, 1];
      lines.push(`ActiveSketch.addConstraint(${constraintPy("Coincident", geo, pos, s.geo, s.pos)})`);
    }
    for (let k = 0; k < segs; k++) {
      const hv = autoHorVer(pts[k]!, pts[(k + 1) % pts.length]!, 1);
      if (hv) lines.push(`ActiveSketch.addConstraint(${constraintPy(hv, g0 + k)})`);
    }
    await sketchOp("Add sketch polyline", lines);
  }

  // ------------------------------------------------------------------------------ events

  private downAt: { x: number; y: number; button: number } | null = null;

  pointerDown(e: PointerEvent): boolean {
    const r = this.v.renderer.domElement.getBoundingClientRect();
    this.downAt = { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button };
    // left button is ours (tools, selection); middle/right navigate
    return e.button === 0 && !!useSketch.getState().tool;
  }

  pointerMove(e: PointerEvent): boolean {
    const r = this.v.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const tool = useSketch.getState().tool;
    if (tool) {
      const s = this.snapAt(x, y);
      this.cursor = s?.p ?? null;
      this.cursorSnap = s?.snap ?? null;
      if (s && this.points.length && (tool === "line" || tool === "polyline") && !s.snap) {
        const last = this.points[this.points.length - 1]!;
        const hv = autoHorVer(last, s.p);
        if (hv === "Horizontal") this.cursor = [s.p[0], last[1]];
        if (hv === "Vertical") this.cursor = [last[0], s.p[1]];
      }
      this.drawPreview();
      return true;
    }
    if (e.buttons === 0) useSketch.getState().setPre(this.pickElement(x, y));
    return false;
  }

  pointerUp(e: PointerEvent): boolean {
    const r = this.v.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const d = this.downAt;
    this.downAt = null;
    if (!d || Math.hypot(d.x - x, d.y - y) > 3) return false;
    const tool = useSketch.getState().tool;
    if (e.button === 2) {
      // right click ends the tool (and finishes a polyline)
      if (tool === "polyline" && this.points.length > 1) void this.finishPolyline();
      else if (tool) useSketch.getState().setTool(null);
      else return false;
      return true;
    }
    if (e.button !== 0) return false;
    if (tool) {
      if (useSketch.getState().busy) return true;
      const s = this.snapAt(x, y);
      if (!s) return true;
      let p = s.p;
      if (!s.snap && this.points.length && (tool === "line" || tool === "polyline")) {
        const last = this.points[this.points.length - 1]!;
        const hv = autoHorVer(last, p);
        if (hv === "Horizontal") p = [p[0], last[1]];
        if (hv === "Vertical") p = [last[0], p[1]];
      }
      void this.click(p, s.snap);
      return true;
    }
    const hit = this.pickElement(x, y);
    const st = useSketch.getState();
    if (!hit) {
      if (!e.ctrlKey) st.setSelected([]);
      return true;
    }
    const exists = st.selected.some((s) => selKey(s) === selKey(hit));
    if (e.ctrlKey || e.metaKey) st.setSelected(exists ? st.selected.filter((s) => selKey(s) !== selKey(hit)) : [...st.selected, hit]);
    else st.setSelected([hit]);
    return true;
  }

  cancelTool(): void {
    useSketch.getState().setTool(null);
    this.resetTool();
  }

  get pointsCount(): number {
    return this.points.length;
  }

  dispose(): void {
    this.unsub();
    this.offKey();
    for (const b of this.badges) b.remove();
    this.cursorInfo?.remove();
    this.v.editRoot.remove(this.group);
    this.group.traverse((c) => dispose(c));
    this.v.invalidate();
  }
}

/** Esc: finish/cancel the tool, then leave the sketch; Delete removes the selection. */
export function handleSketchKey(e: KeyboardEvent, layer: SketchLayer | null): boolean {
  const st = useSketch.getState();
  if (e.key === "Escape") {
    if (st.tool === "polyline" && layer && layer.pointsCount > 1) void layer.finishPolyline();
    else if (st.tool) st.setTool(null);
    else if (st.selected.length) st.setSelected([]);
    else void import("./session").then((m) => m.leaveSketchEdit(true));
    return true;
  }
  if (e.key === "Delete" && st.selected.length && !st.tool) {
    void import("./tools").then((m) => m.deleteSketchSelection());
    return true;
  }
  return false;
}

function dispose(o: THREE.Object3D): void {
  const m = o as THREE.Mesh;
  m.geometry?.dispose();
  const mat = m.material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
  else mat?.dispose();
}

export type { SketchTool };

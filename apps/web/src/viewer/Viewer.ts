/**
 * The 3D view (`View3DInventorViewer`) in three.js: FreeCAD's background gradient, the document's
 * shapes from `Tessellate` (cached by revision in the DocumentStore), sub-element preselection and
 * selection, navigation styles, standard views, the navigation cube, the corner axis cross and the
 * origin axis cross, draw styles, fit all / fit selection. A sketch in edit mode draws itself
 * through an `EditLayer` that gets the pointer first.
 */
import type { Tessellation } from "@fab-cad/protocol";
import * as THREE from "three";
import { formatPoint, fixed } from "../lib/format";
import { useApp } from "../state/app";
import { sameItem, useSelection, type SelItem } from "../state/selection";
import { object as objectInfo, objects, onModelChange, property, store, useSession } from "../state/session";
import { useView3D, type StandardView, type ViewerHandle } from "../state/view3d";
import { useViewProps, viewPropsOf } from "../state/viewprops";
import { DRAG_THRESHOLD, dragAction, type DragAction } from "./navigation";
import { NaviCube, NAVICUBE_SIZE } from "./naviCube";
import { ObjectView, type Highlight } from "./objectView";
import { chooseCandidate, parseSubName, pickEdge, pickVertex, subName } from "./picking";

/** FreeCAD's default background gradient: #333365 at the top to #ababc1 at the bottom. */
export const BACKGROUND_TOP = "#333365";
export const BACKGROUND_BOTTOM = "#ababc1";

/** Camera orientations of FreeCAD's standard views (`Camera.cpp`, quaternions x, y, z, w). */
export const VIEW_QUATERNIONS: Record<Exclude<StandardView, "Home">, [number, number, number, number]> = {
  Top: [0, 0, 0, 1],
  Bottom: [1, 0, 0, 0],
  Front: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  Rear: [0, Math.SQRT1_2, Math.SQRT1_2, 0],
  Right: [0.5, 0.5, 0.5, 0.5],
  Left: [-0.5, 0.5, 0.5, -0.5],
  Isometric: [0.424708, 0.17592, 0.339851, 0.820473],
  Dimetric: [0.567952, 0.103751, 0.146726, 0.803205],
  Trimetric: [0.446015, 0.119509, 0.229575, 0.856787],
};

export interface PickResult {
  object: string;
  sub: string;
  point: [number, number, number];
}

/** A sketch (or any edit mode) drawing into the view and taking the pointer first. */
export interface EditLayer {
  group: THREE.Object3D;
  /** Return true when the event was consumed. */
  pointerDown?(e: PointerEvent, v: Viewer): boolean;
  pointerMove?(e: PointerEvent, v: Viewer): boolean;
  pointerUp?(e: PointerEvent, v: Viewer): boolean;
  keyDown?(e: KeyboardEvent, v: Viewer): boolean;
  /** Called each frame before rendering (overlays follow the camera). */
  beforeRender?(v: Viewer): void;
  dispose(): void;
}

interface CameraState {
  target: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Visible world height at the target. */
  height: number;
}

const tmpV = new THREE.Vector3();

export class Viewer implements ViewerHandle {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly editRoot = new THREE.Group();
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
  readonly persp = new THREE.PerspectiveCamera(45, 1, 0.1, 1e6);
  readonly resolution = new THREE.Vector2(1, 1);
  private readonly bgScene = new THREE.Scene();
  private readonly bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bgMaterial: THREE.ShaderMaterial;
  /**
   * FreeCAD 1.x's light sources (`View3DSettings.h`): directions in camera space, intensities
   * 90 / 60 / 40 % (Coin's lighting has no 1/π, three.js's Lambert term does).
   */
  private readonly lights = [
    { light: new THREE.DirectionalLight(0xffffff, 0.9 * Math.PI), dir: new THREE.Vector3(0.6841049, -0.12062616, -0.7193398) },
    { light: new THREE.DirectionalLight(0xffffff, 0.6 * Math.PI), dir: new THREE.Vector3(-0.7544065, -0.63302225, -0.17364818) },
    { light: new THREE.DirectionalLight(0xe6faff, 0.4 * Math.PI), dir: new THREE.Vector3(-0.6403416, 0.7631294, 0.087155744) },
  ];
  private readonly navi = new NaviCube();
  private readonly cornerScene = new THREE.Scene();
  private readonly cornerCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
  private readonly axisCross = new THREE.Group();
  /** The origin's datum planes and axes (visible App::Plane / App::Line, or the plane picker). */
  private readonly originGroup = new THREE.Group();
  private originKey = "";
  private readonly views = new Map<string, ObjectView>();
  private readonly cameras = new Map<string, CameraState>();
  private readonly raycaster = new THREE.Raycaster();
  private doc: string | null = null;
  private cam: CameraState = { target: new THREE.Vector3(), quat: new THREE.Quaternion(...VIEW_QUATERNIONS.Isometric), height: 100 };
  private width = 1;
  private height = 1;
  private dirty = true;
  private frame = 0;
  private disposed = false;
  private syncing = false;
  private syncAgain = false;
  private anim: {
    from: THREE.Quaternion;
    to: THREE.Quaternion;
    t0: number;
    ms: number;
    fromTarget?: THREE.Vector3;
    toTarget?: THREE.Vector3;
    fromH?: number;
    toH?: number;
  } | null = null;
  private drag: {
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    buttons: number;
    moved: boolean;
    action: DragAction;
    onCube: boolean;
  } | null = null;
  private hoverPending: { x: number; y: number } | null = null;
  /** Where the pointer rests, so preselection follows camera moves (`null` once it left). */
  private lastHover: { x: number; y: number } | null = null;
  private hoverCamKey = "";
  private readonly offs: (() => void)[] = [];
  edit: EditLayer | null = null;
  onContextMenu: (x: number, y: number) => void = () => {};
  onDoubleClick: (hit: PickResult | null) => void = () => {};

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.autoClear = false;
    this.renderer.domElement.className = "view3d-canvas";
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.bgMaterial = new THREE.ShaderMaterial({
      // sRGB values mixed in sRGB and written as is, like Coin's gradient background.
      uniforms: { top: { value: srgb(BACKGROUND_TOP) }, bottom: { value: srgb(BACKGROUND_BOTTOM) } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader:
        "uniform vec3 top; uniform vec3 bottom; varying vec2 vUv; void main(){ gl_FragColor = vec4(mix(bottom, top, vUv.y), 1.0); }",
      depthWrite: false,
      depthTest: false,
    });
    this.bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMaterial));

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));
    for (const l of this.lights) {
      this.scene.add(l.light);
      this.scene.add(l.light.target);
    }
    this.scene.add(this.root);
    this.scene.add(this.editRoot);
    this.scene.add(this.axisCross);
    this.scene.add(this.originGroup);
    this.buildAxisCross();
    this.buildCornerAxes();

    const el = this.renderer.domElement;
    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(t, f as EventListener, opts);
      this.offs.push(() => el.removeEventListener(t, f as EventListener));
    };
    on("pointerdown", (e) => this.onPointerDown(e));
    on("pointermove", (e) => this.onPointerMove(e));
    on("pointerup", (e) => this.onPointerUp(e));
    on("pointerleave", () => this.onPointerLeave());
    on("wheel", (e) => this.onWheel(e), { passive: false });
    on("contextmenu", (e) => e.preventDefault());
    on("dblclick", (e) => this.onDblClick(e));
    on("keydown", (e) => {
      if (this.edit?.keyDown?.(e, this)) e.stopPropagation();
    });

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.offs.push(() => ro.disconnect());
    this.resize();

    this.offs.push(onModelChange(() => this.scheduleSync()));
    this.offs.push(useSelection.subscribe(() => this.updateHighlights()));
    this.offs.push(useViewProps.subscribe(() => this.restyle()));
    this.offs.push(
      useView3D.subscribe((s, prev) => {
        if (s.drawStyle !== prev.drawStyle) this.restyle();
        if (s.orthographic !== prev.orthographic) this.invalidate();
        if (s.axisCross !== prev.axisCross) ((this.axisCross.visible = s.axisCross), this.invalidate());
        if (s.originPicker !== prev.originPicker) this.updateOrigin();
      }),
    );
    this.offs.push(useApp.subscribe((s, prev) => s.editing !== prev.editing && this.restyle()));
    this.axisCross.visible = useView3D.getState().axisCross;
    this.loop();
  }

  // ------------------------------------------------------------------------------ camera

  get camera(): THREE.OrthographicCamera | THREE.PerspectiveCamera {
    return useView3D.getState().orthographic ? this.ortho : this.persp;
  }

  get cameraState(): CameraState {
    return this.cam;
  }

  private updateCamera(): void {
    const { target, quat, height } = this.cam;
    const aspect = this.width / Math.max(1, this.height);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    const radius = Math.max(this.sceneRadius(), height);
    if (useView3D.getState().orthographic) {
      const c = this.ortho;
      c.left = (-height * aspect) / 2;
      c.right = (height * aspect) / 2;
      c.top = height / 2;
      c.bottom = -height / 2;
      c.near = -radius * 20;
      c.far = radius * 20;
      c.position.copy(target).addScaledVector(back, radius * 4);
      c.quaternion.copy(quat);
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
    } else {
      const c = this.persp;
      c.aspect = aspect;
      const dist = height / 2 / Math.tan((c.fov * Math.PI) / 360);
      c.position.copy(target).addScaledVector(back, dist);
      c.quaternion.copy(quat);
      c.near = Math.max(dist / 1000, 0.01);
      c.far = dist + radius * 20;
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
    }
    for (const { light, dir } of this.lights) {
      // a light shining along `dir` (camera space) comes from -dir
      light.position.copy(target).addScaledVector(dir.clone().applyQuaternion(quat), -radius);
      light.target.position.copy(target);
      light.target.updateMatrixWorld();
    }
    this.navi.sync(quat);
    this.cornerCamera.quaternion.copy(quat);
    this.cornerCamera.position.set(0, 0, 6).applyQuaternion(quat);
    this.cornerCamera.updateMatrixWorld();
    const w = height * aspect;
    useView3D.getState().setDimensions(`${fixed(w)} mm x ${fixed(height)} mm`);
  }

  private sceneRadius(): number {
    const b = this.visibleBounds();
    if (b.isEmpty()) return 100;
    return Math.max(b.getSize(new THREE.Vector3()).length() / 2, 1);
  }

  private visibleBounds(only?: Set<string>): THREE.Box3 {
    const b = new THREE.Box3();
    for (const [name, v] of this.views) {
      if (!v.group.visible || v.bounds.isEmpty()) continue;
      if (only && !only.has(name)) continue;
      b.union(v.bounds);
    }
    return b;
  }

  invalidate(): void {
    this.dirty = true;
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(r.width));
    this.height = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = `${this.width}px`;
    this.renderer.domElement.style.height = `${this.height}px`;
    this.resolution.set(this.width, this.height);
    this.invalidate();
  }

  /** Fit a box into the view (Coin's `viewAll`: the bounding sphere fills the view). */
  private fitBox(b: THREE.Box3, animate = false): void {
    if (b.isEmpty()) return;
    const sphere = b.getBoundingSphere(new THREE.Sphere());
    const aspect = this.width / Math.max(1, this.height);
    let h = Math.max(sphere.radius * 2, 1e-3);
    if (aspect < 1) h /= aspect;
    h *= 1.05;
    if (animate) {
      this.anim = {
        from: this.cam.quat.clone(),
        to: this.cam.quat.clone(),
        t0: performance.now(),
        ms: 200,
        fromTarget: this.cam.target.clone(),
        toTarget: sphere.center.clone(),
        fromH: this.cam.height,
        toH: h,
      };
    } else {
      this.cam.target.copy(sphere.center);
      this.cam.height = h;
    }
    this.invalidate();
  }

  fitAll(): void {
    this.fitBox(this.visibleBounds());
  }

  fitSelection(): void {
    const names = new Set(
      useSelection
        .getState()
        .selection.filter((s) => s.doc === this.doc)
        .map((s) => s.object),
    );
    const b = this.visibleBounds(names);
    this.fitBox(b.isEmpty() ? this.visibleBounds() : b);
  }

  setOrientation(q: THREE.Quaternion, animate = true): void {
    if (!animate) {
      this.cam.quat.copy(q);
      this.invalidate();
      return;
    }
    const to = q.clone();
    if (this.cam.quat.dot(to) < 0) to.set(-to.x, -to.y, -to.z, -to.w);
    this.anim = { from: this.cam.quat.clone(), to, t0: performance.now(), ms: 250 };
    this.invalidate();
  }

  setStandardView(v: StandardView): void {
    if (v === "Home") {
      this.setOrientation(new THREE.Quaternion(...VIEW_QUATERNIONS.Isometric));
      this.fitAll();
      return;
    }
    this.setOrientation(new THREE.Quaternion(...VIEW_QUATERNIONS[v]));
    setTimeout(() => this.fitAll(), 260);
  }

  rotateAroundView(deg: number): void {
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(this.cam.quat);
    const r = new THREE.Quaternion().setFromAxisAngle(axis, (deg * Math.PI) / 180);
    this.setOrientation(r.multiply(this.cam.quat.clone()));
  }

  /** Orbit by an angle about the view's up (`dx`) or right (`dy`) axis, degrees. */
  orbit(dxDeg: number, dyDeg: number, animate = false): void {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.cam.quat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.cam.quat);
    const r = new THREE.Quaternion()
      .setFromAxisAngle(up, (-dxDeg * Math.PI) / 180)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, (-dyDeg * Math.PI) / 180));
    const q = r.multiply(this.cam.quat.clone()).normalize();
    this.setOrientation(q, animate);
  }

  zoom(factor: number): void {
    this.cam.height *= factor;
    this.invalidate();
  }

  alignToSelection(): void {
    const s = useSelection.getState().selection.find((x) => x.doc === this.doc && x.sub.startsWith("Face"));
    if (!s) return;
    const v = this.views.get(s.object);
    const p = parseSubName(s.sub);
    if (!v?.mesh || !p) return;
    const t = v.tess;
    const first = t.faces[2 * p.index]!;
    const i0 = t.indices[first * 3]! * 3;
    const i1 = t.indices[first * 3 + 1]! * 3;
    const i2 = t.indices[first * 3 + 2]! * 3;
    const a = new THREE.Vector3(t.positions[i0], t.positions[i0 + 1], t.positions[i0 + 2]);
    const b = new THREE.Vector3(t.positions[i1], t.positions[i1 + 1], t.positions[i1 + 2]);
    const c = new THREE.Vector3(t.positions[i2], t.positions[i2 + 1], t.positions[i2 + 2]);
    const n = b.sub(a).cross(c.sub(a)).normalize();
    this.setOrientation(NaviCube.orientationFor({ normal: n }, new THREE.Vector3(0, 1, 0).applyQuaternion(this.cam.quat)));
  }

  /** Look straight at a plane given by its placement rotation (sketch edit mode). */
  lookAlong(q: THREE.Quaternion, center?: THREE.Vector3): void {
    this.setOrientation(q.clone());
    if (center) this.cam.target.copy(center);
  }

  screenshot(): string | null {
    this.render();
    return this.renderer.domElement.toDataURL("image/png");
  }

  // ------------------------------------------------------------------------------ document

  setDocument(doc: string | null): void {
    if (doc === this.doc) return;
    if (this.doc) this.cameras.set(this.doc, { target: this.cam.target.clone(), quat: this.cam.quat.clone(), height: this.cam.height });
    for (const v of this.views.values()) {
      this.root.remove(v.group);
      v.dispose();
    }
    this.views.clear();
    this.doc = doc;
    useSelection.getState().setPreselection(null);
    const saved = doc ? this.cameras.get(doc) : undefined;
    this.cam = saved
      ? { target: saved.target.clone(), quat: saved.quat.clone(), height: saved.height }
      : { target: new THREE.Vector3(), quat: new THREE.Quaternion(...VIEW_QUATERNIONS.Isometric), height: 100 };
    const fresh = !saved;
    void this.sync().then(() => {
      if (fresh && this.views.size) this.fitAll();
    });
  }

  get document(): string | null {
    return this.doc;
  }

  objectView(name: string): ObjectView | undefined {
    return this.views.get(name);
  }

  private scheduleSync(): void {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    void this.sync();
  }

  /** Objects the 3D view draws: geometry, visible, not a PartDesign Body (its features draw). */
  private drawable(doc: string): string[] {
    return objects(doc)
      .filter((o) => o.isGeo && o.visibility && o.type !== "PartDesign::Body" && !o.type.startsWith("App::"))
      .map((o) => o.name);
  }

  async sync(): Promise<void> {
    const doc = this.doc;
    const s = store();
    if (!doc || !s || !s.document(doc)) {
      for (const v of this.views.values()) (this.root.remove(v.group), v.dispose());
      this.views.clear();
      this.invalidate();
      return;
    }
    this.syncing = true;
    const hadAny = this.views.size > 0;
    try {
      const wanted = this.drawable(doc);
      let meshes: Tessellation[] = [];
      try {
        meshes = wanted.length ? await s.tessellate(doc, wanted) : [];
      } catch {
        meshes = wanted.map((n) => s.cache.latest(doc, n)).filter((t): t is Tessellation => !!t);
      }
      if (doc !== this.doc) return;
      const byName = new Map(meshes.map((m) => [m.object, m]));
      for (const [name, v] of [...this.views]) {
        if (!byName.has(name)) {
          this.root.remove(v.group);
          v.dispose();
          this.views.delete(name);
        }
      }
      for (const [name, t] of byName) {
        const info = objectInfo(doc, name);
        const existing = this.views.get(name);
        if (!existing) {
          const v = new ObjectView(name, t, info?.type ?? "", this.resolution);
          this.views.set(name, v);
          this.root.add(v.group);
        } else if (existing.tess !== t) existing.update(t, info?.type ?? existing.type);
      }
      this.restyle();
      this.updateHighlights();
      this.updateOrigin();
      if (!hadAny && this.views.size) this.fitAll();
    } finally {
      this.syncing = false;
      this.invalidate();
      if (this.syncAgain) {
        this.syncAgain = false;
        void this.sync();
      }
    }
  }

  private restyle(): void {
    if (!this.doc) return;
    const ds = useView3D.getState().drawStyle;
    const editing = useApp.getState().editing;
    const overrides = useViewProps.getState().overrides;
    for (const [name, v] of this.views) {
      const info = objectInfo(this.doc, name);
      const vp = viewPropsOf(this.doc, name, info?.type ?? v.type, overrides);
      const dimmed = !!editing && editing.doc === this.doc && editing.object !== name;
      const hiddenByEdit = !!editing && editing.doc === this.doc && editing.object === name;
      v.group.visible = !hiddenByEdit;
      v.style(vp, ds, dimmed);
    }
    this.updateHighlights();
    this.invalidate();
  }

  private updateHighlights(): void {
    if (!this.doc) return;
    const { selection, preselection } = useSelection.getState();
    const toHighlight = (s: SelItem): Highlight => {
      const p = parseSubName(s.sub);
      return p ? { kind: p.kind, index: p.index } : { kind: "whole" };
    };
    const overrides = useViewProps.getState().overrides;
    for (const [name, v] of this.views) {
      const sel = selection.filter((s) => s.doc === this.doc && s.object === name).map(toHighlight);
      const pre = preselection && preselection.doc === this.doc && preselection.object === name ? toHighlight(preselection) : null;
      const vp = viewPropsOf(this.doc, name, v.type, overrides);
      v.setHighlights(pre, sel, vp.LineWidth);
    }
    this.invalidate();
  }

  // ------------------------------------------------------------------------------ origin

  /**
   * FreeCAD draws an origin's planes and axes when they are visible (ViewProviderPlane /
   * ViewProviderLine); the server gives them no shape, so they are drawn here, sized from the scene.
   */
  private updateOrigin(): void {
    const doc = this.doc;
    const picker = useView3D.getState().originPicker;
    const roles = new Set<string>();
    if (doc) {
      for (const o of objects(doc)) {
        if (!o.visibility || !/^App::(Plane|Line)$/.test(o.type)) continue;
        const role = (property(doc, o.name, "Role")?.value as string | undefined) ?? o.name.replace(/\d+$/, "");
        roles.add(role);
      }
    }
    if (picker) ["XY_Plane", "XZ_Plane", "YZ_Plane"].forEach((r) => roles.add(r));
    const size = Math.max(this.sceneRadius() * 0.6, 10);
    const key = `${[...roles].sort().join()}|${picker?.selected ?? ""}|${size.toFixed(3)}`;
    if (key === this.originKey) return;
    this.originKey = key;
    for (const c of [...this.originGroup.children]) {
      this.originGroup.remove(c);
      c.traverse((x) => {
        (x as THREE.Mesh).geometry?.dispose();
        ((x as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
      });
    }
    const planes: Record<string, THREE.Quaternion> = {
      XY_Plane: new THREE.Quaternion(),
      XZ_Plane: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
      YZ_Plane: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
    };
    for (const [role, q] of Object.entries(planes)) {
      if (!roles.has(role)) continue;
      const selected = picker?.selected === role;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          color: selected ? 0x1cad1c : 0xffff66,
          transparent: true,
          opacity: selected ? 0.45 : 0.25,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      mesh.quaternion.copy(q);
      mesh.userData.originRole = role;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: selected ? 0x1cad1c : 0xb3b380 }),
      );
      edges.quaternion.copy(q);
      this.originGroup.add(mesh, edges);
    }
    const axes: Record<string, [THREE.Vector3, number]> = {
      X_Axis: [new THREE.Vector3(1, 0, 0), 0xcc3333],
      Y_Axis: [new THREE.Vector3(0, 1, 0), 0x33cc33],
      Z_Axis: [new THREE.Vector3(0, 0, 1), 0x3333cc],
    };
    for (const [role, [d, color]] of Object.entries(axes)) {
      if (!roles.has(role)) continue;
      const g = new THREE.BufferGeometry().setFromPoints([d.clone().multiplyScalar(-size * 0.6), d.clone().multiplyScalar(size * 0.6)]);
      this.originGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
    }
    this.invalidate();
  }

  /** The origin plane (picker mode) under a screen point. */
  private pickOriginPlane(x: number, y: number): string | null {
    if (!useView3D.getState().originPicker) return null;
    this.updateCamera();
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const meshes = this.originGroup.children.filter((c) => c.userData.originRole);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return (hit?.object.userData.originRole as string | undefined) ?? null;
  }

  // ------------------------------------------------------------------------------ picking

  /** Screen (CSS px, relative to the canvas) → NDC. */
  ndc(x: number, y: number): THREE.Vector2 {
    return new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  /** World → [screen x, screen y, depth 0..1]. */
  project = (wx: number, wy: number, wz: number): [number, number, number] => {
    const v = tmpV.set(wx, wy, wz).project(this.camera);
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height, (v.z + 1) / 2];
  };

  /** The ray through a screen point, and where it meets the plane through `point` with normal `normal`. */
  rayAt(x: number, y: number): THREE.Ray {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    return this.raycaster.ray.clone();
  }

  pick(x: number, y: number): PickResult | null {
    if (!this.doc) return null;
    this.updateCamera();
    const overrides = useViewProps.getState().overrides;
    const cam = this.camera;
    this.raycaster.setFromCamera(this.ndc(x, y), cam);
    const meshes: THREE.Object3D[] = [];
    const candidates: ObjectView[] = [];
    for (const [name, v] of this.views) {
      if (!v.group.visible) continue;
      if (!viewPropsOf(this.doc, name, v.type, overrides).Selectable) continue;
      candidates.push(v);
      if (v.mesh?.visible) meshes.push(v.mesh);
    }
    let face: (PickResult & { depth: number }) | null = null;
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (hit && hit.faceIndex !== undefined && hit.faceIndex !== null) {
      const name = hit.object.userData.object as string;
      const v = this.views.get(name)!;
      const tri = hit.faceIndex;
      // binary search over face ranges
      let lo = 0;
      let hi = v.tess.faceCount - 1;
      let faceIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const first = v.tess.faces[2 * mid]!;
        const count = v.tess.faces[2 * mid + 1]!;
        if (tri < first) hi = mid - 1;
        else if (tri >= first + count) lo = mid + 1;
        else {
          faceIdx = mid;
          break;
        }
      }
      if (faceIdx >= 0) {
        const p = hit.point;
        face = { object: name, sub: subName("Face", faceIdx), point: [p.x, p.y, p.z], depth: this.project(p.x, p.y, p.z)[2] };
      }
    }
    let edge: (PickResult & { depth: number }) | null = null;
    let vertex: (PickResult & { depth: number }) | null = null;
    for (const v of candidates) {
      // cheap reject: the object's bounding sphere on screen
      const c = this.project(v.sphere.center.x, v.sphere.center.y, v.sphere.center.z);
      const edgeScreen = this.project(v.sphere.center.x + v.sphere.radius, v.sphere.center.y, v.sphere.center.z);
      const rpx = Math.max(Math.hypot(edgeScreen[0] - c[0], edgeScreen[1] - c[1]), v.sphere.radius * (this.height / this.cam.height));
      if (Math.hypot(c[0] - x, c[1] - y) > rpx + 10) continue;
      if (v.edges?.visible || !v.mesh) {
        const e = pickEdge(v.tess.edgePositions, v.tess.edges, x, y, this.project);
        if (e && (!edge || e.depth < edge.depth)) edge = { object: v.name, sub: subName("Edge", e.edge), point: e.point, depth: e.depth };
      }
      if (v.points?.visible || v.edges?.visible) {
        const p = pickVertex(v.tess.vertices, x, y, this.project);
        if (p && (!vertex || p.depth < vertex.depth))
          vertex = { object: v.name, sub: subName("Vertex", p.vertex), point: p.point, depth: p.depth };
      }
    }
    const best = chooseCandidate(face, edge, vertex, 2e-3);
    return best ? { object: best.object, sub: best.sub, point: best.point } : null;
  }

  // ------------------------------------------------------------------------------ navicube

  private cubeRect(): { x: number; y: number; size: number } {
    const size = NAVICUBE_SIZE;
    return { x: this.width - size - 4, y: 4, size };
  }

  private cubeNdc(x: number, y: number): THREE.Vector2 | null {
    const r = this.cubeRect();
    if (x < r.x || x > r.x + r.size || y < r.y || y > r.y + r.size) return null;
    return new THREE.Vector2(((x - r.x) / r.size) * 2 - 1, -((y - r.y) / r.size) * 2 + 1);
  }

  /** The NaviCube's arrows (orbit 45°) and its view menu are HTML; the viewer exposes the moves. */
  naviStep(dir: "left" | "right" | "up" | "down" | "rollLeft" | "rollRight"): void {
    const step = 45;
    if (dir === "left") this.orbit(-step, 0, true);
    else if (dir === "right") this.orbit(step, 0, true);
    else if (dir === "up") this.orbit(0, -step, true);
    else if (dir === "down") this.orbit(0, step, true);
    else if (dir === "rollLeft") this.rotateAroundView(step);
    else this.rotateAroundView(-step);
  }

  // ------------------------------------------------------------------------------ input

  private onPointerDown(e: PointerEvent): void {
    this.renderer.domElement.focus({ preventScroll: true });
    const { x, y } = this.local(e);
    if (this.edit?.pointerDown?.(e, this)) return;
    const onCube = !!this.cubeNdc(x, y) && useView3D.getState().naviCube;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    if (this.drag) {
      // a second button joined the drag (CAD style: middle + left rotates)
      this.drag.buttons = e.buttons;
      this.drag.action = dragAction(useView3D.getState().navigationStyle, maskButtons(e.buttons), mods(e));
      return;
    }
    this.drag = { x, y, lastX: x, lastY: y, buttons: e.buttons, moved: false, action: null, onCube };
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.local(e);
    if (this.edit?.pointerMove?.(e, this) && !this.drag) return;
    const d = this.drag;
    if (d && (e.buttons !== 0 || d.moved)) {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) > DRAG_THRESHOLD) {
        d.moved = true;
        let action = dragAction(useView3D.getState().navigationStyle, maskButtons(d.buttons), mods(e));
        // In sketch edit mode the left button draws and selects; it never rotates.
        if (this.edit && action === "rotate" && (d.buttons & 1) !== 0 && (d.buttons & 6) === 0) action = null;
        d.action = action;
        if (d.onCube && (d.buttons & 1) !== 0) d.action = "rotate";
      }
      if (d.moved && d.action) {
        const dx = x - d.lastX;
        const dy = y - d.lastY;
        if (d.action === "rotate") this.orbit(dx * 0.4, dy * 0.4);
        else if (d.action === "pan") this.pan(dx, dy);
        else if (d.action === "zoom") this.zoomAt(d.x, d.y, Math.exp(dy * 0.01));
        this.renderer.domElement.style.cursor = d.action === "rotate" ? "grabbing" : d.action === "pan" ? "move" : "ns-resize";
      }
      d.lastX = x;
      d.lastY = y;
      return;
    }
    // hover: the cube first, then preselection (once per frame)
    const ndc = useView3D.getState().naviCube ? this.cubeNdc(x, y) : null;
    const region = ndc ? this.navi.pick(ndc.x, ndc.y) : null;
    if (this.navi.hover(region, !!ndc)) this.invalidate();
    if (ndc) {
      useSelection.getState().setPreselection(null);
      return;
    }
    this.hoverPending = { x, y };
    this.lastHover = { x, y };
  }

  private onPointerUp(e: PointerEvent): void {
    const { x, y } = this.local(e);
    const d = this.drag;
    try {
      this.renderer.domElement.releasePointerCapture(e.pointerId);
    } catch {
      // not captured
    }
    if (this.edit?.pointerUp?.(e, this) && !(d && d.moved)) {
      if (e.buttons === 0) this.drag = null;
      return;
    }
    if (e.buttons !== 0 && d) {
      d.buttons = e.buttons;
      return;
    }
    this.drag = null;
    this.renderer.domElement.style.cursor = "";
    if (!d || d.moved) return;
    if (d.onCube && e.button === 0) {
      const ndc = this.cubeNdc(x, y);
      const region = ndc ? this.navi.pick(ndc.x, ndc.y) : null;
      if (region) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.cam.quat);
        this.setOrientation(NaviCube.orientationFor(region, up));
      }
      return;
    }
    if (e.button === 2) {
      this.onContextMenu(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0 || !this.doc || this.edit) return;
    const plane = this.pickOriginPlane(x, y);
    if (plane) {
      useView3D.getState().originPicker?.pick(plane);
      return;
    }
    const hit = this.pick(x, y);
    const sel = useSelection.getState();
    if (!hit) {
      if (!e.ctrlKey) sel.clear();
      return;
    }
    const item: SelItem = { doc: this.doc, object: hit.object, sub: hit.sub, point: hit.point };
    if (e.ctrlKey || e.metaKey) sel.select(item, { add: true, toggle: true });
    else sel.select(item);
  }

  private onPointerLeave(): void {
    this.hoverPending = null;
    this.lastHover = null;
    useSelection.getState().setPreselection(null);
    if (this.navi.hover(null, false)) this.invalidate();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomAt(x, y, Math.exp(Math.max(-1, Math.min(1, delta * 0.0015))));
  }

  private onDblClick(e: MouseEvent): void {
    if (this.edit) return;
    const { x, y } = this.local(e);
    if (this.cubeNdc(x, y)) return;
    this.onDoubleClick(this.pick(x, y));
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pan(dx: number, dy: number): void {
    const s = this.cam.height / this.height;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.cam.quat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.cam.quat);
    this.cam.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    this.invalidate();
  }

  /** Zoom keeping the point under the cursor fixed (FreeCAD's "Zoom at cursor"). */
  private zoomAt(x: number, y: number, factor: number): void {
    const s = this.cam.height / this.height;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.cam.quat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.cam.quat);
    const ox = (x - this.width / 2) * s;
    const oy = (this.height / 2 - y) * s;
    const p = this.cam.target.clone().addScaledVector(right, ox).addScaledVector(up, oy);
    this.cam.height = Math.min(Math.max(this.cam.height * factor, 1e-4), 1e7);
    const ns = this.cam.height / this.height;
    this.cam.target
      .copy(p)
      .addScaledVector(right, -(x - this.width / 2) * ns)
      .addScaledVector(up, -(this.height / 2 - y) * ns);
    this.invalidate();
  }

  // ------------------------------------------------------------------------------ helpers

  private buildAxisCross(): void {
    const mk = (d: [number, number, number], color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...d)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
      this.axisCross.add(l);
    };
    mk([1, 0, 0], 0xcc3333);
    mk([0, 1, 0], 0x33cc33);
    mk([0, 0, 1], 0x3333cc);
  }

  private buildCornerAxes(): void {
    const mk = (d: THREE.Vector3, color: string, label: string) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), d]);
      this.cornerScene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
      if (typeof document === "undefined") return;
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = color;
      ctx.font = "bold 24px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 16, 17);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      sprite.position.copy(d).multiplyScalar(1.25);
      sprite.scale.setScalar(0.55);
      this.cornerScene.add(sprite);
    };
    mk(new THREE.Vector3(1, 0, 0), "#cc3333", "X");
    mk(new THREE.Vector3(0, 1, 0), "#33cc33", "Y");
    mk(new THREE.Vector3(0, 0, 1), "#3333cc", "Z");
  }

  // ------------------------------------------------------------------------------ render

  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    const camKey = `${this.cam.target.toArray().join()},${this.cam.quat.toArray().join()},${this.cam.height},${this.views.size}`;
    if (!this.hoverPending && this.lastHover && camKey !== this.hoverCamKey && !this.anim) this.hoverPending = this.lastHover;
    if (this.hoverPending) {
      this.hoverCamKey = camKey;
      const { x, y } = this.hoverPending;
      this.hoverPending = null;
      if (!this.drag && !this.edit) {
        const hit = this.pick(x, y);
        useSelection
          .getState()
          .setPreselection(hit && this.doc ? { doc: this.doc, object: hit.object, sub: hit.sub, point: hit.point } : null);
        this.renderer.domElement.style.cursor = hit ? "pointer" : "";
      }
    }
    if (this.anim) {
      const a = this.anim;
      const t = Math.min(1, (performance.now() - a.t0) / a.ms);
      const k = t * t * (3 - 2 * t);
      this.cam.quat.slerpQuaternions(a.from, a.to, k);
      if (a.fromTarget && a.toTarget) this.cam.target.lerpVectors(a.fromTarget, a.toTarget, k);
      if (a.fromH !== undefined && a.toH !== undefined) this.cam.height = a.fromH + (a.toH - a.fromH) * k;
      if (t >= 1) this.anim = null;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
  };

  render(): void {
    this.updateCamera();
    this.edit?.beforeRender?.(this);
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.clear();
    r.render(this.bgScene, this.bgCamera);
    r.clearDepth();
    const radius = this.sceneRadius();
    this.axisCross.scale.setScalar(radius);
    r.render(this.scene, this.camera);
    // corner axis cross, bottom right
    const cs = 90;
    r.clearDepth();
    r.setScissorTest(true);
    r.setViewport(this.width - cs, 0, cs, cs);
    r.setScissor(this.width - cs, 0, cs, cs);
    r.render(this.cornerScene, this.cornerCamera);
    if (useView3D.getState().naviCube) {
      const c = this.cubeRect();
      r.clearDepth();
      r.setViewport(c.x, this.height - c.y - c.size, c.size, c.size);
      r.setScissor(c.x, this.height - c.y - c.size, c.size, c.size);
      r.render(this.navi.scene, this.navi.camera);
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
  }

  /** The status bar's preselection text (`getPreselectionInfo`). */
  static preselectionText(p: SelItem): string {
    const pt = p.point ? ` ${formatPoint(p.point)}` : "";
    return `Preselected: ${p.doc}.${p.object}${p.sub ? `.${p.sub}` : ""}${pt}`;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    for (const o of this.offs) o();
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    this.edit?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function srgb(css: string): THREE.Vector3 {
  const n = parseInt(css.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function maskButtons(mask: number) {
  return { left: (mask & 1) !== 0, right: (mask & 2) !== 0, middle: (mask & 4) !== 0 };
}

function mods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) {
  return { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
}

export { sameItem, useSession };

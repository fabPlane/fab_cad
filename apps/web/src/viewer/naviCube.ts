/**
 * FreeCAD's navigation cube (`NaviCube.cpp`): a chamfered cube drawn in the top-right corner that
 * turns with the camera. Its 6 faces, 12 edge strips and 8 corners are clickable (view from that
 * direction); hovering highlights; the arrows around it orbit by 45° (`NaviStepByTurn` = 8).
 * Colours of FreeCAD Light: base #f2f2f2, text #212529, highlight #aae2ff, inactive opacity 0.5.
 */
import * as THREE from "three";

export const NAVICUBE_SIZE = 132;
const CHAMFER = 0.12;
const BASE = new THREE.Color("#f2f2f2");
const EDGE_BASE = new THREE.Color("#dedede");
const HILITE = new THREE.Color("#aae2ff");

export interface CubeRegion {
  mesh: THREE.Mesh;
  /** Outward direction: the camera ends up on this side, looking back at the origin. */
  normal: THREE.Vector3;
  /** Camera up for a main face (FreeCAD's standard view); undefined: derive from +Z. */
  up?: THREE.Vector3;
  label?: string;
}

const FACES: { label: string; n: [number, number, number]; right: [number, number, number]; up: [number, number, number] }[] = [
  { label: "TOP", n: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { label: "FRONT", n: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { label: "RIGHT", n: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  { label: "REAR", n: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { label: "LEFT", n: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  { label: "BOTTOM", n: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0] },
];

function labelTexture(text: string): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#f2f2f2";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#212529";
  g.font = `bold ${text.length > 5 ? 22 : 26}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function quad(center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, hw: number, hh: number): THREE.BufferGeometry {
  const p = [
    center.clone().addScaledVector(right, -hw).addScaledVector(up, -hh),
    center.clone().addScaledVector(right, hw).addScaledVector(up, -hh),
    center.clone().addScaledVector(right, hw).addScaledVector(up, hh),
    center.clone().addScaledVector(right, -hw).addScaledVector(up, hh),
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      p.flatMap((v) => [v.x, v.y, v.z]),
      3,
    ),
  );
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function polygon(points: THREE.Vector3[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      points.flatMap((v) => [v.x, v.y, v.z]),
      3,
    ),
  );
  const idx: number[] = [];
  for (let i = 1; i + 1 < points.length; i++) idx.push(0, i, i + 1);
  g.setIndex(idx);
  return g;
}

export class NaviCube {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20);
  readonly regions: CubeRegion[] = [];
  private hovered: CubeRegion | null = null;
  private readonly root = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  active = false;

  constructor() {
    this.scene.add(this.root);
    const s = 1 - CHAMFER;
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    for (const f of FACES) {
      const n = v(...f.n);
      const tex = labelTexture(f.label);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: tex, side: THREE.FrontSide, transparent: true });
      const mesh = new THREE.Mesh(quad(n.clone(), v(...f.right), v(...f.up), s, s), mat);
      this.addRegion({ mesh, normal: n, up: v(...f.up), label: f.label });
    }
    // Edge strips: between two main faces, along the edge where they meet.
    const axes = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)];
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        for (const sa of [-1, 1]) {
          for (const sb of [-1, 1]) {
            const na = axes[a]!.clone().multiplyScalar(sa);
            const nb = axes[b]!.clone().multiplyScalar(sb);
            const along = axes[3 - a - b]!;
            const p1 = na.clone().addScaledVector(nb, s);
            const p2 = nb.clone().addScaledVector(na, s);
            const pts = [
              p1.clone().addScaledVector(along, -s),
              p2.clone().addScaledVector(along, -s),
              p2.clone().addScaledVector(along, s),
              p1.clone().addScaledVector(along, s),
            ];
            const normal = na.clone().add(nb).normalize();
            // wind outward
            const e1 = pts[1]!.clone().sub(pts[0]!);
            const e2 = pts[2]!.clone().sub(pts[0]!);
            if (e1.cross(e2).dot(normal) < 0) pts.reverse();
            const mesh = new THREE.Mesh(polygon(pts), new THREE.MeshBasicMaterial({ color: EDGE_BASE, transparent: true }));
            this.addRegion({ mesh, normal });
          }
        }
      }
    }
    // Corners: the triangle joining the three chamfers.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const pts = [v(sx, sy * s, sz * s), v(sx * s, sy, sz * s), v(sx * s, sy * s, sz)];
          const normal = v(sx, sy, sz).normalize();
          const e1 = pts[1]!.clone().sub(pts[0]!);
          const e2 = pts[2]!.clone().sub(pts[0]!);
          if (e1.cross(e2).dot(normal) < 0) pts.reverse();
          const mesh = new THREE.Mesh(polygon(pts), new THREE.MeshBasicMaterial({ color: EDGE_BASE, transparent: true }));
          this.addRegion({ mesh, normal });
        }
      }
    }
    // Outline of the main faces.
    const outline: number[] = [];
    for (const f of FACES) {
      const n = v(...f.n);
      const r = v(...f.right);
      const u = v(...f.up);
      const c = [
        n.clone().addScaledVector(r, -s).addScaledVector(u, -s),
        n.clone().addScaledVector(r, s).addScaledVector(u, -s),
        n.clone().addScaledVector(r, s).addScaledVector(u, s),
        n.clone().addScaledVector(r, -s).addScaledVector(u, s),
      ];
      for (let i = 0; i < 4; i++) outline.push(...c[i]!.toArray(), ...c[(i + 1) % 4]!.toArray());
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute("position", new THREE.Float32BufferAttribute(outline, 3));
    this.root.add(new THREE.LineSegments(og, new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true })));
    // The axis triad from the cube's rear-left-bottom corner (FreeCAD 1.x draws X, Y, Z there).
    const o = v(-1.05, -1.05, -1.05);
    const axis = (d: THREE.Vector3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([o, o.clone().addScaledVector(d, 2.5)]);
      this.root.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color, linewidth: 2 })));
    };
    axis(v(1, 0, 0), 0xcc3333);
    axis(v(0, 1, 0), 0x33cc33);
    axis(v(0, 0, 1), 0x3333cc);
    this.setOpacity(0.5);
  }

  private addRegion(r: CubeRegion): void {
    r.mesh.userData.region = r;
    this.regions.push(r);
    this.root.add(r.mesh);
  }

  private setOpacity(o: number): void {
    this.root.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.Material | undefined;
      if (m && "opacity" in m) {
        m.opacity = o;
        m.transparent = o < 1;
      }
    });
  }

  /** Follow the main camera's orientation. */
  sync(quaternion: THREE.Quaternion): void {
    this.camera.quaternion.copy(quaternion);
    this.camera.position.set(0, 0, 6).applyQuaternion(quaternion);
    this.camera.updateMatrixWorld();
  }

  /** The region under normalized device coordinates of the cube viewport, if any. */
  pick(ndcX: number, ndcY: number): CubeRegion | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.intersectObjects(
      this.regions.map((r) => r.mesh),
      false,
    )[0];
    return (hit?.object.userData.region as CubeRegion | undefined) ?? null;
  }

  /** Highlight a region (null: none). Returns true when something changed. */
  hover(r: CubeRegion | null, active: boolean): boolean {
    const changed = r !== this.hovered || active !== this.active;
    if (!changed) return false;
    for (const reg of this.regions) {
      const m = reg.mesh.material as THREE.MeshBasicMaterial;
      m.color.copy(reg === r ? HILITE : reg.label ? new THREE.Color(0xffffff) : EDGE_BASE);
    }
    this.hovered = r;
    this.active = active;
    this.setOpacity(active ? 1 : 0.5);
    return true;
  }

  /** The camera orientation that looks at the origin from a region's side. */
  static orientationFor(r: Pick<CubeRegion, "normal" | "up">, currentUp: THREE.Vector3): THREE.Quaternion {
    const eye = r.normal.clone();
    let up = r.up?.clone();
    if (!up) {
      up = new THREE.Vector3(0, 0, 1);
      if (Math.abs(eye.dot(up)) > 0.95) up = currentUp.clone();
      up.sub(eye.clone().multiplyScalar(up.dot(eye))).normalize();
    }
    const m = new THREE.Matrix4().lookAt(eye, new THREE.Vector3(0, 0, 0), up);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  static base(): THREE.Color {
    return BASE.clone();
  }
}

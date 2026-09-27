/**
 * State of the 3D view (`View3DInventor`): draw style, camera type, navigation style, the axis
 * cross, and the handle commands use to reach the viewer (fit all, standard views, ...).
 */
import { create } from "zustand";

export type DrawStyle = "As Is" | "Points" | "Wireframe" | "Hidden Line" | "No Shading" | "Shaded" | "Flat Lines";

export const DRAW_STYLES: { id: string; style: DrawStyle; menuText: string; pixmap: string; accel: string }[] = [
  { id: "Std_DrawStyleAsIs", style: "As Is", menuText: "&1 As Is", pixmap: "DrawStyleAsIs", accel: "V, 1" },
  { id: "Std_DrawStylePoints", style: "Points", menuText: "&2 Points", pixmap: "DrawStylePoints", accel: "V, 2" },
  { id: "Std_DrawStyleWireframe", style: "Wireframe", menuText: "&3 Wireframe", pixmap: "DrawStyleWireFrame", accel: "V, 3" },
  { id: "Std_DrawStyleHiddenLine", style: "Hidden Line", menuText: "&4 Hidden Line", pixmap: "DrawStyleHiddenLine", accel: "V, 4" },
  { id: "Std_DrawStyleNoShading", style: "No Shading", menuText: "&5 No Shading", pixmap: "DrawStyleNoShading", accel: "V, 5" },
  { id: "Std_DrawStyleShaded", style: "Shaded", menuText: "&6 Shaded", pixmap: "DrawStyleShaded", accel: "V, 6" },
  { id: "Std_DrawStyleFlatLines", style: "Flat Lines", menuText: "&7 Flat Lines", pixmap: "DrawStyleFlatLines", accel: "V, 7" },
];

/** FreeCAD's navigation styles (`NavigationStyle` subclasses), in the status bar menu order. */
export const NAVIGATION_STYLES = [
  "Blender",
  "CAD",
  "Gesture",
  "Maya-Gesture",
  "OpenCascade",
  "OpenInventor",
  "OpenSCAD",
  "Revit",
  "Siemens NX",
  "SolidWorks",
  "TinkerCAD",
  "Touchpad",
] as const;
export type NavigationStyle = (typeof NAVIGATION_STYLES)[number];

export type StandardView = "Isometric" | "Dimetric" | "Trimetric" | "Front" | "Top" | "Right" | "Rear" | "Bottom" | "Left" | "Home";

/** What commands can ask of the viewer. */
export interface ViewerHandle {
  fitAll(): void;
  fitSelection(): void;
  setStandardView(v: StandardView): void;
  rotateAroundView(deg: number): void;
  zoom(factor: number): void;
  alignToSelection(): void;
  screenshot(): string | null;
}

interface View3DState {
  drawStyle: DrawStyle;
  orthographic: boolean;
  navigationStyle: NavigationStyle;
  axisCross: boolean;
  naviCube: boolean;
  /** "123.45 mm x 67.89 mm", the status bar's view dimension. */
  dimensions: string;
  /**
   * The origin's planes shown for picking (Part Design's "Select feature" dialog shows them the way
   * FreeCAD's TempoVis does): the highlighted role and what a click on a plane does.
   */
  originPicker: { selected: string; pick: (role: string) => void } | null;
  setOriginPicker: (p: { selected: string; pick: (role: string) => void } | null) => void;
  setDrawStyle: (s: DrawStyle) => void;
  setOrthographic: (b: boolean) => void;
  setNavigationStyle: (s: NavigationStyle) => void;
  toggleAxisCross: () => void;
  setDimensions: (d: string) => void;
}

const NAV_KEY = "fab-cad.navigation-style";

function initialNavigation(): NavigationStyle {
  try {
    const s = localStorage.getItem(NAV_KEY);
    if (s && (NAVIGATION_STYLES as readonly string[]).includes(s)) return s as NavigationStyle;
  } catch {
    // no storage
  }
  return "Gesture";
}

export const useView3D = create<View3DState>((set, get) => ({
  drawStyle: "As Is",
  orthographic: true,
  navigationStyle: initialNavigation(),
  axisCross: false,
  naviCube: true,
  dimensions: "",
  originPicker: null,
  setOriginPicker: (p) => set({ originPicker: p }),
  setDrawStyle: (s) => set({ drawStyle: s }),
  setOrthographic: (b) => set({ orthographic: b }),
  setNavigationStyle: (s) => {
    try {
      localStorage.setItem(NAV_KEY, s);
    } catch {
      // no storage
    }
    set({ navigationStyle: s });
  },
  toggleAxisCross: () => set({ axisCross: !get().axisCross }),
  setDimensions: (d) => (get().dimensions === d ? undefined : set({ dimensions: d })),
}));

let current: ViewerHandle | null = null;

export function setViewer(v: ViewerHandle | null): void {
  current = v;
}

export function viewer(): ViewerHandle | null {
  return current;
}

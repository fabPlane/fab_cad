/**
 * Mouse bindings of FreeCAD's navigation styles (`src/Gui/Navigation/*NavigationStyle.cpp`),
 * reduced to what a drag does. A press and release without moving is a click (selection with the
 * left button, the context menu with the right one) in every style.
 */
import type { NavigationStyle } from "../state/view3d";

export type DragAction = "rotate" | "pan" | "zoom" | null;

export interface Buttons {
  left: boolean;
  middle: boolean;
  right: boolean;
}

export interface Mods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export function buttonsFromMask(mask: number): Buttons {
  return { left: (mask & 1) !== 0, right: (mask & 2) !== 0, middle: (mask & 4) !== 0 };
}

/** What dragging with these buttons and modifiers does in a style. */
export function dragAction(style: NavigationStyle, b: Buttons, m: Mods): DragAction {
  const { left: L, middle: M, right: R } = b;
  switch (style) {
    case "Gesture":
      if (L && R) return "zoom";
      if (L) return m.ctrl ? "pan" : "rotate";
      if (R || M) return "pan";
      return null;
    case "CAD":
      if (M && (L || R)) return "rotate";
      if (M) return m.ctrl ? "zoom" : m.shift ? "rotate" : "pan";
      return null;
    case "OpenInventor":
      if (L && M) return "zoom";
      if (L) return m.ctrl ? "pan" : "rotate";
      if (M) return "pan";
      return null;
    case "Blender":
      if (M) return m.shift ? "pan" : m.ctrl ? "zoom" : "rotate";
      if (L && R) return "pan";
      if (R) return "pan";
      return null;
    case "Touchpad":
      if (L) return m.shift ? "pan" : m.alt ? "rotate" : "rotate";
      if (R || M) return "pan";
      return null;
    case "Revit":
      if (M) return m.shift ? "rotate" : "pan";
      return null;
    case "TinkerCAD":
      if (R) return "rotate";
      if (M) return "pan";
      return null;
    case "OpenCascade":
      if (L && m.ctrl) return "zoom";
      if (M) return "pan";
      if (R) return "rotate";
      return null;
    case "Maya-Gesture":
      if (m.alt && L) return "rotate";
      if (m.alt && M) return "pan";
      if (m.alt && R) return "zoom";
      if (L) return "rotate";
      if (R || M) return "pan";
      return null;
    case "SolidWorks":
      if (M) return m.ctrl ? "pan" : m.shift ? "zoom" : "rotate";
      return null;
    case "Siemens NX":
      if (M && R) return "pan";
      if (M) return m.shift ? "pan" : m.ctrl ? "zoom" : "rotate";
      return null;
    case "OpenSCAD":
      if (L) return "rotate";
      if (R) return m.shift ? "zoom" : "pan";
      if (M) return "zoom";
      return null;
  }
}

/** A short description for the status bar tooltip, as FreeCAD's navigation style hints. */
export function styleHint(style: NavigationStyle): string {
  switch (style) {
    case "Gesture":
      return "Select: left click · Rotate: left drag · Pan: right or middle drag · Zoom: wheel (at cursor)";
    case "CAD":
      return "Select: left click · Pan: middle drag · Rotate: middle + left/right drag · Zoom: wheel";
    case "OpenInventor":
      return "Select: left click · Rotate: left drag · Pan: middle drag · Zoom: wheel or left + middle drag";
    case "Blender":
      return "Select: left click · Rotate: middle drag · Pan: Shift + middle drag or right drag · Zoom: wheel";
    case "Touchpad":
      return "Select: left click · Rotate: left drag · Pan: Shift + drag or right drag · Zoom: wheel";
    case "Revit":
      return "Select: left click · Pan: middle drag · Rotate: Shift + middle drag · Zoom: wheel";
    case "TinkerCAD":
      return "Select: left click · Rotate: right drag · Pan: middle drag · Zoom: wheel";
    case "OpenCascade":
      return "Select: left click · Pan: middle drag · Rotate: right drag · Zoom: Ctrl + left drag or wheel";
    case "Maya-Gesture":
      return "Select: left click · Rotate: Alt + left drag · Pan: Alt + middle drag · Zoom: Alt + right drag or wheel";
    case "SolidWorks":
      return "Select: left click · Rotate: middle drag · Pan: Ctrl + middle drag · Zoom: Shift + middle drag or wheel";
    case "Siemens NX":
      return "Select: left click · Rotate: middle drag · Pan: Shift + middle drag · Zoom: Ctrl + middle drag or wheel";
    case "OpenSCAD":
      return "Select: left click · Rotate: left drag · Pan: right drag · Zoom: middle drag or wheel";
  }
}

/** Pixels the pointer may move before a press becomes a drag. */
export const DRAG_THRESHOLD = 3;

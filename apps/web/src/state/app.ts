/**
 * UI state that is not FreeCAD's: the active workbench, which MDI tab is in front, the panels,
 * the Combo View's tabs, the open task dialog and the object being edited.
 */
import { create } from "zustand";

export type WorkbenchId = "PartDesignWorkbench" | "PartWorkbench" | "SketcherWorkbench" | "NoneWorkbench";

export interface EditState {
  doc: string;
  object: string;
  kind: "sketch";
}

/** A task dialog in the Tasks tab (`Gui::TaskView::TaskDialog`). */
export interface TaskDialog {
  id: string;
  title: string;
  icon?: string;
  /** Render the dialog body. */
  render: () => React.ReactNode;
  accept: () => Promise<boolean | void> | boolean | void;
  reject: () => Promise<void> | void;
  /** Button set; FreeCAD's default is OK + Cancel. */
  buttons?: ("ok" | "cancel" | "close")[];
}

export interface Panels {
  comboView: boolean;
  report: boolean;
  python: boolean;
  statusBar: boolean;
}

interface AppState {
  workbench: WorkbenchId;
  /** Document shown in the 3D view (the active MDI window); `null` = the Start page. */
  activeDoc: string | null;
  /** Documents with an MDI tab, in tab order. */
  openTabs: string[];
  startTab: boolean;
  panels: Panels;
  comboTab: "model" | "tasks";
  propertyTab: "view" | "data";
  showAllProperties: boolean;
  task: TaskDialog | null;
  editing: EditState | null;
  /** Rename request for the tree (F2). */
  renaming: { doc: string; object: string } | null;
  setWorkbench: (w: WorkbenchId) => void;
  setActiveDoc: (doc: string | null) => void;
  openTab: (doc: string) => void;
  closeTab: (doc: string) => void;
  showStart: () => void;
  closeStart: () => void;
  togglePanel: (p: keyof Panels) => void;
  setComboTab: (t: "model" | "tasks") => void;
  setPropertyTab: (t: "view" | "data") => void;
  setShowAllProperties: (b: boolean) => void;
  openTask: (t: TaskDialog) => void;
  closeTask: () => void;
  setEditing: (e: EditState | null) => void;
  setRenaming: (r: { doc: string; object: string } | null) => void;
}

const WB_KEY = "fab-cad.workbench";

function initialWorkbench(): WorkbenchId {
  try {
    const w = localStorage.getItem(WB_KEY);
    if (w === "PartDesignWorkbench" || w === "PartWorkbench" || w === "SketcherWorkbench") return w;
  } catch {
    // no storage
  }
  return "PartDesignWorkbench";
}

export const useApp = create<AppState>((set, get) => ({
  workbench: initialWorkbench(),
  activeDoc: null,
  openTabs: [],
  startTab: true,
  panels: { comboView: true, report: true, python: true, statusBar: true },
  comboTab: "model",
  propertyTab: "data",
  showAllProperties: false,
  task: null,
  editing: null,
  renaming: null,
  setWorkbench: (w) => {
    try {
      localStorage.setItem(WB_KEY, w);
    } catch {
      // no storage
    }
    set({ workbench: w });
  },
  setActiveDoc: (doc) => {
    if (doc === null) return set({ activeDoc: null });
    const tabs = get().openTabs.includes(doc) ? get().openTabs : [...get().openTabs, doc];
    set({ activeDoc: doc, openTabs: tabs });
  },
  openTab: (doc) => {
    if (!get().openTabs.includes(doc)) set({ openTabs: [...get().openTabs, doc] });
  },
  closeTab: (doc) => {
    const tabs = get().openTabs.filter((d) => d !== doc);
    const active = get().activeDoc === doc ? (tabs[tabs.length - 1] ?? null) : get().activeDoc;
    set({ openTabs: tabs, activeDoc: active });
  },
  showStart: () => set({ startTab: true, activeDoc: null }),
  closeStart: () => set({ startTab: false, activeDoc: get().activeDoc ?? get().openTabs[0] ?? null }),
  togglePanel: (p) => set({ panels: { ...get().panels, [p]: !get().panels[p] } }),
  setComboTab: (t) => set({ comboTab: t }),
  setPropertyTab: (t) => set({ propertyTab: t }),
  setShowAllProperties: (b) => set({ showAllProperties: b }),
  openTask: (t) => set({ task: t, comboTab: "tasks" }),
  closeTask: () => set({ task: null, comboTab: "model" }),
  setEditing: (e) => set({ editing: e }),
  setRenaming: (r) => set({ renaming: r }),
}));

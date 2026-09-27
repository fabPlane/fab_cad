/**
 * FreeCAD's selection (`Gui::Selection()`): a list of (document, object, sub-element, picked point)
 * and one preselection. The tree, the 3D view, the property view and the commands all read it.
 */
import { create } from "zustand";
import { echo } from "./console";
import { pyNum, pyStr } from "../lib/format";

export interface SelItem {
  doc: string;
  object: string;
  /** `Face3`, `Edge1`, `Vertex2` or `""` for the whole object. */
  sub: string;
  /** The picked point, global frame (mm). */
  point?: [number, number, number];
}

interface SelectionState {
  selection: SelItem[];
  preselection: SelItem | null;
  setPreselection: (p: SelItem | null) => void;
  /** Replace the selection (`add: false`) or add to it; `toggle` removes an item already there. */
  select: (item: SelItem, opts?: { add?: boolean; toggle?: boolean; echo?: boolean }) => void;
  setSelection: (items: SelItem[]) => void;
  clear: (doc?: string) => void;
  /** Drop items whose objects are gone. */
  prune: (exists: (doc: string, object: string) => boolean) => void;
}

export const sameItem = (a: SelItem, b: SelItem) => a.doc === b.doc && a.object === b.object && a.sub === b.sub;

export function selectionEcho(item: SelItem): string {
  const args = [pyStr(item.doc), pyStr(item.object), pyStr(item.sub)];
  if (item.point) args.push(...item.point.map((v) => pyNum(Math.round(v * 1e6) / 1e6)));
  return `# Gui.Selection.addSelection(${args.join(",")})`;
}

export const useSelection = create<SelectionState>((set, get) => ({
  selection: [],
  preselection: null,
  setPreselection: (p) => {
    const cur = get().preselection;
    if (cur === p || (cur && p && sameItem(cur, p))) return;
    set({ preselection: p });
  },
  select: (item, opts = {}) => {
    const cur = get().selection;
    const exists = cur.some((s) => sameItem(s, item));
    let next: SelItem[];
    if (opts.toggle && exists) next = cur.filter((s) => !sameItem(s, item));
    else if (opts.add) next = exists ? cur : [...cur, item];
    else next = [item];
    if (opts.echo !== false && !(opts.toggle && exists)) {
      if (!opts.add && cur.length) echo("# Gui.Selection.clearSelection()");
      echo(selectionEcho(item));
    }
    set({ selection: next });
  },
  setSelection: (items) => set({ selection: items }),
  clear: (doc) => {
    const cur = get().selection;
    if (!cur.length) return;
    set({ selection: doc ? cur.filter((s) => s.doc !== doc) : [] });
  },
  prune: (exists) => {
    const cur = get().selection;
    const next = cur.filter((s) => exists(s.doc, s.object));
    const pre = get().preselection;
    if (next.length !== cur.length || (pre && !exists(pre.doc, pre.object))) {
      set({ selection: next, preselection: pre && exists(pre.doc, pre.object) ? pre : null });
    }
  },
}));

/** Selected objects (unique, in selection order), optionally of one document. */
export function selectedObjects(sel: SelItem[], doc?: string | null): string[] {
  const out: string[] = [];
  for (const s of sel) if ((!doc || s.doc === doc) && !out.includes(s.object)) out.push(s.object);
  return out;
}

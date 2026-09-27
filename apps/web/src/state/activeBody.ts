/**
 * The active Part Design body per document (`Gui.activeView().getActiveObject('pdbody')`). The
 * tree shows it in bold; Part Design commands put new features into it.
 */
import { create } from "zustand";
import { objects } from "./session";

interface ActiveBodyState {
  bodies: Record<string, string | null>;
  set: (doc: string, body: string | null) => void;
}

export const useActiveBody = create<ActiveBodyState>((set, get) => ({
  bodies: {},
  set: (doc, body) => set({ bodies: { ...get().bodies, [doc]: body } }),
}));

/** The active body, or the only body of the document. */
export function activeBody(doc: string): string | null {
  const b = useActiveBody.getState().bodies[doc];
  const bodies = objects(doc).filter((o) => o.type === "PartDesign::Body");
  if (b && bodies.some((x) => x.name === b)) return b;
  return bodies.length === 1 ? bodies[0]!.name : null;
}

/** The body an object belongs to (its parent of type Body). */
export function bodyOf(doc: string, name: string): string | null {
  const all = objects(doc);
  const o = all.find((x) => x.name === name);
  if (!o) return null;
  if (o.type === "PartDesign::Body") return o.name;
  for (const p of o.parents) if (all.find((x) => x.name === p)?.type === "PartDesign::Body") return p;
  for (const b of all.filter((x) => x.type === "PartDesign::Body"))
    if (b.children.includes(name) || b.outList.includes(name)) return b.name;
  return null;
}

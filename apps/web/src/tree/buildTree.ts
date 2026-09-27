/**
 * The tree view's structure (`Gui::TreeWidget` / `DocumentItem`): top-level objects are those no
 * one claims; an object's children are its `children` (what its view provider claims). Where
 * FreeCAD's view providers claim more than the App layer reports, the same rules apply here:
 *
 * - `App::Origin` claims its axes, planes and point (FreeCAD's `ViewProviderCoordinateSystem`).
 * - An object claimed by several parents is shown under the most specific one: when one of its
 *   parents is itself a child of another of its parents (a sketch under a Pad, both in a Body),
 *   the outer parent does not show it (`ViewProviderBody` leaves claimed profiles to features).
 */
import type { ObjectInfo } from "@fab-cad/protocol";

export interface TreeNode {
  name: string;
  /** Path of internal names from the root, unique per row (an object can appear twice). */
  key: string;
  children: TreeNode[];
}

const ORIGIN_FEATURE = /^App::(Line|Plane|Point)$/;

export function claimedChildren(objects: ObjectInfo[]): Map<string, string[]> {
  const byName = new Map(objects.map((o) => [o.name, o]));
  const children = new Map<string, string[]>();
  for (const o of objects)
    children.set(
      o.name,
      o.children.filter((c) => byName.has(c)),
    );
  // Origins claim the datum features that link to them.
  for (const o of objects) {
    if (o.type !== "App::Origin" && o.type !== "App::LocalCoordinateSystem") continue;
    const own = children.get(o.name)!;
    for (const f of objects) {
      if (ORIGIN_FEATURE.test(f.type) && f.inList.includes(o.name) && !own.includes(f.name)) own.push(f.name);
    }
  }
  // Datum features whose origin lists them only through the OriginFeatures link (outList).
  for (const o of objects) {
    if (o.type !== "App::Origin") continue;
    const own = children.get(o.name)!;
    for (const n of o.outList) {
      const f = byName.get(n);
      if (f && ORIGIN_FEATURE.test(f.type) && !own.includes(n)) own.push(n);
    }
  }
  // Most specific parent wins.
  const parentsOf = new Map<string, string[]>();
  for (const [p, cs] of children) for (const c of cs) parentsOf.set(c, [...(parentsOf.get(c) ?? []), p]);
  const out = new Map<string, string[]>();
  for (const [p, cs] of children) {
    out.set(
      p,
      cs.filter((c) => {
        const others = (parentsOf.get(c) ?? []).filter((q) => q !== p);
        return !others.some((q) => isDescendant(children, p, q, new Set([c])));
      }),
    );
  }
  return out;
}

function isDescendant(children: Map<string, string[]>, root: string, target: string, seen: Set<string>): boolean {
  if (seen.has(root)) return false;
  seen.add(root);
  for (const c of children.get(root) ?? []) {
    if (c === target || isDescendant(children, c, target, seen)) return true;
  }
  return false;
}

/** The rows of a document, in document order at every level. */
export function buildTree(objects: ObjectInfo[]): TreeNode[] {
  const children = claimedChildren(objects);
  const claimed = new Set<string>();
  for (const cs of children.values()) for (const c of cs) claimed.add(c);
  const order = new Map(objects.map((o, i) => [o.name, i]));
  const make = (name: string, path: string, seen: Set<string>): TreeNode => {
    const key = path ? `${path}/${name}` : name;
    if (seen.has(name)) return { name, key, children: [] };
    const next = new Set(seen).add(name);
    const kids = (children.get(name) ?? []).slice();
    return { name, key, children: kids.map((c) => make(c, key, next)) };
  };
  return objects
    .filter((o) => !claimed.has(o.name))
    .sort((a, b) => order.get(a.name)! - order.get(b.name)!)
    .map((o) => make(o.name, "", new Set()));
}

/** Depth-first list of visible rows given the expanded keys. */
export function flattenTree(
  nodes: TreeNode[],
  expanded: Set<string>,
  depth = 0,
  out: { node: TreeNode; depth: number }[] = [],
): { node: TreeNode; depth: number }[] {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.children.length && expanded.has(n.key)) flattenTree(n.children, expanded, depth + 1, out);
  }
  return out;
}

/** Keys of every node on the way to rows showing `name` (to reveal a selection). */
export function pathsTo(nodes: TreeNode[], name: string): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode, ancestors: string[]) => {
    if (n.name === name) out.push(...ancestors);
    for (const c of n.children) walk(c, [...ancestors, n.key]);
  };
  nodes.forEach((n) => walk(n, []));
  return out;
}

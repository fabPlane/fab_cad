/**
 * The Model tab's tree (`Gui::TreeWidget`): documents and their objects nested by what each
 * object claims, per-type icons with error/recompute overlays, the visibility eye, greyed hidden
 * items, selection synced both ways with the 3D view, preselection on hover, F2 rename and the
 * tree context menu.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { renameObject, setVisibility } from "../commands/actions";
import { useActiveBody } from "../state/activeBody";
import { useApp } from "../state/app";
import { selectedObjects, useSelection, type SelItem } from "../state/selection";
import { documents, object, objects, useModel } from "../state/session";
import { buildTree, flattenTree, pathsTo, type TreeNode } from "../tree/buildTree";
import { TREE_CONTEXT_MENU } from "../workbenches";
import { MenuEntries, run, useCommandContext } from "./commandUi";
import { objectIcon } from "./icons";
import { Icon } from "./widgets";

export function TreeView() {
  const version = useModel();
  const docs = documents();
  const activeDoc = useApp((s) => s.activeDoc);
  const selection = useSelection((s) => s.selection);
  const preselection = useSelection((s) => s.preselection);
  const renaming = useApp((s) => s.renaming);
  const activeBodies = useActiveBody((s) => s.bodies);
  const ctx = useCommandContext();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsedDocs, setCollapsedDocs] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trees = useMemo(() => new Map(docs.map((d) => [d.name, buildTree(objects(d.name))])), [version]);

  // Reveal selected objects (TreeParams::SyncSelection).
  useEffect(() => {
    let changed = false;
    const next = new Set(expanded);
    for (const s of selection) {
      const t = trees.get(s.doc);
      if (!t) continue;
      for (const k of pathsTo(t, s.object)) {
        if (!next.has(k)) {
          next.add(k);
          changed = true;
        }
      }
    }
    if (changed) setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, trees]);

  // Expand bodies and groups when they appear (FreeCAD expands a new body).
  useEffect(() => {
    const next = new Set(expanded);
    let changed = false;
    for (const [doc, t] of trees) {
      for (const n of t) {
        const o = object(doc, n.name);
        if (o && (o.type === "PartDesign::Body" || o.type === "App::Part") && !next.has(`${doc}:${n.key}:seen`)) {
          next.add(`${doc}:${n.key}:seen`);
          next.add(n.key);
          changed = true;
        }
      }
    }
    if (changed) setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trees]);

  const rows: { doc: string; node: TreeNode | null; depth: number }[] = [];
  for (const d of docs) {
    rows.push({ doc: d.name, node: null, depth: 0 });
    if (collapsedDocs.has(d.name)) continue;
    for (const r of flattenTree(trees.get(d.name) ?? [], expanded, 1)) rows.push({ doc: d.name, node: r.node, depth: r.depth });
  }

  const isSelected = (doc: string, name: string) => selection.some((s) => s.doc === doc && s.object === name);

  const onRowClick = (e: MouseEvent, doc: string, name: string) => {
    const sel = useSelection.getState();
    if (useApp.getState().activeDoc !== doc) useApp.getState().setActiveDoc(doc);
    const item: SelItem = { doc, object: name, sub: "" };
    if (e.shiftKey && anchor.current) {
      const names = rows.filter((r) => r.doc === doc && r.node).map((r) => r.node!.name);
      const a = names.indexOf(anchor.current);
      const b = names.indexOf(name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        sel.setSelection([...new Set(names.slice(lo, hi + 1))].map((n) => ({ doc, object: n, sub: "" })));
        return;
      }
    }
    anchor.current = name;
    if (e.ctrlKey || e.metaKey) sel.select(item, { add: true, toggle: true });
    else sel.select(item);
  };

  const onKey = (e: KeyboardEvent) => {
    const sel = useSelection.getState().selection;
    if (!sel.length) return;
    const flat = rows.filter((r) => r.node);
    const i = flat.findIndex((r) => r.doc === sel[sel.length - 1]!.doc && r.node!.name === sel[sel.length - 1]!.object);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) useSelection.getState().select({ doc: next.doc, object: next.node!.name, sub: "" });
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const r = flat[i];
      if (!r?.node) return;
      const next = new Set(expanded);
      if (e.key === "ArrowRight") next.add(r.node.key);
      else next.delete(r.node.key);
      setExpanded(next);
    }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="tree"
          ref={ref}
          tabIndex={0}
          data-testid="tree"
          onKeyDown={onKey}
          onMouseLeave={() => useSelection.getState().setPreselection(null)}
        >
          {rows.map((r) => {
            if (!r.node) {
              const d = docs.find((x) => x.name === r.doc)!;
              const open = !collapsedDocs.has(r.doc);
              return (
                <div
                  key={`doc:${r.doc}`}
                  className="tree-row doc-row"
                  data-testid={`tree-doc-${r.doc}`}
                  onClick={() => {
                    useApp.getState().setActiveDoc(r.doc);
                    useSelection.getState().clear();
                  }}
                >
                  <span
                    className="tree-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      const n = new Set(collapsedDocs);
                      if (open) n.add(r.doc);
                      else n.delete(r.doc);
                      setCollapsedDocs(n);
                    }}
                  >
                    {open ? "▼" : "▶"}
                  </span>
                  <span className="tree-icon">
                    <Icon name="Document" />
                  </span>
                  <span className="label" style={{ fontWeight: r.doc === activeDoc ? "bold" : undefined }}>
                    {d.label}
                    {d.modified ? " *" : ""}
                  </span>
                </div>
              );
            }
            const n = r.node;
            const o = object(r.doc, n.name);
            if (!o) return null;
            const selected = isSelected(r.doc, n.name);
            const pre = preselection?.doc === r.doc && preselection.object === n.name;
            const isRenaming = renaming?.doc === r.doc && renaming.object === n.name;
            const overlay = o.isError ? "overlay_error" : o.isTouched ? "overlay_recompute" : null;
            return (
              <div
                key={`${r.doc}:${n.key}`}
                className={`tree-row ${selected ? "selected" : ""} ${pre ? "preselected" : ""} ${o.visibility ? "" : "hidden-item"} ${
                  activeBodies[r.doc] === n.name ? "active-body" : ""
                }`}
                style={{ paddingLeft: r.depth * 16 - 10 }}
                data-testid={`tree-${n.name}`}
                data-object={n.name}
                title={o.isError ? o.status : `${o.label} (${o.name}, ${o.type})`}
                onClick={(e) => onRowClick(e, r.doc, n.name)}
                onContextMenu={() => {
                  if (!isSelected(r.doc, n.name)) useSelection.getState().select({ doc: r.doc, object: n.name, sub: "" });
                }}
                onDoubleClick={() => void onDoubleClickObject(r.doc, n.name)}
                onMouseEnter={() => useSelection.getState().setPreselection({ doc: r.doc, object: n.name, sub: "" })}
                onMouseLeave={() => useSelection.getState().setPreselection(null)}
              >
                <span
                  className="tree-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = new Set(expanded);
                    if (next.has(n.key)) next.delete(n.key);
                    else next.add(n.key);
                    setExpanded(next);
                  }}
                >
                  {n.children.length ? (expanded.has(n.key) ? "▼" : "▶") : ""}
                </span>
                <img
                  className="tree-vis"
                  src={`/icons/${o.visibility ? "TreeItemVisible" : "TreeItemInvisible"}.svg`}
                  alt=""
                  title={o.visibility ? "Hide" : "Show"}
                  data-testid={`tree-vis-${n.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void setVisibility(r.doc, [n.name], "toggle");
                  }}
                />
                <span className="tree-icon">
                  <Icon name={objectIcon(o.type, o.typeHierarchy)} />
                  {overlay && <img className="overlay" src={`/icons/${overlay}.svg`} alt="" />}
                </span>
                {isRenaming ? (
                  <RenameEditor doc={r.doc} name={n.name} label={o.label} />
                ) : (
                  <span className="label" data-testid={`tree-label-${n.name}`}>
                    {o.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content" data-testid="tree-context-menu">
          {selectedObjects(selection, activeDoc).length > 0 && (
            <>
              <ContextMenu.Item
                className="menu-item"
                data-testid="menu-Rename"
                onSelect={() => {
                  const s = useSelection.getState().selection[0];
                  if (s) setTimeout(() => useApp.getState().setRenaming({ doc: s.doc, object: s.object }), 0);
                }}
              >
                <span className="icon-slot" />
                <span className="text">Rename</span>
                <span className="shortcut">F2</span>
              </ContextMenu.Item>
              <ContextMenu.Item className="menu-item" onSelect={() => setTimeout(() => run("Std_MarkToRecompute"), 0)}>
                <span className="icon-slot">
                  <Icon name="Std_MarkToRecompute" />
                </span>
                <span className="text">Mark to recompute</span>
              </ContextMenu.Item>
              <ContextMenu.Separator className="menu-separator" />
            </>
          )}
          <MenuEntries entries={TREE_CONTEXT_MENU} ctx={ctx} kit={ContextMenu} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function RenameEditor({ doc, name, label }: { doc: string; name: string; label: string }) {
  const [v, setV] = useState(label);
  const done = (commit: boolean) => {
    useApp.getState().setRenaming(null);
    if (commit && v.trim() && v !== label) void renameObject(doc, name, v.trim());
  };
  return (
    <input
      className="tree-rename"
      data-testid="tree-rename"
      autoFocus
      value={v}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
      onBlur={() => done(true)}
    />
  );
}

/** Double click: FreeCAD's `setEdit` (sketch edit mode, feature parameters). */
export async function onDoubleClickObject(doc: string, name: string): Promise<void> {
  const o = object(doc, name);
  if (!o) return;
  if (o.type === "Sketcher::SketchObject") {
    const { startSketchEdit } = await import("../sketcher/session");
    await startSketchEdit(doc, name);
    return;
  }
  if (o.type === "PartDesign::Body") {
    const cur = useActiveBody.getState().bodies[doc];
    useActiveBody.getState().set(doc, cur === name ? null : name);
    return;
  }
  const { editFeature } = await import("../commands/partdesign");
  await editFeature(doc, name);
}

/** The 3D view widget: hosts the `Viewer`, the NaviCube arrows, the view context menu and the sketch overlay. */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/app";
import { useSelection } from "../state/selection";
import { setViewer, useView3D } from "../state/view3d";
import { Viewer } from "../viewer/Viewer";
import { viewContextMenu } from "../workbenches";
import { onDoubleClickObject } from "./TreeView";
import { MenuEntries, useCommandContext } from "./commandUi";

let shared: Viewer | null = null;

/** The viewer of the page (one, reused by every document tab). */
export function currentViewer(): Viewer | null {
  return shared;
}

export function View3D({ doc }: { doc: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ctx = useCommandContext();
  const naviCube = useView3D((s) => s.naviCube);
  const editing = useApp((s) => s.editing);
  const selection = useSelection((s) => s.selection);

  useEffect(() => {
    const el = host.current!;
    const v = new Viewer(el);
    shared = v;
    setViewer(v);
    v.onContextMenu = (x, y) => setMenu({ x, y });
    v.onDoubleClick = (hit) => {
      if (hit && v.document) void onDoubleClickObject(v.document, hit.object);
    };
    (window as unknown as { __fabcadViewer?: Viewer }).__fabcadViewer = v;
    return () => {
      v.dispose();
      if (shared === v) shared = null;
      setViewer(null);
    };
  }, []);

  useEffect(() => {
    shared?.setDocument(doc);
  }, [doc]);

  const step = (d: Parameters<Viewer["naviStep"]>[0]) => shared?.naviStep(d);

  return (
    <div className="view3d" ref={host} data-testid="view3d">
      {naviCube && (
        <div className="navi-arrows">
          <button style={{ left: 57, top: -2 }} title="Rotate up" onClick={() => step("up")}>
            ▲
          </button>
          <button style={{ left: 57, top: 116 }} title="Rotate down" onClick={() => step("down")}>
            ▼
          </button>
          <button style={{ left: -2, top: 57 }} title="Rotate left" onClick={() => step("left")}>
            ◀
          </button>
          <button style={{ left: 116, top: 57 }} title="Rotate right" onClick={() => step("right")}>
            ▶
          </button>
          <button style={{ left: 104, top: 2 }} title="Rotate clockwise" onClick={() => step("rollRight")}>
            ↻
          </button>
          <button style={{ left: 10, top: 2 }} title="Rotate counterclockwise" onClick={() => step("rollLeft")}>
            ↺
          </button>
        </div>
      )}
      {editing && <div className="edit-banner">Editing {editing.object} — Esc or "Leave sketch" to finish</div>}
      <div id="sketch-overlay" className="sketch-overlay" />
      <DropdownMenu.Root open={!!menu} onOpenChange={(o) => !o && setMenu(null)}>
        <DropdownMenu.Trigger asChild>
          <span style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0, width: 1, height: 1 }} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-content" align="start" sideOffset={0} data-testid="view-context-menu">
            <MenuEntries entries={viewContextMenu(selection.length > 0)} ctx={ctx} kit={DropdownMenu} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

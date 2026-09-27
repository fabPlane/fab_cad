/**
 * The status bar: the preselection text (`Preselected: Unnamed.Box.Face2 (x mm, y mm, z mm)`,
 * `getPreselectionInfo`), the view's dimensions, the navigation style selector and the unit schema.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useSelection } from "../state/selection";
import { useSession } from "../state/session";
import { NAVIGATION_STYLES, useView3D } from "../state/view3d";
import { styleHint } from "../viewer/navigation";
import { Viewer } from "../viewer/Viewer";
import { Icon } from "./widgets";

export function StatusBar() {
  const pre = useSelection((s) => s.preselection);
  const nav = useView3D((s) => s.navigationStyle);
  const dims = useView3D((s) => s.dimensions);
  const status = useSession((s) => s.status);
  const busy = useSession((s) => s.busy);
  const kind = useSession((s) => s.conn?.kind);
  const message = pre ? Viewer.preselectionText(pre) : busy ? "Working…" : "";
  return (
    <div className="statusbar" data-testid="statusbar">
      <span className="message" data-testid="status-message">
        {message}
      </span>
      <span className="muted" title="Backend" data-testid="status-backend">
        {status === "connected" ? (kind === "mock" ? "Mock FreeCAD" : kind === "wasm" ? "FreeCAD (wasm)" : "FreeCAD") : status}
      </span>
      <span className="status-sep" />
      <span data-testid="status-dimensions">{dims ? `Dimension: ${dims}` : ""}</span>
      <span className="status-sep" />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="status-button" title={styleHint(nav)} data-testid="nav-style">
            <Icon name="cursor-rotate" size={14} />
            {nav}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-content" side="top" align="end">
            {NAVIGATION_STYLES.map((s) => (
              <DropdownMenu.Item
                key={s}
                className="menu-item"
                data-testid={`nav-${s}`}
                onSelect={() => useView3D.getState().setNavigationStyle(s)}
                title={styleHint(s)}
              >
                <span className="icon-slot">{s === nav ? "●" : ""}</span>
                <span className="text">{s}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span className="status-sep" />
      <button className="status-button" title="Unit schema: Standard (mm, kg, s, degree)" data-testid="unit-schema">
        Standard (mm, kg, s, °)
      </button>
    </div>
  );
}

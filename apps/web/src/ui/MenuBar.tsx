/** The main window's menu bar: the active workbench's menus (`Workbench::setupMenuBar`). */
import * as Menubar from "@radix-ui/react-menubar";
import { useApp } from "../state/app";
import { effectiveLayout } from "../workbenches";
import { MenuEntries, MenuText, useCommandContext } from "./commandUi";

export function MenuBar() {
  const workbench = useApp((s) => s.workbench);
  const editing = useApp((s) => s.editing);
  const ctx = useCommandContext();
  const { menus } = effectiveLayout(workbench, !!editing);
  return (
    <Menubar.Root className="menubar" data-testid="menubar">
      {menus.map((m) => (
        <Menubar.Menu key={m.title}>
          <Menubar.Trigger className="menubar-trigger" data-testid={`menubar-${m.title.replace(/&/g, "")}`}>
            <MenuText text={m.title} />
          </Menubar.Trigger>
          <Menubar.Portal>
            <Menubar.Content className="menu-content" align="start" sideOffset={1}>
              <MenuEntries entries={m.items} ctx={ctx} kit={Menubar} />
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      ))}
    </Menubar.Root>
  );
}

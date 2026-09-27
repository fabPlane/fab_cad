/** The toolbar area: the workbench's toolbars (`Workbench::setupToolBars`), group drop-downs and the workbench selector. */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { WORKBENCHES, activateWorkbench } from "../commands/std";
import { commandDef, commandInfo, isCommandActive, isCommandChecked, stripMnemonic, type CommandContext } from "../commands/registry";
import { useApp } from "../state/app";
import { effectiveLayout } from "../workbenches";
import { MenuEntries, run, tooltipText, useCommandContext } from "./commandUi";
import { Icon } from "./widgets";

const lastUsed = new Map<string, string>();

function ToolButton({ id, ctx }: { id: string; ctx: CommandContext }) {
  const info = commandInfo(id);
  const active = isCommandActive(id, ctx);
  const checked = isCommandChecked(id, ctx);
  return (
    <button
      className={`tool-button ${checked ? "checked" : ""}`}
      disabled={!active}
      title={tooltipText(id)}
      data-testid={`tb-${id}`}
      onClick={() => run(id)}
    >
      <Icon name={info.pixmap || id} size={24} />
    </button>
  );
}

function GroupButton({ id, ctx }: { id: string; ctx: CommandContext }) {
  const def = commandDef(id)!;
  const items = def.items ?? [];
  const checkedItem = items.find((i) => isCommandChecked(i, ctx));
  const current = checkedItem ?? lastUsed.get(id) ?? items[0]!;
  const active = isCommandActive(current, ctx);
  const [, force] = useState(0);
  return (
    <span style={{ display: "inline-flex" }}>
      <button className="tool-button" disabled={!active} title={tooltipText(current)} data-testid={`tb-${id}`} onClick={() => run(current)}>
        <Icon name={commandInfo(current).pixmap || current} size={24} />
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="tool-button"
            style={{ minWidth: 12, padding: 0 }}
            disabled={!isCommandActive(id, ctx)}
            data-testid={`tb-${id}-menu`}
          >
            <span className="drop">▾</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="menu-content"
            align="start"
            sideOffset={1}
            onClick={() => setTimeout(() => force((n) => n + 1), 0)}
          >
            {items.map((i) => (
              <DropdownMenu.Item
                key={i}
                className="menu-item"
                disabled={!isCommandActive(i, ctx)}
                data-testid={`menu-${i}`}
                onSelect={() => {
                  lastUsed.set(id, i);
                  setTimeout(() => run(i), 0);
                }}
              >
                <span className="icon-slot">
                  <Icon name={commandInfo(i).pixmap || i} />
                </span>
                <span className="text">{stripMnemonic(commandInfo(i).menuText)}</span>
                {commandInfo(i).accel && <span className="shortcut">{commandInfo(i).accel}</span>}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}

/** FreeCAD 1.x's workbench selector: a combo box with the workbench icons. */
export function WorkbenchSelector() {
  const current = useApp((s) => s.workbench);
  const wb = WORKBENCHES.find((w) => w.id === current) ?? WORKBENCHES[0]!;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="wb-selector" data-testid="workbench-selector" title="Switch between workbenches">
          <Icon name={wb.icon} />
          <span>{wb.name}</span>
          <span className="caret">▼</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" align="start" sideOffset={1}>
          {WORKBENCHES.map((w) => (
            <DropdownMenu.Item key={w.id} className="menu-item" data-testid={`wb-${w.id}`} onSelect={() => activateWorkbench(w.id)}>
              <span className="icon-slot">
                <Icon name={w.icon} />
              </span>
              <span className="text">{w.name}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Toolbars() {
  const workbench = useApp((s) => s.workbench);
  const editing = useApp((s) => s.editing);
  const ctx = useCommandContext();
  const { toolbars } = effectiveLayout(workbench, !!editing);
  return (
    <div className="toolbar-area" data-testid="toolbars">
      {toolbars.map((tb) => (
        <div className="toolbar" key={tb.name} data-testid={`toolbar-${tb.name}`} title="">
          <span className="toolbar-handle" title={tb.name} />
          {tb.items.map((id, i) => {
            if (id === "Separator") return <span key={`s${i}`} className="tool-separator" />;
            if (id === "Std_Workbench") return <WorkbenchSelector key={id} />;
            if (commandDef(id)?.items) return <GroupButton key={id} id={id} ctx={ctx} />;
            return <ToolButton key={id} id={id} ctx={ctx} />;
          })}
        </div>
      ))}
    </div>
  );
}

export { MenuEntries };

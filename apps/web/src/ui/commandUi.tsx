/**
 * Shared rendering of commands in menus (radix menus) and the hook that re-evaluates command
 * states when anything they depend on changes.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Menubar from "@radix-ui/react-menubar";
import { useMemo, type ReactNode } from "react";
import { makeContext } from "../commands/context";
import {
  commandDef,
  commandInfo,
  isCommandActive,
  isCommandChecked,
  runCommand,
  stripMnemonic,
  type CommandContext,
} from "../commands/registry";
import { useApp } from "../state/app";
import { useSelection } from "../state/selection";
import { useSession } from "../state/session";
import { useView3D } from "../state/view3d";
import { useViewProps } from "../state/viewprops";
import type { MenuEntry } from "../workbenches";
import { Icon } from "./widgets";

/** A command context that updates with the stores commands read. */
export function useCommandContext(): CommandContext {
  const version = useSession((s) => s.version);
  const undo = useSession((s) => s.undo);
  const status = useSession((s) => s.status);
  const selection = useSelection((s) => s.selection);
  const app = useApp();
  const view = useView3D();
  const vp = useViewProps((s) => s.overrides);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => makeContext(), [version, undo, status, selection, app, view, vp]);
}

export function run(id: string): void {
  void runCommand(id, makeContext());
}

/** `&File` → `File` with the mnemonic letter underlined. */
export function MenuText({ text }: { text: string }) {
  const i = text.search(/&(?!&)/);
  if (i < 0) return <>{text.replace(/&&/g, "&")}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="mnemonic">{text[i + 1]}</span>
      {text.slice(i + 2)}
    </>
  );
}

export function tooltipText(id: string): string {
  const info = commandInfo(id);
  const text = stripMnemonic(info.menuText);
  const tip = info.toolTip && info.toolTip !== text ? `\n${info.toolTip}` : "";
  const accel = info.accel ? ` (${info.accel})` : "";
  const missing = info.implemented ? "" : "\nNot available in the web UI yet.";
  return `${text}${accel}${tip}${missing}`;
}

type Kit = typeof Menubar | typeof DropdownMenu | typeof ContextMenu;

/** Menu entries for any radix menu kit (menubar, dropdown, context menu). */
export function MenuEntries({ entries, ctx, kit }: { entries: MenuEntry[]; ctx: CommandContext; kit: Kit }): ReactNode {
  const K = kit as typeof Menubar;
  const out: ReactNode[] = [];
  let lastWasSep = true;
  entries.forEach((e, i) => {
    if (e === "Separator") {
      if (!lastWasSep) out.push(<K.Separator key={`sep${i}`} className="menu-separator" />);
      lastWasSep = true;
      return;
    }
    lastWasSep = false;
    if (typeof e !== "string") {
      out.push(<SubMenu key={`sub${i}`} title={e.menu} entries={e.items} ctx={ctx} kit={kit} />);
      return;
    }
    const def = commandDef(e);
    if (def?.items) {
      const info = commandInfo(e);
      out.push(<SubMenu key={e} title={info.menuText} icon={info.pixmap} entries={def.items} ctx={ctx} kit={kit} testId={`menu-${e}`} />);
      return;
    }
    out.push(<CommandMenuItem key={e} id={e} ctx={ctx} kit={kit} />);
  });
  while (out.length && lastWasSep && entries.length) {
    // trailing separator
    const last = out[out.length - 1] as { key?: string } | undefined;
    if (last?.key?.startsWith("sep")) out.pop();
    else break;
  }
  return out;
}

function SubMenu({
  title,
  icon,
  entries,
  ctx,
  kit,
  testId,
}: {
  title: string;
  icon?: string;
  entries: MenuEntry[];
  ctx: CommandContext;
  kit: Kit;
  testId?: string;
}) {
  const K = kit as typeof Menubar;
  return (
    <K.Sub>
      <K.SubTrigger className="menu-item" data-testid={testId ?? `submenu-${stripMnemonic(title)}`}>
        <span className="icon-slot">{icon ? <Icon name={icon} /> : null}</span>
        <span className="text">
          <MenuText text={title} />
        </span>
        <span className="submenu-arrow">▶</span>
      </K.SubTrigger>
      <K.Portal>
        <K.SubContent className="menu-content" sideOffset={2} alignOffset={-4}>
          <MenuEntries entries={entries} ctx={ctx} kit={kit} />
        </K.SubContent>
      </K.Portal>
    </K.Sub>
  );
}

function CommandMenuItem({ id, ctx, kit }: { id: string; ctx: CommandContext; kit: Kit }) {
  const K = kit as typeof Menubar;
  const info = commandInfo(id);
  const active = isCommandActive(id, ctx);
  const checked = isCommandChecked(id, ctx);
  let text = info.menuText;
  if (id === "Std_Undo" && ctx.undo?.undo[0]) text = `&Undo ${ctx.undo.undo[0]}`;
  if (id === "Std_Redo" && ctx.undo?.redo[0]) text = `&Redo ${ctx.undo.redo[0]}`;
  return (
    <K.Item
      className="menu-item"
      disabled={!active}
      data-testid={`menu-${id}`}
      title={info.toolTip}
      onSelect={() => {
        setTimeout(() => run(id), 0);
      }}
    >
      <span className="icon-slot">
        {checked !== undefined && !info.pixmap ? checked ? "✔" : "" : info.pixmap ? <Icon name={info.pixmap} /> : null}
      </span>
      <span className="text">
        <MenuText text={text} />
        {checked && info.pixmap ? " ✔" : ""}
      </span>
      {info.accel && <span className="shortcut">{info.accel}</span>}
    </K.Item>
  );
}

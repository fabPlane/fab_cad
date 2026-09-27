/**
 * The command registry: FreeCAD's `Gui::CommandManager` for the web UI. Every menu item, toolbar
 * button and shortcut is a FreeCAD command name (`Std_New`, `Part_Box`, ...). Texts, tooltips,
 * pixmaps and accelerators come from FreeCAD's own sources (`src/generated/freecad-commands.json`,
 * written by `tooling/icons/sync.ts`); the web UI adds `isActive` / `run` per command. A FreeCAD
 * command without a web implementation is still listed, disabled.
 */
import type { ObjectInfo, UndoStack } from "@fab-cad/client";
import catalog from "../generated/freecad-commands.json";
import { PARTIAL } from "./partial";
import type { EditState, WorkbenchId } from "../state/app";
import type { SelItem } from "../state/selection";

export interface CommandMeta {
  name: string;
  menuText: string;
  toolTip: string;
  pixmap: string;
  accel: string;
  group: string;
}

const META = catalog as unknown as Record<string, CommandMeta & { source?: string }>;

/** What `isActive` / `isChecked` / `run` see: a snapshot of the application state. */
export interface CommandContext {
  connected: boolean;
  /** The active document (the MDI window in front). */
  doc: string | null;
  selection: SelItem[];
  editing: EditState | null;
  taskOpen: boolean;
  workbench: WorkbenchId;
  undo: UndoStack | null;
  objects(doc?: string | null): ObjectInfo[];
  object(name: string, doc?: string | null): ObjectInfo | undefined;
}

export interface CommandDef {
  id: string;
  menuText?: string;
  toolTip?: string;
  pixmap?: string;
  accel?: string;
  isActive?: (ctx: CommandContext) => boolean;
  isChecked?: (ctx: CommandContext) => boolean;
  run?: (ctx: CommandContext) => unknown;
  /** What differs from FreeCAD's command, for the coverage table (a "partial" implementation). */
  partial?: string;
  /**
   * A group command (`Gui::GroupCommand`): a toolbar drop-down / menu of these commands. The
   * button shows the last one used (or the first).
   */
  items?: string[];
}

export interface CommandInfo extends CommandMeta {
  def: CommandDef | undefined;
  implemented: boolean;
  /** Set when the implementation is partial (see `partial.ts`). */
  partial?: string;
}

const defs = new Map<string, CommandDef>();
const subscribers = new Set<() => void>();

export function registerCommands(list: CommandDef[]): void {
  for (const c of list) defs.set(c.id, c);
  for (const s of subscribers) s();
}

export function onCommandsChanged(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function commandDef(id: string): CommandDef | undefined {
  return defs.get(id);
}

export function allCommandIds(): string[] {
  return [...new Set([...defs.keys(), ...Object.keys(META)])].sort();
}

/** Strip the `&` mnemonic marker (`&New Document` → `New Document`). */
export function stripMnemonic(s: string): string {
  return s.replace(/&(?!&)/g, "").replace(/&&/g, "&");
}

export function commandInfo(id: string): CommandInfo {
  const def = defs.get(id);
  const meta = META[id];
  return {
    name: id,
    menuText: def?.menuText ?? meta?.menuText ?? id,
    toolTip: def?.toolTip ?? meta?.toolTip ?? "",
    pixmap: def?.pixmap ?? meta?.pixmap ?? "",
    accel: def?.accel ?? meta?.accel ?? "",
    group: meta?.group ?? "",
    def,
    implemented: !!def && (!!def.run || !!def.items),
    ...(def?.partial || PARTIAL[id] ? { partial: def?.partial ?? PARTIAL[id] } : {}),
  };
}

export function isCommandActive(id: string, ctx: CommandContext): boolean {
  const def = defs.get(id);
  if (!def) return false;
  if (def.items) return def.items.some((i) => isCommandActive(i, ctx));
  if (!def.run) return false;
  try {
    return def.isActive ? def.isActive(ctx) : true;
  } catch {
    return false;
  }
}

export function isCommandChecked(id: string, ctx: CommandContext): boolean | undefined {
  const def = defs.get(id);
  if (!def?.isChecked) return undefined;
  try {
    return def.isChecked(ctx);
  } catch {
    return false;
  }
}

export type CommandRunner = (id: string, ctx: CommandContext) => Promise<void>;

let errorSink: (id: string, e: unknown) => void = () => {};

export function setCommandErrorSink(sink: (id: string, e: unknown) => void): void {
  errorSink = sink;
}

/** Run a command if it is active; errors go to the Report view. */
export async function runCommand(id: string, ctx: CommandContext): Promise<boolean> {
  const def = defs.get(id);
  if (!def?.run || !isCommandActive(id, ctx)) return false;
  try {
    await def.run(ctx);
  } catch (e) {
    errorSink(id, e);
  }
  return true;
}

// ------------------------------------------------------------------------------ accelerators

/** `Ctrl+Shift+S`, `V, F` (a chord of two key sequences), `Del`, `Space`, `0`. */
export function parseAccel(accel: string): string[][] {
  if (!accel) return [];
  return accel.split(/,\s*/).map((seq) =>
    seq
      .split("+")
      .filter((k, i, a) => k !== "" || (i > 0 && a[i - 1] === ""))
      .map((k) => (k === "" ? "+" : k)),
  );
}

/** Normalise a keyboard event to FreeCAD's notation (`Ctrl+Shift+S`, `Del`, `F2`, `V`). */
export function eventToKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code">): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  let k = e.key;
  if (k === " " || k === "Spacebar") k = "Space";
  else if (k === "Delete") k = "Del";
  else if (k === "Escape") k = "Esc";
  else if (k.length === 1) k = k.toUpperCase();
  // Shift is part of the key for symbols ("+", ")") but a modifier for letters and named keys.
  if (e.shiftKey && (k.length > 1 || /[A-Z0-9]/.test(k))) mods.push("Shift");
  if (/^Digit\d$/.test(e.code ?? "") && e.shiftKey) k = e.code.slice(5);
  return [...mods, k].join("+");
}

/** One accelerator step as a normalized key string (`["Ctrl","Shift","S"]` → `Ctrl+Shift+S`). */
export function stepKey(step: string[]): string {
  const mods = step.slice(0, -1);
  const key = step[step.length - 1] ?? "";
  const order = ["Ctrl", "Alt", "Shift"];
  const sorted = order.filter((m) => mods.includes(m));
  const k = key.length === 1 ? key.toUpperCase() : key === "Delete" ? "Del" : key;
  return [...sorted, k].join("+");
}

/** The shortcut text as FreeCAD's menus show it. */
export function accelText(accel: string): string {
  return accel;
}

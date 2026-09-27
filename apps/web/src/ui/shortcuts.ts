/**
 * Keyboard shortcuts: every command's accelerator (FreeCAD's, from its sources), including
 * two-step chords like `V, F` (fit all) and `V, 1` (draw style); F2 renames the selected object,
 * Esc cancels a Sketcher tool / leaves the task dialog. Keys typed into inputs are left alone.
 */
import { makeContext } from "../commands/context";
import { allCommandIds, commandInfo, eventToKey, parseAccel, runCommand, stepKey } from "../commands/registry";
import { useApp } from "../state/app";
import { useSelection } from "../state/selection";

/** Map a key sequence (`"V"`, `"V F"`) to command ids. */
export function buildAccelMap(ids: string[] = allCommandIds()): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const id of ids) {
    const accel = commandInfo(id).accel;
    if (!accel) continue;
    const steps = parseAccel(accel).map(stepKey);
    const k = steps.join(" ");
    map.set(k, [...(map.get(k) ?? []), id]);
  }
  return map;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export type KeyHandler = (e: KeyboardEvent) => boolean;
const extraHandlers: KeyHandler[] = [];

/** Let edit modes (the Sketcher) see keys first. */
export function addKeyHandler(h: KeyHandler): () => void {
  extraHandlers.unshift(h);
  return () => {
    const i = extraHandlers.indexOf(h);
    if (i >= 0) extraHandlers.splice(i, 1);
  };
}

export function installShortcuts(): () => void {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.defaultPrevented) return;
    if (document.querySelector(".dialog-backdrop")) return;
    for (const h of extraHandlers) if (h(e)) return e.preventDefault();
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const key = eventToKey(e);
    if (key === "F2") {
      const s = useSelection.getState().selection[0];
      if (s) {
        e.preventDefault();
        useApp.getState().setRenaming({ doc: s.doc, object: s.object });
      }
      return;
    }
    const map = buildAccelMap();
    const seq = pending ? `${pending} ${key}` : key;
    const ids = map.get(seq);
    const prefix = [...map.keys()].some((k) => k.startsWith(`${seq} `));
    if (timer) clearTimeout(timer);
    if (ids && !prefix) {
      pending = null;
      e.preventDefault();
      void runFirst(ids);
      return;
    }
    if (prefix) {
      pending = seq;
      e.preventDefault();
      timer = setTimeout(() => {
        // the chord did not continue: run the single-key command if there is one
        const single = map.get(seq);
        pending = null;
        if (single) void runFirst(single);
      }, 900);
      return;
    }
    pending = null;
    if (ids) {
      e.preventDefault();
      void runFirst(ids);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

async function runFirst(ids: string[]): Promise<void> {
  const ctx = makeContext();
  for (const id of ids) if (await runCommand(id, ctx)) return;
}

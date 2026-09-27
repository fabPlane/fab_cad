/**
 * Modal dialogs (Qt's QInputDialog / QMessageBox): a stack rendered by `ui/Dialogs.tsx`, opened
 * with promises so commands can `await prompt(...)`.
 */
import type { ReactNode } from "react";
import { create } from "zustand";

export interface DialogSpec {
  id: number;
  title: string;
  icon?: string;
  /** Plain message dialogs. */
  message?: string;
  kind: "prompt" | "message" | "confirm" | "custom";
  label?: string;
  value?: string;
  /** Validation for prompt input: an error text or null. */
  validate?: (v: string) => string | null;
  buttons?: string[];
  render?: (close: (result: unknown) => void) => ReactNode;
  resolve: (result: unknown) => void;
}

interface DialogState {
  stack: DialogSpec[];
  open: (d: Omit<DialogSpec, "id" | "resolve">) => Promise<unknown>;
  close: (id: number, result: unknown) => void;
}

let nextId = 1;

export const useDialogs = create<DialogState>((set, get) => ({
  stack: [],
  open: (d) =>
    new Promise((resolve) => {
      set({ stack: [...get().stack, { ...d, id: nextId++, resolve }] });
    }),
  close: (id, result) => {
    const d = get().stack.find((x) => x.id === id);
    set({ stack: get().stack.filter((x) => x.id !== id) });
    d?.resolve(result);
  },
}));

export async function prompt(title: string, label: string, value = "", validate?: (v: string) => string | null): Promise<string | null> {
  const r = await useDialogs.getState().open({ kind: "prompt", title, label, value, ...(validate ? { validate } : {}) });
  return typeof r === "string" ? r : null;
}

export async function message(title: string, text: string, icon = "info"): Promise<void> {
  await useDialogs.getState().open({ kind: "message", title, message: text, icon });
}

export async function confirm(title: string, text: string, buttons = ["Yes", "No"]): Promise<string | null> {
  const r = await useDialogs.getState().open({ kind: "confirm", title, message: text, buttons, icon: "Warning" });
  return typeof r === "string" ? r : null;
}

export function custom<T>(title: string, render: (close: (result: T | null) => void) => ReactNode, icon?: string): Promise<T | null> {
  return useDialogs.getState().open({
    kind: "custom",
    title,
    render: render as (c: (r: unknown) => void) => ReactNode,
    ...(icon ? { icon } : {}),
  }) as Promise<T | null>;
}

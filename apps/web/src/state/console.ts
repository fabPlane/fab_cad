/**
 * The Report view's messages and the Python console's lines. GUI actions echo the Python FreeCAD
 * would run into the console (`echo`), the way FreeCAD's `Gui::Command::runCommand` does.
 */
import { create } from "zustand";

export type ReportKind = "message" | "warning" | "error" | "log";

export interface ReportEntry {
  id: number;
  kind: ReportKind;
  text: string;
  time: number;
}

export type ConsoleKind = "input" | "echo" | "output" | "stderr" | "error" | "result" | "info";

export interface ConsoleLine {
  id: number;
  kind: ConsoleKind;
  text: string;
}

interface ConsoleState {
  report: ReportEntry[];
  lines: ConsoleLine[];
  history: string[];
  report_: (kind: ReportKind, text: string) => void;
  addLines: (lines: { kind: ConsoleKind; text: string }[]) => void;
  pushHistory: (cmd: string) => void;
  clearReport: () => void;
  clearConsole: () => void;
}

let nextId = 1;
const MAX = 2000;

export const useConsole = create<ConsoleState>((set) => ({
  report: [],
  lines: [
    { id: nextId++, kind: "info", text: "Python console of the FreeCAD API server: code runs with RunPython in FreeCAD's __main__." },
  ],
  history: [],
  report_: (kind, text) => set((s) => ({ report: [...s.report, { id: nextId++, kind, text, time: Date.now() }].slice(-MAX) })),
  addLines: (lines) => set((s) => ({ lines: [...s.lines, ...lines.map((l) => ({ id: nextId++, ...l }))].slice(-MAX) })),
  pushHistory: (cmd) => set((s) => (s.history[s.history.length - 1] === cmd ? s : { history: [...s.history, cmd].slice(-500) })),
  clearReport: () => set({ report: [] }),
  clearConsole: () => set({ lines: [] }),
}));

/** Echo Python lines the way FreeCAD's console shows GUI commands. */
export function echo(code: string | string[]): void {
  const list = (Array.isArray(code) ? code : [code]).flatMap((c) => c.split("\n")).filter((l) => l.length > 0);
  if (list.length) useConsole.getState().addLines(list.map((text) => ({ kind: "echo" as const, text })));
}

export function report(kind: ReportKind, text: string): void {
  useConsole.getState().report_(kind, text.endsWith("\n") ? text.slice(0, -1) : text);
}

export const log = {
  message: (t: string) => report("message", t),
  warning: (t: string) => report("warning", t),
  error: (t: string) => report("error", t),
  log: (t: string) => report("log", t),
};

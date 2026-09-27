/**
 * The bottom docks: the Report view (`Gui::DockWnd::ReportView`: messages, warnings, errors in
 * FreeCAD Light's colours) and the Python console (`Gui::PythonConsole`: `>>>` prompt, history,
 * multi-line blocks with `...`, output, errors and GUI echo, syntax colouring). Code runs with
 * `RunPython(code, "auto")` on the server.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorText, settle } from "../commands/actions";
import { useApp } from "../state/app";
import { useConsole } from "../state/console";
import { conn } from "../state/session";

export function ReportView() {
  const report = useConsole((s) => s.report);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [report]);
  return (
    <div className="output report" ref={ref} data-testid="report-view">
      {report.map((r) => (
        <div key={r.id} className={`line ${r.kind}`}>
          {r.text}
        </div>
      ))}
    </div>
  );
}

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);
const BUILTINS = new Set([
  "App",
  "FreeCAD",
  "Gui",
  "FreeCADGui",
  "Part",
  "Sketcher",
  "PartDesign",
  "print",
  "len",
  "range",
  "dir",
  "help",
  "str",
  "int",
  "float",
  "list",
  "dict",
]);

/** Colour Python like FreeCAD's `PythonSyntaxHighlighter`. */
export function highlightPython(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)|([-+*/%=<>!&|^~.,:;()[\]{}]+)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    const [t] = m;
    if (m[1])
      out.push(
        <span key={i++} className="py-comment">
          {t}
        </span>,
      );
    else if (m[2])
      out.push(
        <span key={i++} className="py-string">
          {t}
        </span>,
      );
    else if (m[3])
      out.push(
        <span key={i++} className="py-number">
          {t}
        </span>,
      );
    else if (m[4])
      out.push(
        KEYWORDS.has(t) ? (
          <span key={i++} className="py-keyword">
            {t}
          </span>
        ) : BUILTINS.has(t) ? (
          <span key={i++} className="py-builtin">
            {t}
          </span>
        ) : (
          t
        ),
      );
    else if (m[5])
      out.push(
        <span key={i++} className="py-operator">
          {t}
        </span>,
      );
    else out.push(t);
    if (t.length === 0) break;
  }
  return out;
}

/** Does the console need more lines before running (an open block, bracket or trailing colon)? */
export function needsMoreInput(lines: string[]): boolean {
  const code = lines.join("\n");
  if (!code.trim()) return false;
  let depth = 0;
  let quote: string | null = null;
  for (let k = 0; k < code.length; k++) {
    const ch = code[k]!;
    if (quote) {
      if (ch === "\\") k++;
      else if (code.startsWith(quote, k)) {
        k += quote.length - 1;
        quote = null;
      }
      continue;
    }
    if (ch === "#") {
      while (k < code.length && code[k] !== "\n") k++;
      continue;
    }
    if (code.startsWith('"""', k) || code.startsWith("'''", k)) {
      quote = code.slice(k, k + 3);
      k += 2;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  if (quote && quote.length === 3) return true;
  if (depth > 0) return true;
  const last = lines[lines.length - 1]!;
  if (/\\$/.test(last)) return true;
  // A block (`for ...:`, `def ...:`) runs once an empty line ends it, like the interactive interpreter.
  const block = lines.some((l) => /:\s*(#.*)?$/.test(l.trimEnd()));
  return block && last.trim() !== "";
}

export async function runConsoleCode(code: string): Promise<void> {
  const c = useConsole.getState();
  const connection = conn();
  if (!connection) {
    c.addLines([{ kind: "error", text: "Not connected to FreeCAD." }]);
    return;
  }
  try {
    const r = await connection.client.runPython(code, "auto");
    const lines: { kind: "output" | "stderr" | "error" | "result"; text: string }[] = [];
    if (r.stdout)
      lines.push(
        ...r.stdout
          .replace(/\n$/, "")
          .split("\n")
          .map((t) => ({ kind: "output" as const, text: t })),
      );
    if (r.stderr)
      lines.push(
        ...r.stderr
          .replace(/\n$/, "")
          .split("\n")
          .map((t) => ({ kind: "stderr" as const, text: t })),
      );
    if (r.exception)
      lines.push(
        ...r.exception
          .replace(/\n$/, "")
          .split("\n")
          .map((t) => ({ kind: "error" as const, text: t })),
      );
    else if (r.repr !== undefined && r.repr !== "None") lines.push({ kind: "result", text: r.repr });
    c.addLines(lines);
    await settle();
    // Python may have changed objects without events for the tree (transient state): refresh the view.
    connection.store.flush().catch(() => undefined);
  } catch (e) {
    c.addLines([{ kind: "error", text: errorText(e) }]);
  }
}

export function PythonConsole() {
  const lines = useConsole((s) => s.lines);
  const history = useConsole((s) => s.history);
  const [buffer, setBuffer] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [histPos, setHistPos] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, buffer]);

  const submit = async () => {
    const all = [...buffer, input];
    const c = useConsole.getState();
    c.addLines([{ kind: "input", text: `${buffer.length ? "... " : ">>> "}${input}` }]);
    setInput("");
    setHistPos(null);
    if (needsMoreInput(all)) {
      setBuffer(all);
      return;
    }
    setBuffer([]);
    const code = all.join("\n").replace(/\n+$/, "");
    if (!code.trim()) return;
    c.pushHistory(code);
    setRunning(true);
    await runConsoleCode(code);
    setRunning(false);
    setTimeout(() => ta.current?.focus(), 0);
  };

  return (
    <div className="output console" ref={ref} data-testid="python-console" onClick={() => ta.current?.focus()}>
      {lines.map((l) => (
        <div key={l.id} className={`line ${l.kind}`}>
          {l.kind === "echo" ? (
            <>
              <span className="prompt">{">>> "}</span>
              {highlightPython(l.text)}
            </>
          ) : l.kind === "input" ? (
            <>
              <span className="prompt">{l.text.slice(0, 4)}</span>
              {highlightPython(l.text.slice(4))}
            </>
          ) : (
            l.text
          )}
        </div>
      ))}
      <div className="input-line">
        <span className="prompt">{buffer.length ? "... " : ">>> "}</span>
        <textarea
          ref={ta}
          rows={1}
          spellCheck={false}
          value={input}
          disabled={running}
          data-testid="python-input"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const p = histPos === null ? history.length - 1 : Math.max(0, histPos - 1);
              setHistPos(p);
              setInput(history[p]!);
            } else if (e.key === "ArrowDown" && histPos !== null) {
              e.preventDefault();
              const p = histPos + 1;
              if (p >= history.length) {
                setHistPos(null);
                setInput("");
              } else {
                setHistPos(p);
                setInput(history[p]!);
              }
            } else if (e.key === "Tab") {
              e.preventDefault();
              setInput(`${input}    `);
            }
          }}
        />
      </div>
    </div>
  );
}

/** Report view and Python console, tabified at the bottom like FreeCAD's docks. */
export function BottomDock({ height }: { height: number }) {
  const panels = useApp((s) => s.panels);
  const [tab, setTab] = useState<"report" | "python">("python");
  const both = panels.report && panels.python;
  const shown = both ? tab : panels.report ? "report" : "python";
  const title = shown === "report" ? "Report view" : "Python console";
  return (
    <div className="dock" style={{ height }} data-testid="bottom-dock">
      <div className="dock-title">
        <span className="title">{title}</span>
        <button title="Close" onClick={() => useApp.getState().togglePanel(shown)}>
          ✕
        </button>
      </div>
      <div className="tab-page" style={{ border: "1px solid var(--border)" }}>
        {shown === "report" ? <ReportView /> : <PythonConsole />}
      </div>
      {both && (
        <div className="tabs bottom">
          <div className={`tab ${shown === "report" ? "active" : ""}`} data-testid="tab-report" onClick={() => setTab("report")}>
            Report view
          </div>
          <div className={`tab ${shown === "python" ? "active" : ""}`} data-testid="tab-python" onClick={() => setTab("python")}>
            Python console
          </div>
        </div>
      )}
    </div>
  );
}

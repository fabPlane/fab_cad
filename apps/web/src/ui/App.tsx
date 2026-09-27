/**
 * The main window (`Gui::MainWindow`): menu bar, toolbars, the Combo View dock on the left, the MDI
 * area (3D views and the Start page, tabs at the bottom), the Report view / Python console dock
 * below, and the status bar. Files dropped anywhere are opened (or imported into the active
 * document with Shift held).
 */
import { useEffect, useRef, useState } from "react";
import { activateDocument, closeDocument, errorText, importInto, openFile } from "../commands/actions";
import { fileBytes } from "../lib/files";
import { useApp } from "../state/app";
import { confirm } from "../state/dialogs";
import { log } from "../state/console";
import { docInfo, documents, useModel, useSession } from "../state/session";
import { installShortcuts } from "./shortcuts";
import { ComboView } from "./ComboView";
import { Dialogs } from "./Dialogs";
import { MenuBar } from "./MenuBar";
import { BottomDock } from "./Output";
import { StartPage } from "./StartPage";
import { StatusBar } from "./StatusBar";
import { Toolbars } from "./Toolbars";
import { View3D } from "./View3D";
import { Icon } from "./widgets";

function useDrag(initial: number, axis: "x" | "y", invert = false): [number, (e: React.PointerEvent) => void] {
  const [size, setSize] = useState(initial);
  const start = (e: React.PointerEvent) => {
    const s0 = size;
    const p0 = axis === "x" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - p0;
      setSize(Math.max(120, Math.min(window.innerWidth * 0.7, s0 + (invert ? -d : d))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  return [size, start];
}

function MdiArea() {
  useModel();
  const activeDoc = useApp((s) => s.activeDoc);
  const openTabs = useApp((s) => s.openTabs);
  const startTab = useApp((s) => s.startTab);
  const docs = documents();
  const showStart = startTab && (activeDoc === null || !docs.some((d) => d.name === activeDoc));
  const current = showStart ? null : (activeDoc ?? openTabs[0] ?? null);
  const tabs = openTabs.filter((t) => docs.some((d) => d.name === t));
  return (
    <div className="mdi-area">
      <div className="mdi-view">{current ? <View3D doc={current} /> : <StartPage />}</div>
      {(tabs.length > 0 || startTab) && (
        <div className="tabs bottom mdi-tabs" data-testid="mdi-tabs">
          {startTab && (
            <div className={`tab ${showStart ? "active" : ""}`} data-testid="mdi-tab-start" onClick={() => useApp.getState().showStart()}>
              <Icon name="freecad" size={14} />
              Start
              <button
                className="close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  useApp.getState().closeStart();
                }}
              >
                ✕
              </button>
            </div>
          )}
          {tabs.map((t) => {
            const d = docInfo(t);
            return (
              <div
                key={t}
                className={`tab ${!showStart && current === t ? "active" : ""}`}
                data-testid={`mdi-tab-${t}`}
                onClick={() => void activateDocument(t)}
              >
                <Icon name="Document" size={14} />
                {d?.label ?? t} : 1{d?.modified ? "*" : ""}
                <button
                  className="close"
                  title="Close"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (d?.modified) {
                      const r = await confirm("Unsaved document", `The document '${d.label}' has been modified. Close it without saving?`, [
                        "Discard",
                        "Cancel",
                      ]);
                      if (r !== "Discard") return;
                    }
                    await closeDocument(t).catch((x) => log.error(errorText(x)));
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function App() {
  const panels = useApp((s) => s.panels);
  const status = useSession((s) => s.status);
  const error = useSession((s) => s.error);
  const [leftWidth, dragLeft] = useDrag(330, "x");
  const [bottomHeight, dragBottom] = useDrag(190, "y", true);
  const [dragOver, setDragOver] = useState(false);
  const depth = useRef(0);

  useEffect(() => installShortcuts(), []);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    for (const f of files) {
      try {
        const doc = useApp.getState().activeDoc;
        if (e.shiftKey && doc && !f.name.toLowerCase().endsWith(".fcstd")) await importInto(doc, f.name, await fileBytes(f));
        else await openFile(f);
      } catch (x) {
        log.error(`${f.name}: ${errorText(x)}`);
      }
    }
  };

  return (
    <div
      className="main-window"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        depth.current++;
        setDragOver(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragOver(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDrop(e)}
    >
      <MenuBar />
      <Toolbars />
      {(status === "disconnected" || (status === "error" && useSession.getState().choice)) && (
        <div className={`banner ${status === "error" ? "error" : ""}`} data-testid="connection-banner">
          <span>{error ?? "Disconnected from FreeCAD."}</span>
          <button className="btn" onClick={() => location.reload()}>
            Reconnect
          </button>
        </div>
      )}
      <div className="central">
        {panels.comboView && (
          <>
            <div style={{ width: leftWidth, display: "flex", flex: "none" }}>
              <ComboView onClose={() => useApp.getState().togglePanel("comboView")} />
            </div>
            <div className="splitter-v" onPointerDown={dragLeft} />
          </>
        )}
        <div className="center-column">
          <MdiArea />
          {(panels.report || panels.python) && (
            <>
              <div className="splitter-h" onPointerDown={dragBottom} />
              <BottomDock height={bottomHeight} />
            </>
          )}
        </div>
      </div>
      {panels.statusBar && <StatusBar />}
      {dragOver && <div className="drop-hint">Drop files to open them (hold Shift to import into the active document)</div>}
      <Dialogs />
    </div>
  );
}

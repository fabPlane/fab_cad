/**
 * The Combo View dock (`Gui::DockWnd::ComboView`): a Model tab (tree above the property view,
 * with a splitter) and a Tasks tab (`Gui::TaskView::TaskView`) that shows the open task dialog
 * with its OK / Cancel buttons, or FreeCAD's idle task boxes.
 */
import { useRef, useState } from "react";
import { errorText } from "../commands/actions";
import { useApp } from "../state/app";
import { log } from "../state/console";
import { SketchEditPanel } from "../tasks/sketchTasks";
import { PropertyView } from "./PropertyView";
import { TreeView } from "./TreeView";
import { Button, GroupBox } from "./widgets";

export function ComboView({ onClose }: { onClose: () => void }) {
  const tab = useApp((s) => s.comboTab);
  const [split, setSplit] = useState(0.5);
  const body = useRef<HTMLDivElement>(null);
  const startDrag = (e: React.PointerEvent) => {
    const el = body.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(Math.min(0.9, Math.max(0.1, (ev.clientY - r.top) / r.height)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  return (
    <div className="dock" style={{ flex: 1 }} data-testid="combo-view">
      <div className="dock-title">
        <span className="title">Combo View</span>
        <button title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="tabs top">
        <div
          className={`tab ${tab === "model" ? "active" : ""}`}
          data-testid="combo-tab-model"
          onClick={() => useApp.getState().setComboTab("model")}
        >
          Model
        </div>
        <div
          className={`tab ${tab === "tasks" ? "active" : ""}`}
          data-testid="combo-tab-tasks"
          onClick={() => useApp.getState().setComboTab("tasks")}
        >
          Tasks
        </div>
      </div>
      <div className="tab-page" ref={body}>
        {tab === "model" ? (
          <>
            <div style={{ flex: `${split} 1 0`, display: "flex", minHeight: 0 }}>
              <TreeView />
            </div>
            <div className="splitter-h" onPointerDown={startDrag} />
            <div style={{ flex: `${1 - split} 1 0`, display: "flex", minHeight: 0 }}>
              <PropertyView />
            </div>
          </>
        ) : (
          <TaskView />
        )}
      </div>
    </div>
  );
}

export function TaskView() {
  const task = useApp((s) => s.task);
  const editing = useApp((s) => s.editing);
  const [busy, setBusy] = useState(false);
  if (!task && editing) {
    return (
      <div className="task-view" data-testid="task-view">
        <SketchEditPanel />
      </div>
    );
  }
  if (!task) {
    return (
      <div className="task-view" data-testid="task-view">
        <GroupBox title="Nothing to do" icon="edit-edit">
          <div className="muted">Select a command from a toolbar or menu; its dialog appears here.</div>
        </GroupBox>
      </div>
    );
  }
  const buttons = task.buttons ?? ["ok", "cancel"];
  const finish = async (ok: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (ok) {
        const r = await task.accept();
        if (r === false) return;
      } else await task.reject();
      if (useApp.getState().task === task) useApp.getState().closeTask();
    } catch (e) {
      log.error(`${task.title}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-view" data-testid="task-view">
      <div className="task-buttons">
        {buttons.includes("ok") && (
          <Button icon="edit_OK" onClick={() => void finish(true)} disabled={busy} testId="task-ok" primary>
            OK
          </Button>
        )}
        {buttons.includes("close") && (
          <Button onClick={() => void finish(true)} disabled={busy} testId="task-close" primary>
            Close
          </Button>
        )}
        {buttons.includes("cancel") && (
          <Button icon="edit_Cancel" onClick={() => void finish(false)} disabled={busy} testId="task-cancel">
            Cancel
          </Button>
        )}
      </div>
      {task.render()}
    </div>
  );
}

/** Accept / reject the open task (Enter / Esc in the 3D view, programmatic tests). */
export async function finishTask(ok: boolean): Promise<void> {
  const task = useApp.getState().task;
  if (!task) return;
  try {
    if (ok) {
      const r = await task.accept();
      if (r === false) return;
    } else await task.reject();
    if (useApp.getState().task === task) useApp.getState().closeTask();
  } catch (e) {
    log.error(`${task.title}: ${errorText(e)}`);
  }
}

/** Renders the modal dialog stack (`state/dialogs.ts`): QInputDialog, QMessageBox and custom dialogs. */
import { useState } from "react";
import { useDialogs, type DialogSpec } from "../state/dialogs";
import { Button, Icon } from "./widgets";

function DialogView({ d }: { d: DialogSpec }) {
  const close = (r: unknown) => useDialogs.getState().close(d.id, r);
  const [value, setValue] = useState(d.value ?? "");
  const error = d.kind === "prompt" && d.validate ? d.validate(value) : null;
  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.stopPropagation()}>
      <div className="dialog" role="dialog" data-testid="dialog">
        <div className="dialog-title">
          <Icon name="freecad" />
          <span>{d.title}</span>
        </div>
        {d.kind === "custom" ? (
          d.render!(close)
        ) : (
          <>
            <div className="dialog-body">
              {d.icon && <Icon name={d.icon} size={32} />}
              <div className="content">
                {d.message && <div>{d.message}</div>}
                {d.kind === "prompt" && (
                  <>
                    <label>{d.label}</label>
                    <input
                      type="text"
                      autoFocus
                      data-testid="dialog-input"
                      value={value}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !error) close(value);
                        if (e.key === "Escape") close(null);
                      }}
                    />
                    {error && <div className="error-text">{error}</div>}
                  </>
                )}
              </div>
            </div>
            <div className="dialog-buttons">
              {d.kind === "prompt" && (
                <>
                  <Button primary disabled={!!error} onClick={() => close(value)} testId="dialog-ok">
                    OK
                  </Button>
                  <Button onClick={() => close(null)} testId="dialog-cancel">
                    Cancel
                  </Button>
                </>
              )}
              {d.kind === "message" && (
                <Button primary onClick={() => close(null)} testId="dialog-ok">
                  OK
                </Button>
              )}
              {d.kind === "confirm" &&
                (d.buttons ?? ["OK", "Cancel"]).map((b, i) => (
                  <Button key={b} primary={i === 0} onClick={() => close(b)} testId={`dialog-${b}`}>
                    {b}
                  </Button>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function Dialogs() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((d) => (
        <DialogView key={d.id} d={d} />
      ))}
    </>
  );
}

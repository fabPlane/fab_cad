/** File > Save As, File > Export and Help > About dialogs. */
import type { ExportFormat } from "@fab-cad/client";
import { useState } from "react";
import { exportFormats, serverPath } from "../../commands/actions";
import { custom } from "../../state/dialogs";
import { conn, docInfo, labelOf } from "../../state/session";
import { Button, ComboBox, Icon } from "../widgets";

/** Where to save: a browser download, or a path on the server (native backends only). */
export function saveAsDialog(doc: string): Promise<"download" | { path: string } | null> {
  const info = docInfo(doc);
  const suggested = serverPath(doc) ?? `${info?.label ?? doc}.FCStd`;
  return custom<"download" | { path: string }>(
    "Save As",
    (close) => <SaveAsBody suggested={suggested} close={close} />,
    "document-save-as",
  );
}

function SaveAsBody({ suggested, close }: { suggested: string; close: (r: "download" | { path: string } | null) => void }) {
  const [path, setPath] = useState(suggested);
  return (
    <>
      <div className="dialog-body">
        <Icon name="document-save-as" size={32} />
        <div className="content">
          <div>Save the document as a .FCStd file.</div>
          <label>Path on the FreeCAD server:</label>
          <input type="text" autoFocus data-testid="saveas-path" value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
      </div>
      <div className="dialog-buttons">
        <Button primary testId="saveas-server" onClick={() => close({ path })} disabled={!path.trim()}>
          Save on server
        </Button>
        <Button testId="saveas-download" onClick={() => close("download")}>
          Download…
        </Button>
        <Button onClick={() => close(null)}>Cancel</Button>
      </div>
    </>
  );
}

export function exportDialog(doc: string, names: string[]): Promise<{ format: ExportFormat; fileName: string } | null> {
  const base = names.length === 1 ? labelOf(doc, names[0]!) : (docInfo(doc)?.label ?? doc);
  return custom<{ format: ExportFormat; fileName: string }>(
    "Export file",
    (close) => <ExportBody base={base} close={close} />,
    "Std_Export",
  );
}

function ExportBody({ base, close }: { base: string; close: (r: { format: ExportFormat; fileName: string } | null) => void }) {
  const formats = exportFormats();
  const [format, setFormat] = useState<ExportFormat>(formats[0]!.format);
  const [name, setName] = useState(`${base}.${formats[0]!.ext}`);
  const ext = formats.find((f) => f.format === format)!.ext;
  return (
    <>
      <div className="dialog-body">
        <Icon name="Std_Export" size={32} />
        <div className="content">
          <label>File name:</label>
          <input type="text" data-testid="export-name" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Files of type:</label>
          <ComboBox
            testId="export-format"
            value={format}
            options={formats.map((f) => ({ value: f.format, label: f.label }))}
            onChange={(v) => {
              const f = formats.find((x) => x.format === v)!;
              setFormat(f.format);
              setName(`${name.replace(/\.[^.]*$/, "")}.${f.ext}`);
            }}
          />
          {!formats.some((f) => f.format === "step") && <p>Mock backend: STL and OBJ only. STEP, IGES and BREP require real FreeCAD.</p>}
        </div>
      </div>
      <div className="dialog-buttons">
        <Button primary testId="export-ok" onClick={() => close({ format, fileName: name.includes(".") ? name : `${name}.${ext}` })}>
          Export
        </Button>
        <Button onClick={() => close(null)}>Cancel</Button>
      </div>
    </>
  );
}

export function aboutDialog(): Promise<null> {
  return custom<null>(
    "About FreeCAD",
    (close) => {
      const info = conn()?.serverInfo;
      return (
        <>
          <div className="dialog-body">
            <Icon name="freecad" size={64} />
            <div className="content">
              <div style={{ fontSize: 18 }}>FreeCAD — web frontend</div>
              <div>
                FreeCAD's desktop user interface in the browser (fab_cad), driving FreeCAD's application core through the FreeCAD API of the
                fabPlane fork.
              </div>
              <div className="muted">
                Backend: {conn()?.description ?? "not connected"}
                {info
                  ? `\nServer: ${info.platform}, pid ${info.pid}, transport ${info.transport}${info.python ? ", Python enabled" : ""}`
                  : ""}
              </div>
              <div className="muted">FreeCAD and its icons are licensed under the LGPL-2.0-or-later; see /icons/NOTICE.</div>
            </div>
          </div>
          <div className="dialog-buttons">
            <Button primary onClick={() => close(null)}>
              OK
            </Button>
          </div>
        </>
      );
    },
    "freecad",
  ) as Promise<null>;
}

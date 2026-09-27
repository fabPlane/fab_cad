/**
 * The Start page (FreeCAD 1.x's Start workbench): new file cards, examples, and — for the web —
 * the connection to FreeCAD (a FreeCADApiServer URL, the in-page mock, the WebAssembly build).
 */
import { useState } from "react";
import { connectTo, rememberedWsUrl } from "../backend/controller";
import { DEFAULT_WASM_URL } from "../backend/connect";
import { errorText, newDocument, openFile } from "../commands/actions";
import { activateWorkbench } from "../commands/std";
import { useApp } from "../state/app";
import { log } from "../state/console";
import { useSession } from "../state/session";
import { run } from "./commandUi";
import { Icon } from "./widgets";

const EXAMPLES = [
  { file: "PartDesignExample.FCStd", title: "Part Design example", icon: "PartDesignWorkbench" },
  { file: "EngineBlock.FCStd", title: "Engine block", icon: "PartWorkbench" },
  { file: "Schenkel.stp", title: "Schenkel (STEP)", icon: "Part_FeatureImport" },
];

async function openExample(file: string): Promise<void> {
  try {
    const r = await fetch(`/examples/${file}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const blob = await r.blob();
    await openFile(new File([blob], file));
    useApp.getState().closeStart();
  } catch (e) {
    log.error(`Cannot open the example ${file}: ${errorText(e)}`);
  }
}

function Card({
  icon,
  title,
  desc,
  onClick,
  disabled,
  testId,
}: {
  icon: string;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className={`start-card ${disabled ? "disabled" : ""}`} onClick={onClick} data-testid={testId}>
      <Icon name={icon} size={48} />
      <div className="title">{title}</div>
      <div className="desc">{desc}</div>
    </div>
  );
}

export function StartPage() {
  const status = useSession((s) => s.status);
  const error = useSession((s) => s.error);
  const description = useSession((s) => s.conn?.description);
  const kind = useSession((s) => s.conn?.kind);
  const [url, setUrl] = useState(rememberedWsUrl());
  const connected = status === "connected";
  return (
    <div className="start-page" data-testid="start-page">
      <div className="start-inner">
        <div className="start-header">
          <Icon name="freecad" size={64} />
          <div>
            <h1>FreeCAD</h1>
            <div className="sub">Your own 3D parametric modeler — in the browser</div>
          </div>
        </div>

        <div className="start-section">
          <h2>New File</h2>
          <div className="start-cards">
            <Card
              icon="PartDesignWorkbench"
              title="Parametric Part"
              desc="Create a part with the Part Design workbench"
              disabled={!connected}
              testId="start-parametric"
              onClick={async () => {
                activateWorkbench("PartDesignWorkbench");
                await newDocument();
                useApp.getState().closeStart();
                if (kind !== "mock") run("PartDesign_Body");
              }}
            />
            <Card
              icon="PartWorkbench"
              title="Part"
              desc="Create a part with the Part workbench"
              disabled={!connected}
              testId="start-part"
              onClick={async () => {
                activateWorkbench("PartWorkbench");
                await newDocument();
                useApp.getState().closeStart();
              }}
            />
            <Card
              icon="Document"
              title="Empty File"
              desc="Create a new empty FreeCAD file"
              disabled={!connected}
              testId="start-empty"
              onClick={async () => {
                await newDocument();
                useApp.getState().closeStart();
              }}
            />
            <Card
              icon="document-open"
              title="Open File"
              desc="Open a .FCStd, STEP, IGES, BREP or STL file"
              disabled={!connected}
              testId="start-open"
              onClick={() => run("Std_Open")}
            />
          </div>
        </div>

        <div className="start-section">
          <h2>Examples</h2>
          <div className="start-cards">
            {EXAMPLES.map((e) => (
              <Card
                key={e.file}
                icon={e.icon}
                title={e.title}
                desc={e.file}
                disabled={!connected || kind === "mock"}
                testId={`example-${e.file}`}
                onClick={() => void openExample(e.file)}
              />
            ))}
          </div>
          {kind === "mock" && (
            <div className="muted" style={{ marginTop: 6 }}>
              The in-page mock cannot read real FreeCAD files; connect to a FreeCAD API server for the examples.
            </div>
          )}
        </div>

        <div className="start-section">
          <h2>Connection</h2>
          <div className="connection-box" data-testid="connection-box">
            <div className="state">
              <span className={`dot ${status}`} />
              <span data-testid="connection-state">
                {connected
                  ? `Connected — ${description}`
                  : status === "connecting"
                    ? "Connecting…"
                    : status === "idle"
                      ? "Not connected"
                      : status}
              </span>
            </div>
            {error && (
              <div className="error" data-testid="connection-error">
                {error}
              </div>
            )}
            <div className="row">
              <span>FreeCAD API server:</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} data-testid="ws-url" />
              <button className="btn" data-testid="connect-ws" onClick={() => void connectTo({ kind: "ws", url })}>
                Connect
              </button>
            </div>
            <div className="row">
              <button className="btn" data-testid="connect-mock" onClick={() => void connectTo({ kind: "mock", demo: false })}>
                In-page mock
              </button>
              <button className="btn" onClick={() => void connectTo({ kind: "mock", demo: true })}>
                Mock with demo document
              </button>
              <button
                className="btn"
                data-testid="connect-wasm"
                onClick={() => void connectTo({ kind: "wasm", moduleUrl: DEFAULT_WASM_URL })}
              >
                WebAssembly build
              </button>
              <button className="btn" onClick={() => void connectTo({ kind: "bridge", base: "" })}>
                Bridge (this origin)
              </button>
            </div>
            <div className="muted">
              Start a server with <code>FreeCADApiServer --listen ws://127.0.0.1:8765/</code>, or open this page with{" "}
              <code>?ws=ws://…</code>, <code>?mock=1</code> or <code>?wasm=1</code>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { backendLabel, isMockBackend } from "../src/backend/capabilities";
import { connectBackend } from "../src/backend/connect";
import { exportFormats, exportObjects, newDocument } from "../src/commands/actions";
import { useApp } from "../src/state/app";
import { useDialogs } from "../src/state/dialogs";
import { attachConnection, disconnect, useSession } from "../src/state/session";
import { Dialogs } from "../src/ui/Dialogs";
import { StartPage } from "../src/ui/StartPage";
import { StatusBar } from "../src/ui/StatusBar";
import { exportDialog } from "../src/ui/dialogs/fileDialogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  useApp.setState({ activeDoc: null, openTabs: [], startTab: true, task: null });
  const connection = await connectBackend({ kind: "mock", demo: false });
  // The same engine can be reached through the bridge; keep its transport identity.
  connection.kind = "bridge";
  attachConnection(connection, { kind: "bridge", base: "http://localhost" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    for (const dialog of useDialogs.getState().stack) useDialogs.getState().close(dialog.id, null);
    root.unmount();
    await disconnect();
  });
  host.remove();
});

test("a bridge mock is labeled as a mock and cannot open real-file examples", async () => {
  await act(async () =>
    root.render(
      <>
        <StatusBar />
        <StartPage />
      </>,
    ),
  );
  expect(host.querySelector('[data-testid="status-backend"]')?.textContent).toBe("Mock FreeCAD");
  expect(host.textContent).toContain("The mock cannot read real FreeCAD files");
  const examples = [...host.querySelectorAll('[data-testid^="example-"]')];
  expect(examples).toHaveLength(3);
  expect(examples.every((e) => e.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(useSession.getState().conn?.kind).toBe("bridge");
});

test("mock exports offer STL and OBJ, default to STL, and reject STEP before dispatch", async () => {
  await newDocument();
  expect(exportFormats().map((f) => f.format)).toEqual(["stl", "obj"]);
  await expect(exportObjects("Unnamed", [], "step")).rejects.toThrow("STEP export requires real FreeCAD");
  await act(async () => {
    root.render(<Dialogs />);
    void exportDialog("Unnamed", []);
  });
  const options = [...host.querySelectorAll('[data-testid="export-format"] option')].map((e) => (e as HTMLOptionElement).value);
  expect(options).toEqual(["stl", "obj"]);
  expect((host.querySelector('[data-testid="export-format"]') as HTMLSelectElement).value).toBe("stl");
  expect((host.querySelector('[data-testid="export-name"]') as HTMLInputElement).value).toBe("Unnamed.stl");
  expect(host.textContent).toContain("STEP, IGES and BREP require real FreeCAD");
});

test("native and WASM engines retain their labels and STEP export", () => {
  const mock = useSession.getState().conn!;
  const native = { ...mock, serverInfo: { ...mock.serverInfo!, platform: "darwin" } };
  useSession.setState({ conn: native });
  expect(isMockBackend(native)).toBe(false);
  expect(backendLabel(native)).toBe("FreeCAD");
  expect(backendLabel({ ...native, kind: "wasm" })).toBe("FreeCAD (wasm)");
  expect(exportFormats().map((f) => f.format)).toEqual(["step", "iges", "brep", "stl", "obj"]);
});

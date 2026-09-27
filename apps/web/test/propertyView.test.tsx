/** The property view rendered with happy-dom against the in-page mock: groups, editors, edits. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { connectBackend } from "../src/backend/connect";
import { newDocument, settle } from "../src/commands/actions";
import { makeContext } from "../src/commands/context";
import { registerAllCommands } from "../src/commands/index";
import { runCommand } from "../src/commands/registry";
import { useApp } from "../src/state/app";
import { useConsole } from "../src/state/console";
import { useSelection } from "../src/state/selection";
import { attachConnection, disconnect, property } from "../src/state/session";
import { useViewProps } from "../src/state/viewprops";
import { PropertyView } from "../src/ui/PropertyView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
registerAllCommands();

let root: Root;
let host: HTMLDivElement;

const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const text = (sel: string) => q(sel)?.textContent ?? null;

async function flush(): Promise<void> {
  await act(async () => {
    await settle();
    await new Promise((r) => setTimeout(r, 30));
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  useConsole.setState({ lines: [], report: [], history: [] });
  useApp.setState({ activeDoc: null, openTabs: [], startTab: true, task: null, editing: null, propertyTab: "data" });
  const c = await connectBackend({ kind: "mock", demo: false });
  attachConnection(c, { kind: "mock", demo: false });
  await newDocument();
  await runCommand("Part_Box", makeContext());
  useSelection.getState().setSelection([{ doc: "Unnamed", object: "Box", sub: "" }]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<PropertyView />));
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await disconnect();
});

describe("property view", () => {
  test("Data tab: groups sorted, camel case names split, quantities formatted, hidden properties left out", () => {
    const groups = [...host.querySelectorAll(".prop-row.group")].map((g) => g.textContent?.replace(/[▼▶]/g, "").trim());
    expect(groups).toEqual(["Base", "Box"]);
    expect(text("[data-testid='prop-value-Length']")).toBe("10.00 mm");
    expect(q("[data-testid='prop-row-Visibility']")).toBeNull();
    expect(q("[data-testid='prop-row-Shape']")).toBeNull();
    expect(text("[data-testid='prop-row-Placement'] .prop-name")).toContain("Placement");
  });

  test("a quantity editor accepts '1 in' and sets 25.4 mm through setProperties", async () => {
    await act(async () => q("[data-testid='prop-cell-Length']")!.click());
    const input = q("[data-testid='prop-edit-Length'] input, input[data-testid='prop-edit-Length']") as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => typeInto(input, "1 in"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(property("Unnamed", "Box", "Length")?.value).toMatchObject({ value: 25.4 });
    expect(text("[data-testid='prop-value-Length']")).toBe("25.40 mm");
    expect(useConsole.getState().lines.map((l) => l.text)).toContain("FreeCAD.getDocument('Unnamed').getObject('Box').Length = '25.40 mm'");
  });

  test("an invalid quantity marks the editor and changes nothing", async () => {
    await act(async () => q("[data-testid='prop-cell-Width']")!.click());
    const input = q("input[data-testid='prop-edit-Width']") as HTMLInputElement;
    await act(async () => typeInto(input, "ten"));
    expect(q("[data-testid='prop-cell-Width'] .spin.invalid")).not.toBeNull();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(property("Unnamed", "Box", "Width")?.value).toMatchObject({ value: 10 });
  });

  test("a placement expands into sub-rows that edit the whole placement", async () => {
    await act(async () => (q("[data-testid='prop-row-Placement'] .prop-name") as HTMLElement).click());
    expect(q("[data-testid='prop-row-Placement.Base']")).not.toBeNull();
    await act(async () => (q("[data-testid='prop-row-Placement.Base'] .prop-name") as HTMLElement).click());
    await act(async () => q("[data-testid='prop-cell-Placement.Base.z']")!.click());
    const input = q("[data-testid='prop-cell-Placement.Base.z'] input") as HTMLInputElement;
    await act(async () => typeInto(input, "5 mm"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(property("Unnamed", "Box", "Placement")?.value).toMatchObject({ base: [0, 0, 5] });
  });

  test("'=' starts an expression; the row shows it", async () => {
    await act(async () => q("[data-testid='prop-cell-Height']")!.click());
    const spin = q("[data-testid='prop-cell-Height'] input") as HTMLInputElement;
    await act(async () => spin.dispatchEvent(new KeyboardEvent("keydown", { key: "=", bubbles: true })));
    const expr = q("input[data-testid='prop-edit-Height']") as HTMLInputElement;
    expect(expr.value).toBe("=");
    await act(async () => typeInto(expr, "=Length + 1 mm"));
    await act(async () => expr.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(property("Unnamed", "Box", "Height")?.expression).toBe("Length + 1 mm");
    expect(q("[data-testid='prop-cell-Height']")!.className).toContain("expression");
    expect(q("[data-testid='prop-row-Height']")!.title).toContain("Expression: =Length + 1 mm");
  });

  test("View tab: FreeCAD's view provider properties, editable", async () => {
    await act(async () => useApp.getState().setPropertyTab("view"));
    expect(text("[data-testid='view-value-DisplayMode']")).toBe("Flat Lines");
    expect(text("[data-testid='view-value-ShapeColor']")).toBe("[204, 204, 204]");
    expect(text("[data-testid='view-value-LineWidth']")).toBe("2.00");
    await act(async () => useViewProps.getState().set("Unnamed", "Box", { Transparency: 50 }));
    expect(text("[data-testid='view-value-Transparency']")).toBe("50");
  });
});

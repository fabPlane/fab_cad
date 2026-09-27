/**
 * The screenshots in docs/screenshots, taken from a real FreeCADApiServer (SCREENSHOTS=1).
 *
 *   FREECAD_API_SERVER=…/FreeCADApiServer SCREENSHOTS=1 bun run --filter @fab-cad/e2e test:real -g screenshot
 */
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { activeDoc, clickView, meshSize, openApp, run, startCard } from "../helpers";

test.skip(
  !process.env.FREECAD_API_SERVER || !process.env.SCREENSHOTS,
  "set FREECAD_API_SERVER and SCREENSHOTS=1 to write docs/screenshots",
);

const OUT = resolve(import.meta.dirname, "..", "..", "docs", "screenshots");

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** Set properties straight through the client (staging a scene, not what is being shown). */
async function setProps(page: Page, doc: string, object: string, values: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    async ([d, o, v]) => {
      const c = (window as any).__fabcad.conn();
      await c.client.setProperties(d, o, v);
      await c.client.recompute(d);
      await c.store.flush();
    },
    [doc, object, values] as const,
  );
}

const placement = (x: number, y: number, z: number) => ({ $type: "Placement", base: [x, y, z], rotation: [0, 0, 0, 1] });
const mm = (v: number) => ({ $type: "Quantity", value: v, unit: "mm" });

test("screenshot: start page", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("start-page")).toBeVisible();
  await shot(page, "start-page");
});

test("screenshot: Part workbench with primitives and a boolean", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-part");
  const doc = await activeDoc(page);
  for (const id of ["Part_Box", "Part_Cylinder", "Part_Sphere", "Part_Cone", "Part_Torus"]) await run(page, id);
  await setProps(page, doc, "Box", { Length: mm(20), Width: mm(20), Height: mm(12) });
  await setProps(page, doc, "Cylinder", { Radius: mm(6), Height: mm(20), Placement: placement(10, 10, -4) });
  await setProps(page, doc, "Sphere", { Radius: mm(7), Placement: placement(40, 10, 7) });
  await setProps(page, doc, "Cone", { Radius1: mm(7), Radius2: mm(2), Height: mm(14), Placement: placement(10, 45, 0) });
  await setProps(page, doc, "Torus", { Radius1: mm(9), Radius2: mm(2.5), Placement: placement(42, 42, 2.5) });
  await page.getByTestId("tree-Box").click();
  await page.getByTestId("tree-Cylinder").click({ modifiers: ["Control"] });
  await page.getByTestId("tb-Part_Cut").click();
  await expect.poll(() => meshSize(page, "Cut")).not.toBeNull();
  await run(page, "Std_ViewIsometric");
  await page.waitForTimeout(400);
  await run(page, "Std_ViewFitAll");
  await page.getByTestId("tree-Cut").click();
  await page.getByTestId("tab-python").click();
  await shot(page, "part-workbench");
});

async function sketchRectangle(page: Page): Promise<void> {
  await run(page, "PartDesign_NewSketch");
  await page.getByTestId("task-ok").click();
  await expect(page.getByTestId("sketch-panel")).toBeVisible();
  const box = (await page.getByTestId("view3d").boundingBox())!;
  await run(page, "Sketcher_CreateRectangle");
  await clickView(page, box.width / 2 - 160, box.height / 2 - 100);
  await clickView(page, box.width / 2 + 160, box.height / 2 + 100);
  await expect(page.getByTestId("sketch-elements").locator(".listbox-item")).toHaveCount(4);
}

test("screenshot: sketch edit mode", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-parametric");
  await sketchRectangle(page);
  const box = (await page.getByTestId("view3d").boundingBox())!;
  await run(page, "Sketcher_CreateCircle");
  await clickView(page, box.width / 2 + 40, box.height / 2 + 10);
  await clickView(page, box.width / 2 + 90, box.height / 2 + 10);
  await expect(page.getByTestId("sketch-elements").locator(".listbox-item")).toHaveCount(5);
  await page.keyboard.press("Escape");
  // a length on the top edge and a radius on the circle (the commands ask for the value)
  const constrain = async (x: number, y: number, id: string, value: string) => {
    await clickView(page, x, y);
    await page.evaluate((cmd) => void (window as any).__fabcad.run(cmd), id);
    await page.getByTestId("dialog-input").fill(value);
    await page.getByTestId("dialog-input").press("Enter");
    await expect(page.getByTestId("dialog")).toHaveCount(0);
  };
  await constrain(box.width / 2, box.height / 2 - 100, "Sketcher_ConstrainDistance", "80 mm");
  await constrain(box.width / 2 + 90, box.height / 2 + 10, "Sketcher_ConstrainRadius", "12 mm");
  await expect(page.getByTestId("sketch-constraints").locator(".listbox-item")).toHaveCount(10);
  await run(page, "Sketcher_CreateLine");
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 + 40);
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40);
  await shot(page, "sketch-edit");
  await page.keyboard.press("Escape");
});

test("screenshot: Part Design body with a pad", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-parametric");
  await sketchRectangle(page);
  await page.getByTestId("sketch-close").click();
  await run(page, "PartDesign_Pad");
  await page.getByTestId("task-Length").fill("25 mm");
  await page.getByTestId("task-Length").press("Enter");
  await expect.poll(async () => (await meshSize(page, "Pad"))?.[2], { timeout: 30_000 }).toBeCloseTo(25, 2);
  await shot(page, "partdesign-pad-task");
  await page.getByTestId("task-ok").click();
  await run(page, "Std_ViewIsometric");
  await page.waitForTimeout(400);
  await run(page, "Std_ViewFitAll");
  const box = (await page.getByTestId("view3d").boundingBox())!;
  await clickView(page, box.width / 2, box.height / 2 - 40);
  await page.getByTestId("tree-Pad").locator(".tree-toggle").click();
  await shot(page, "partdesign-pad");
});

test("screenshot: property view editing", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-part");
  await run(page, "Part_Box");
  await page.getByTestId("tab-python").click();
  await page.getByTestId("tree-Box").click();
  await page.getByTestId("prop-row-Placement").locator(".prop-name").click();
  await page.getByTestId("prop-row-Placement.Base").locator(".prop-name").click();
  await page.getByTestId("prop-cell-Height").click();
  await page.getByTestId("prop-edit-Height").fill("=Length * 2");
  await page.getByTestId("prop-edit-Height").press("Enter");
  await expect(page.getByTestId("prop-cell-Height")).toHaveClass(/expression/);
  await run(page, "Std_ViewFitAll");
  await page.getByTestId("prop-cell-Length").click();
  await page.getByTestId("prop-edit-Length").fill("1 in");
  await shot(page, "property-editing");
  await page.getByTestId("prop-edit-Length").press("Enter");
  await expect(page.getByTestId("prop-value-Length")).toHaveText("25.40 mm");
});

test("screenshot: Python console", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-part");
  await run(page, "Part_Box");
  await page.getByTestId("tab-python").click();
  const lines = [
    "doc = App.ActiveDocument",
    "cyl = doc.addObject('Part::Cylinder', 'Shaft')",
    "cyl.Radius = 3",
    "doc.recompute()",
    "round(doc.Box.Shape.Volume, 2)",
    "[o.Label for o in doc.Objects]",
    "for o in doc.Objects:",
    "    print(o.Name, o.TypeId)",
    "",
    "doc.getObject('Nothing').Label",
  ];
  for (const l of lines) {
    await page.getByTestId("python-input").fill(l);
    await page.getByTestId("python-input").press("Enter");
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId("tree-Shaft")).toBeVisible();
  // a taller console for the picture
  const splitter = page.locator(".center-column > .splitter-h");
  const b = (await splitter.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y - 160, { steps: 5 });
  await page.mouse.up();
  await shot(page, "python-console");
});

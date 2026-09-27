/**
 * apps/web against a real FreeCADApiServer (FREECAD_API_SERVER): the Part, Part Design and file
 * workflows end to end, with FreeCAD computing the shapes.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { activeDoc, clickView, meshSize, openApp, propertyValue, run, startCard } from "../helpers";

test.skip(!process.env.FREECAD_API_SERVER, "set FREECAD_API_SERVER to a FreeCADApiServer binary to run the real-server suite");

test("Part: create a box, edit Length in the property view, the 3D view follows, undo", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-part");
  await page.getByTestId("tb-Part_Box").click();
  await expect(page.getByTestId("tree-label-Box")).toHaveText("Cube");
  await expect.poll(() => meshSize(page, "Box")).toEqual([10, 10, 10]);
  const doc = await activeDoc(page);

  await page.getByTestId("prop-cell-Length").click();
  await page.getByTestId("prop-edit-Length").fill("25 mm");
  await page.getByTestId("prop-edit-Length").press("Enter");
  await expect(page.getByTestId("prop-value-Length")).toHaveText("25.00 mm");
  await expect.poll(async () => (await meshSize(page, "Box"))?.[0], { timeout: 20_000 }).toBeCloseTo(25, 3);

  await page.getByTestId("menubar-Edit").click();
  await expect(page.getByTestId("menu-Std_Undo")).toContainText("Undo Edit Box.Length");
  await page.getByTestId("menu-Std_Undo").click();
  await expect.poll(() => propertyValue(page, doc, "Box", "Length")).toBe(10);
  await expect.poll(async () => (await meshSize(page, "Box"))?.[0], { timeout: 20_000 }).toBeCloseTo(10, 3);
});

test("Part: a boolean cut of two primitives hides its inputs", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-part");
  await run(page, "Part_Box");
  await run(page, "Part_Cylinder");
  const doc = await activeDoc(page);
  await page.getByTestId("tree-Box").click();
  await page.getByTestId("tree-Cylinder").click({ modifiers: ["Control"] });
  await page.getByTestId("tb-Part_Cut").click();
  await expect(page.getByTestId("tree-Cut")).toBeVisible();
  await expect.poll(() => meshSize(page, "Cut")).not.toBeNull();
  expect(await propertyValue(page, doc, "Box", "Visibility")).toBe(false);
});

test("Part Design: sketch a rectangle on XY, pad it, the pad is one undo step", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-parametric");
  await expect(page.getByTestId("tree-Body")).toBeVisible();
  const doc = await activeDoc(page);
  await run(page, "PartDesign_NewSketch");
  await expect(page.getByTestId("plane-XY_Plane")).toBeVisible();
  await page.getByTestId("task-ok").click();
  await expect(page.getByTestId("sketch-panel")).toBeVisible();

  await run(page, "Sketcher_CreateRectangle");
  const box = (await page.getByTestId("view3d").boundingBox())!;
  await clickView(page, box.width / 2 - 150, box.height / 2 - 90);
  await clickView(page, box.width / 2 + 150, box.height / 2 + 90);
  await expect(page.getByTestId("sketch-elements").locator(".listbox-item")).toHaveCount(4);
  await expect(page.getByTestId("sketch-constraints").locator(".listbox-item")).toHaveCount(8);
  await page.getByTestId("sketch-close").click();
  await expect(page.getByTestId("sketch-panel")).toHaveCount(0);

  await run(page, "PartDesign_Pad");
  await expect(page.getByTestId("task-Length")).toBeVisible();
  await page.getByTestId("task-Length").fill("15 mm");
  await page.getByTestId("task-Length").press("Enter");
  await expect.poll(async () => (await meshSize(page, "Pad"))?.[2], { timeout: 30_000 }).toBeCloseTo(15, 2);
  await page.getByTestId("task-ok").click();
  await expect(page.getByTestId("tree-Pad")).toBeVisible();
  expect(await propertyValue(page, doc, "Pad", "Length")).toBe(15);
  await page.getByTestId("menubar-Edit").click();
  await expect(page.getByTestId("menu-Std_Undo")).toContainText("Undo Pad");
  await page.keyboard.press("Escape");
});

test("File > Export writes STEP", async ({ page }) => {
  await openApp(page);
  await startCard(page, "start-part");
  await run(page, "Part_Box");
  await page.getByTestId("tree-Box").click();
  await page.getByTestId("menubar-File").click();
  await page.getByTestId("menu-Std_Export").click();
  await expect(page.getByTestId("export-format")).toHaveValue("step");
  const download = page.waitForEvent("download");
  await page.getByTestId("export-ok").click();
  const d = await download;
  expect(d.suggestedFilename()).toBe("Cube.step");
  const text = readFileSync((await d.path())!, "utf8");
  expect(text.startsWith("ISO-10303-21")).toBe(true);
  expect(text).toContain("MANIFOLD_SOLID_BREP");
});

test("File > Open an .FCStd and Save it back; Python console runs on the server", async ({ page }) => {
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("start-open").click();
  await (await chooser).setFiles(new URL("../../apps/web/public/examples/PartDesignExample.FCStd", import.meta.url).pathname);
  await expect(page.getByTestId("tree-doc-PartDesignExample")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("tree-doc-PartDesignExample").click();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  expect((await download).suggestedFilename()).toMatch(/PartDesignExample\.FCStd$/);

  await page.getByTestId("tab-python").click();
  await page.getByTestId("python-input").fill("len(App.getDocument('PartDesignExample').Objects) > 5");
  await page.getByTestId("python-input").press("Enter");
  await expect(page.locator(".console .line.result").last()).toHaveText("True");
});

test("dropping a STEP file on the window imports it into a new document", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const bytes = await (await fetch("/examples/Schenkel.stp")).arrayBuffer();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "Schenkel.stp"));
    const target = document.querySelector(".main-window")!;
    target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("tree-doc-Schenkel")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-testid^='tree-label-']").first()).toHaveText("Schenkel", { timeout: 60_000 });
  await expect(page.getByTestId("report-view").or(page.getByTestId("python-console"))).toBeVisible();
});

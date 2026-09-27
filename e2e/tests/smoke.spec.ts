/**
 * Smoke tests against the in-page mock (`?mock=1`): the main window, workbenches, documents, the
 * tree, the property view, the 3D view, undo, the console and the report view.
 */
import { expect, test } from "@playwright/test";
import { clickView, meshSize, propertyValue, run, waitConnected, startCard } from "../helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/?mock=1");
  await waitConnected(page);
});

test("main window: FreeCAD's menus, toolbars, docks and status bar", async ({ page }) => {
  await expect(page.getByTestId("menubar")).toBeVisible();
  const titles = await page.locator(".menubar-trigger").allTextContents();
  expect(titles.slice(0, 5)).toEqual(["File", "Edit", "View", "Tools", "Macro"]);
  expect(titles.at(-2)).toBe("Windows");
  expect(titles.at(-1)).toBe("Help");
  await expect(page.getByTestId("combo-view")).toBeVisible();
  await expect(page.getByTestId("combo-tab-model")).toHaveText("Model");
  await expect(page.getByTestId("combo-tab-tasks")).toHaveText("Tasks");
  await expect(page.getByTestId("start-page")).toBeVisible();
  await expect(page.getByTestId("status-backend")).toHaveText("Mock FreeCAD");
  await expect(page.getByTestId("nav-style")).toContainText("Gesture");
  // File menu: FreeCAD's items with their shortcuts
  await page.getByTestId("menubar-File").click();
  await expect(page.getByTestId("menu-Std_New")).toContainText("New Document");
  await expect(page.getByTestId("menu-Std_New")).toContainText("Ctrl+N");
  await expect(page.getByTestId("menu-Std_Print")).toHaveAttribute("data-disabled", "");
  await page.keyboard.press("Escape");
});

test("workbench selector switches menus and toolbars", async ({ page }) => {
  await page.getByTestId("workbench-selector").click();
  await page.getByTestId("wb-PartWorkbench").click();
  await expect(page.getByTestId("menubar-Part")).toBeVisible();
  await expect(page.getByTestId("toolbar-Solids")).toBeVisible();
  await page.getByTestId("workbench-selector").click();
  await page.getByTestId("wb-PartDesignWorkbench").click();
  await expect(page.getByTestId("menubar-Part Design")).toBeVisible();
  await expect(page.getByTestId("toolbar-Part Design Modeling Features")).toBeVisible();
  await page.getByTestId("workbench-selector").click();
  await page.getByTestId("wb-SketcherWorkbench").click();
  await expect(page.getByTestId("menubar-Sketch")).toBeVisible();
});

test("new document, box from the toolbar, tree, property edit, 3D update, undo/redo", async ({ page }) => {
  await startCard(page, "start-part");
  await expect(page.getByTestId("mdi-tab-Unnamed")).toBeVisible();
  await expect(page.getByTestId("tree-doc-Unnamed")).toBeVisible();
  await page.getByTestId("tb-Part_Box").click();
  await expect(page.getByTestId("tree-label-Box")).toHaveText("Cube");
  await expect(page.getByTestId("prop-value-Length")).toHaveText("10.00 mm");
  await expect.poll(() => meshSize(page, "Box")).toEqual([10, 10, 10]);

  // edit Length in the property view: "1 in" is 25.4 mm
  await page.getByTestId("prop-cell-Length").click();
  const editor = page.getByTestId("prop-edit-Length");
  await editor.fill("1 in");
  await editor.press("Enter");
  await expect(page.getByTestId("prop-value-Length")).toHaveText("25.40 mm");
  await expect.poll(async () => (await meshSize(page, "Box"))?.[0]).toBeCloseTo(25.4, 3);

  // the edit is one undo step with FreeCAD's name
  await page.getByTestId("menubar-Edit").click();
  await expect(page.getByTestId("menu-Std_Undo")).toContainText("Undo Edit Box.Length");
  await page.keyboard.press("Escape");
  await page.getByTestId("view3d").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Control+z");
  await expect.poll(() => propertyValue(page, "Unnamed", "Box", "Length")).toBe(10);
  await expect.poll(async () => (await meshSize(page, "Box"))?.[0]).toBeCloseTo(10, 3);
  await page.keyboard.press("Control+y");
  await expect.poll(() => propertyValue(page, "Unnamed", "Box", "Length")).toBeCloseTo(25.4, 5);

  // the Python console shows what FreeCAD would have run
  await page.getByTestId("tab-python").click();
  await expect(page.getByTestId("python-console")).toContainText('App.ActiveDocument.addObject("Part::Box","Box")');
  await expect(page.getByTestId("python-console")).toContainText("FreeCAD.getDocument('Unnamed').getObject('Box').Length = '25.40 mm'");
});

test("3D view: preselection text, sub-element selection, standard views, draw styles", async ({ page }) => {
  await startCard(page, "start-part");
  await run(page, "Part_Box");
  await expect.poll(() => meshSize(page, "Box")).toEqual([10, 10, 10]);
  await run(page, "Std_ViewFront");
  await page.waitForTimeout(400);
  await run(page, "Std_ViewFitAll");
  await page.waitForTimeout(100);
  const box = (await page.getByTestId("view3d").boundingBox())!;
  // the front face fills the middle of the view
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("status-message")).toContainText(/Preselected: Unnamed\.Box\.Face\d+ \(/);
  await clickView(page, box.width / 2, box.height / 2);
  await expect.poll(() => page.evaluate(() => (window as any).__fabcad.stores.selection.getState().selection[0]?.sub)).toMatch(/^Face\d+$/);
  await expect(page.getByTestId("tree-Box")).toHaveClass(/selected/);
  // click empty space clears
  await clickView(page, 30, box.height - 30);
  await expect.poll(() => page.evaluate(() => (window as any).__fabcad.stores.selection.getState().selection.length)).toBe(0);
  for (const id of [
    "Std_ViewIsometric",
    "Std_ViewTop",
    "Std_ViewRight",
    "Std_PerspectiveCamera",
    "Std_OrthographicCamera",
    "Std_DrawStyleWireframe",
    "Std_DrawStyleAsIs",
  ])
    await run(page, id);
  expect(await page.evaluate(() => (window as any).__fabcad.stores.view3d.getState().drawStyle)).toBe("As Is");
});

test("tree: rename with F2, visibility with Space, delete with Del, context menu", async ({ page }) => {
  await startCard(page, "start-part");
  await run(page, "Part_Box");
  await run(page, "Part_Cylinder");
  await page.getByTestId("tree-Box").click();
  await page.keyboard.press("F2");
  await page.getByTestId("tree-rename").fill("My box");
  await page.getByTestId("tree-rename").press("Enter");
  await expect(page.getByTestId("tree-label-Box")).toHaveText("My box");
  await page.getByTestId("tree-Box").click();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("tree-Box")).toHaveClass(/hidden-item/);
  await page.getByTestId("tree-Cylinder").click({ button: "right" });
  await expect(page.getByTestId("tree-context-menu")).toBeVisible();
  await page.getByTestId("tree-context-menu").getByTestId("menu-Std_Delete").click();
  await expect(page.getByTestId("tree-Cylinder")).toHaveCount(0);
});

test("View > Panels toggles the Report view and the Python console; the console shows errors", async ({ page }) => {
  await page.getByTestId("tab-python").click();
  await page.getByTestId("python-input").fill("1 + 1");
  await page.getByTestId("python-input").press("Enter");
  await expect(page.locator(".console .line.error").last()).toBeVisible();
  await page.getByTestId("tab-report").click();
  await expect(page.getByTestId("report-view")).toContainText("Connected");
  await page.getByTestId("menubar-View").click();
  await page.getByTestId("submenu-Panels").click();
  await page.getByTestId("menu-Std_ReportView").click();
  await expect(page.getByTestId("tab-report")).toHaveCount(0);
  await expect(page.getByTestId("bottom-dock")).toContainText("Python console");
  await page.getByTestId("menubar-View").click();
  await page.getByTestId("submenu-Panels").click();
  await page.getByTestId("menu-Std_PythonView").click();
  await expect(page.getByTestId("bottom-dock")).toHaveCount(0);
});

test("File > Save downloads the document", async ({ page }) => {
  await startCard(page, "start-empty");
  await run(page, "Part_Sphere");
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/\.FCStd$/);
});

test("?wasm=1 without a build says what is missing", async ({ page }) => {
  await page.goto("/?wasm=1");
  await expect(page.getByTestId("connection-banner")).toContainText("WebAssembly build is not available");
  await expect(page.getByTestId("connection-banner")).toContainText("wasm:fetch");
  await expect(page.getByTestId("status-backend")).toHaveText("error");
});

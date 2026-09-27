/**
 * The app with FreeCAD itself compiled to WebAssembly (`?wasm=1`): no server at all, the fork's
 * `freecad_api.wasm` runs in a Web Worker in the page. Skipped until a build has been fetched:
 *
 *   FREECAD_WASM_DIR=/path/to/wasm-build/freecad/wasm bun run wasm:fetch
 */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { activeDoc, meshSize, propertyValue, run, startCard, waitConnected } from "../helpers";

const DIST = new URL("../../packages/freecad-wasm/dist/freecad_api.wasm", import.meta.url).pathname;

test.describe("FreeCAD in WebAssembly", () => {
  test.skip(!existsSync(DIST), "no freecad_api.wasm in packages/freecad-wasm/dist");
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto("/?wasm=1");
    await expect(page.getByTestId("status-backend")).not.toHaveText(/idle|connecting|error/, { timeout: 90_000 });
    await waitConnected(page);
  });

  test("box, property edit, undo, and a STEP export, all inside the page", async ({ page }) => {
    const version = await page.evaluate(async () => {
      const w = window as unknown as {
        __fabcad: { conn(): { client: { getServerInfo(): Promise<{ platform: string }> } } };
      };
      return (await w.__fabcad.conn().client.getServerInfo()).platform;
    });
    expect(version).toBe("wasm");

    await startCard(page, "start-part");
    await run(page, "Part_Box");
    await expect(page.getByTestId("tree-label-Box")).toHaveText("Cube");
    await expect.poll(() => meshSize(page, "Box"), { timeout: 30_000 }).toEqual([10, 10, 10]);

    await page.getByTestId("tree-Box").click();
    await page.getByTestId("prop-cell-Length").click();
    const editor = page.getByTestId("prop-edit-Length");
    await editor.fill("1 in");
    await editor.press("Enter");
    await expect.poll(async () => (await meshSize(page, "Box"))?.[0], { timeout: 30_000 }).toBeCloseTo(25.4, 3);

    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await meshSize(page, "Box"))?.[0], { timeout: 30_000 }).toBeCloseTo(10, 3);

    await page.getByTestId("menubar-File").click();
    await page.getByTestId("menu-Std_Export").click();
    const download = page.waitForEvent("download");
    await page.getByTestId("export-ok").click();
    const text = readFileSync((await (await download).path())!, "utf8");
    expect(text.startsWith("ISO-10303-21")).toBe(true);
  });

  test("Part Design pad and the Python console run in the page", async ({ page }) => {
    await startCard(page, "start-parametric");
    const doc = await activeDoc(page);
    await page.getByTestId("tab-python").click();
    const input = page.getByTestId("python-input");
    for (const line of [
      `import Part, Sketcher; d = App.getDocument('${doc}'); b = d.addObject('PartDesign::Body','Body')`,
      "sk = b.newObject('Sketcher::SketchObject','Sketch')",
      "_ = [sk.addGeometry(Part.LineSegment(App.Vector(*p), App.Vector(*q))) for p, q in [((0,0,0),(20,0,0)),((20,0,0),(20,10,0)),((20,10,0),(0,10,0)),((0,10,0),(0,0,0))]]",
      "pad = b.newObject('PartDesign::Pad','Pad'); pad.Profile = sk; pad.Length = 5; d.recompute()",
      "round(pad.Shape.Volume, 6)",
    ]) {
      await input.fill(line);
      await input.press("Enter");
    }
    await expect(page.locator(".console .line.result").last()).toHaveText("1000.0", { timeout: 30_000 });
    await expect(page.getByTestId("tree-Pad")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await meshSize(page, "Pad"))?.[2], { timeout: 30_000 }).toBeCloseTo(5, 3);
    expect(await propertyValue(page, doc, "Pad", "Length")).toBe(5);
    await page.screenshot({ path: new URL("../../docs/screenshots/wasm-partdesign.png", import.meta.url).pathname });
  });
});

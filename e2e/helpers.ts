/** Helpers shared by the smoke and the real suites. */
import { expect, type Page } from "@playwright/test";

/** Run a FreeCAD command through the app's command registry (what a menu item does). */
export async function run(page: Page, id: string): Promise<void> {
  await page.evaluate((cmd) => (window as unknown as { __fabcad: { run(id: string): Promise<boolean> } }).__fabcad.run(cmd), id);
}

/** Open a menu of the menu bar and click an item by its command name. */
export async function menu(page: Page, title: string, id: string): Promise<void> {
  await page.getByTestId(`menubar-${title}`).click();
  await page.getByTestId(`menu-${id}`).first().click();
}

export async function waitConnected(page: Page): Promise<void> {
  await expect(page.getByTestId("status-backend")).not.toHaveText(/idle|connecting|error/, { timeout: 30_000 });
}

/** The active document's name. */
export async function activeDoc(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (window as unknown as { __fabcad: { stores: { app: { getState(): { activeDoc: string } } } } }).__fabcad.stores.app.getState()
        .activeDoc,
  );
}

/** Wait until the model mirror has applied every event, then return a property's numeric value. */
export async function propertyValue(page: Page, doc: string, object: string, prop: string): Promise<unknown> {
  return page.evaluate(
    async ([d, o, p]) => {
      const c = (
        window as unknown as {
          __fabcad: {
            conn(): { store: { flush(): Promise<void>; property(a: string, b: string, c: string): { value: unknown } | undefined } };
          };
        }
      ).__fabcad.conn();
      await c.store.flush();
      const v = c.store.property(d!, o!, p!)?.value as { value?: number } | undefined;
      return v && typeof v === "object" && "value" in v ? v.value : v;
    },
    [doc, object, prop],
  );
}

/** Revision of an object's mesh in the 3D view (changes when the shape changes). */
export async function meshRevision(page: Page, object: string): Promise<number | null> {
  return page.evaluate((o) => {
    const v = (window as unknown as { __fabcadViewer?: { objectView(n: string): { tess: { revision: number } } | undefined } })
      .__fabcadViewer;
    return v?.objectView(o)?.tess.revision ?? null;
  }, object);
}

/** The bounding box of an object's mesh in the 3D view. */
export async function meshSize(page: Page, object: string): Promise<[number, number, number] | null> {
  return page.evaluate((o) => {
    const v = (
      window as unknown as {
        __fabcadViewer?: {
          objectView(
            n: string,
          ): { bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } } | undefined;
        };
      }
    ).__fabcadViewer;
    const b = v?.objectView(o)?.bounds;
    return b ? [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z] : null;
  }, object);
}

/** Canvas-relative click in the 3D view. */
export async function clickView(page: Page, x: number, y: number, opts: { button?: "left" | "right" } = {}): Promise<void> {
  const box = (await page.getByTestId("view3d").boundingBox())!;
  await page.mouse.click(box.x + x, box.y + y, opts);
}

/** Open the app on the real server started by global-setup, with no documents left from earlier tests. */
export async function openApp(page: Page): Promise<void> {
  await page.goto(`/?ws=${encodeURIComponent(process.env.FREECAD_WS_URL!)}`);
  await waitConnected(page);
  await run(page, "Std_CloseAllWindows");
}

/** Click a Start page card that creates a document, and wait until the document is active. */
export async function startCard(page: Page, card: "start-part" | "start-parametric" | "start-empty"): Promise<string> {
  const before = await activeDoc(page);
  await page.getByTestId(card).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const f = (
          window as unknown as {
            __fabcad: {
              stores: { app: { getState(): { activeDoc: string | null } } };
              conn(): { store: { document(d: string): unknown } };
            };
          }
        ).__fabcad;
        const d = f.stores.app.getState().activeDoc;
        return d && f.conn().store.document(d) ? d : null;
      }),
    )
    .not.toBe(before ?? null);
  if (card === "start-parametric") await expect(page.locator("[data-testid^='tree-Body']").first()).toBeVisible();
  return activeDoc(page);
}

/**
 * Prints the command coverage table of docs/02-web-ui.md: every command of FreeCAD's menus and
 * toolbars in the Part, Part Design and Sketcher workbenches (and the Sketcher's edit mode), with
 * its FreeCAD menu text and whether the web UI implements it.
 *
 *   bun --preload ./test/setup.ts scripts/coverage.ts > coverage.md
 */
import { registerAllCommands } from "../src/commands/index";
import { commandDef, commandInfo, stripMnemonic } from "../src/commands/registry";
import { SKETCHER_EDIT_TOOLBARS, WORKBENCH_DEFS, type MenuEntry } from "../src/workbenches";

registerAllCommands();

type Status = "implemented" | "partial" | "not yet";

function status(id: string): Status {
  const info = commandInfo(id);
  const def = commandDef(id);
  if (def?.items) {
    const kids = def.items.map(status);
    if (kids.every((k) => k === "implemented")) return "implemented";
    return kids.some((k) => k !== "not yet") ? "partial" : "not yet";
  }
  if (!info.implemented) return "not yet";
  return info.partial ? "partial" : "implemented";
}

function collect(entries: MenuEntry[], out: string[]): void {
  for (const e of entries) {
    if (e === "Separator") continue;
    if (typeof e === "string") out.push(e);
    else collect(e.items, out);
  }
}

const sections: [string, string[]][] = [];
const seen = new Set<string>();
const add = (title: string, ids: string[]) => {
  const fresh = ids.filter((i) => !seen.has(i));
  fresh.forEach((i) => seen.add(i));
  if (fresh.length) sections.push([title, fresh]);
};
const pd = WORKBENCH_DEFS.PartDesignWorkbench;
for (const m of pd.menus.filter((x) => !["&Sketch", "&Part Design"].includes(x.title))) {
  const ids: string[] = [];
  collect(m.items, ids);
  add(`${stripMnemonic(m.title)} menu`, ids);
}
for (const tb of pd.toolbars.slice(0, 5))
  add(
    `${tb.name} toolbar`,
    tb.items.filter((i) => i !== "Separator"),
  );
for (const wb of [WORKBENCH_DEFS.PartWorkbench, WORKBENCH_DEFS.PartDesignWorkbench, WORKBENCH_DEFS.SketcherWorkbench]) {
  const ids: string[] = [];
  for (const m of wb.menus)
    if (!["&File", "&Edit", "&View", "&Tools", "&Macro", "&Windows", "&Help"].includes(m.title)) collect(m.items, ids);
  for (const tb of wb.toolbars.slice(5)) ids.push(...tb.items.filter((i) => i !== "Separator"));
  add(`${wb.name} workbench`, ids);
}
add(
  "Sketcher edit mode",
  SKETCHER_EDIT_TOOLBARS.flatMap((t) => t.items.filter((i) => i !== "Separator")),
);

const totals: Record<Status, number> = { implemented: 0, partial: 0, "not yet": 0 };
const lines: string[] = [];
for (const [title, ids] of sections) {
  lines.push(`#### ${title}`, "", "| Command | FreeCAD menu text | Status | Notes |", "| --- | --- | --- | --- |");
  for (const id of ids) {
    const s = status(id);
    totals[s]++;
    const info = commandInfo(id);
    lines.push(
      `| \`${id}\` | ${stripMnemonic(info.menuText).replace(/\|/g, "\\|")} | ${s} | ${(info.partial ?? "").replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
}
const total = totals.implemented + totals.partial + totals["not yet"];
console.log(
  `**${total} commands**: ${totals.implemented} implemented, ${totals.partial} partial, ${totals["not yet"]} not yet (shown in the menus, disabled).\n`,
);
console.log(lines.join("\n"));

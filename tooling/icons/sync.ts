#!/usr/bin/env bun
/**
 * Syncs what apps/web takes from FreeCAD's GUI sources, so the web UI uses FreeCAD's own texts and
 * icons rather than look-alikes:
 *
 *   1. Command metadata. Every `Command("Std_…")` / `Command("Part_…")` / … constructor in
 *      `src/Gui` and `src/Mod/{Part,PartDesign,Sketcher}/Gui` (and the `GetResources()` of the
 *      Python commands those workbenches register) gives a menu text, tooltip, pixmap and
 *      accelerator. The commands apps/web names (any quoted `Std_*`, `Part_*`, `PartDesign_*`,
 *      `Sketcher_*` string in `apps/web/src`) are written to
 *      `apps/web/src/generated/freecad-commands.json`.
 *   2. Icons. The pixmaps of those commands, plus the tree/overlay/workbench icons listed in
 *      `EXTRA_ICONS` and any `icon("…")` / `"icon": "…"` name used in `apps/web/src`, are copied as
 *      SVG into `apps/web/public/icons/` with `manifest.json` (name → file, source path, the
 *      licence declared in the SVG's own metadata if any) and a `NOTICE`.
 *
 *   bun tooling/icons/sync.ts [--freecad /path/to/freecad] [--check]
 *
 * `--check` exits 1 when the committed files differ from what would be written.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = join(REPO, "apps", "web");
const OUT_ICONS = join(APP, "public", "icons");
const OUT_COMMANDS = join(APP, "src", "generated", "freecad-commands.json");
const OUT_ICON_NAMES = join(APP, "src", "generated", "icon-names.json");

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const FREECAD = resolve(argValue("--freecad") ?? process.env.FREECAD_SRC ?? join(REPO, "..", "freecad"));
const CHECK = args.includes("--check");

/** Icons the app needs that no command names: tree items, overlays, workbenches, the start page. */
export const EXTRA_ICONS = [
  "freecad",
  "Document",
  "Feature",
  "folder",
  "px",
  "Geofeaturegroup",
  "Group",
  "Link",
  "TreeItemVisible",
  "TreeItemInvisible",
  "overlay_error",
  "overlay_recompute",
  "Warning",
  "critical-info",
  "info",
  "bound-expression",
  "bound-expression-unset",
  "edit_OK",
  "edit_Cancel",
  "edit-cleartext",
  "Std_CoordinateSystem",
  "Std_Axis",
  "Std_Plane",
  "Std_Point",
  "Std_Placement",
  "VarSet",
  "TextDocument",
  "Tree_Python",
  "applications-python",
  "utilities-terminal",
  "face-selection",
  "edge-selection",
  "vertex-selection",
  "view-refresh",
  "cursor-rotate",
  "cursor-pan",
  "cursor-zoom",
  "button_rotate",
  "button_left",
  "button_right",
  "button_up",
  "button_down",
  "PartWorkbench",
  "PartDesignWorkbench",
  "SketcherWorkbench",
  "Part_Box_Parametric",
  "Part_Cylinder_Parametric",
  "Part_Sphere_Parametric",
  "Part_Cone_Parametric",
  "Part_Torus_Parametric",
  "Part_Tube_Parametric",
  "Part_Wedge_Parametric",
  "Part_Prism_Parametric",
  "Part_Plane_Parametric",
  "Part_Ellipsoid_Parametric",
  "Part_Helix_Parametric",
  "Part_Spiral_Parametric",
  "Part_Circle_Parametric",
  "Part_Ellipse_Parametric",
  "Part_Line_Parametric",
  "Part_Point_Parametric",
  "Part_Polygon_Parametric",
  "Part_Feature",
  "Part_FeatureImport",
  "Part_3D_object",
  "Part_2D_object",
  "Part_Refine_Shape",
  "PartDesign_BaseFeature",
  "PartDesign_Body",
  "PartDesign_Plane",
  "PartDesign_Line",
  "PartDesign_Point",
  "PartDesign_CoordinateSystem",
  "Sketcher_Sketch",
  "Sketcher_NotFullyConstrained",
  "Sketcher_CreateLine",
  "Sketcher_CreatePolyline",
  "Sketcher_CreateRectangle",
  "Sketcher_CreateCircle",
  "Sketcher_CreateArc",
  "Sketcher_CreatePoint",
  "Sketcher_Element_Line_Edge",
  "Sketcher_Element_Circle_Edge",
  "Sketcher_Element_Arc_Edge",
  "Sketcher_Element_Point_StartingPoint",
];

// ---------------------------------------------------------------------------------- commands

export interface CommandMeta {
  name: string;
  menuText: string;
  toolTip: string;
  pixmap: string;
  accel: string;
  group: string;
  /** Source file relative to the FreeCAD tree. */
  source: string;
}

/** What `keySequenceToAccel(QKeySequence::X)` gives on Linux (Qt's KDE/GNOME bindings). */
const STANDARD_KEYS: Record<string, string> = {
  New: "Ctrl+N",
  Open: "Ctrl+O",
  Save: "Ctrl+S",
  SaveAs: "Ctrl+Shift+S",
  Close: "Ctrl+W",
  Print: "Ctrl+P",
  Quit: "Ctrl+Q",
  Undo: "Ctrl+Z",
  Redo: "Ctrl+Y",
  Cut: "Ctrl+X",
  Copy: "Ctrl+C",
  Paste: "Ctrl+V",
  Delete: "Del",
  SelectAll: "Ctrl+A",
  HelpContents: "F1",
  WhatsThis: "Shift+F1",
  Refresh: "F5",
  ZoomIn: "Ctrl++",
  ZoomOut: "Ctrl+-",
  NextChild: "Ctrl+Tab",
  PreviousChild: "Ctrl+Shift+Tab",
  FullScreen: "F11",
  Find: "Ctrl+F",
};

/** Concatenated C/Python string literals → one string (handles `\"`, `\n`, `\\`). */
function literals(src: string): string {
  let out = "";
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    out += m[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

/** The value of `name = …;` in a C++ constructor body. */
function cppField(body: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)`).exec(body);
  if (!m) return undefined;
  const expr = m[1]!;
  const std = /QKeySequence::(\w+)/.exec(expr);
  if (std) return STANDARD_KEYS[std[1]!] ?? "";
  if (/deleteKeySequence\(\)/.test(expr)) return "Del";
  // QT_TR_NOOP("..."), QT_TRANSLATE_NOOP("ctx", "...") -> the last argument's literals
  const tr = /QT_TRANSLATE_NOOP\s*\(\s*"(?:[^"\\]|\\.)*"\s*,([\s\S]*)\)\s*$/.exec(expr);
  if (tr) return literals(tr[1]!);
  return literals(expr);
}

export function parseCppCommands(text: string, source: string): CommandMeta[] {
  const out: CommandMeta[] = [];
  const re = /:\s*(?:[\w:]+)\(\s*"((?:Std|Part|PartDesign|Sketcher|Materials)_\w+)"\s*(?:,[^)]*)?\)\s*\{([\s\S]*?)\n\}/g;
  for (const m of text.matchAll(re)) {
    const name = m[1]!;
    const body = m[2]!;
    if (!/sMenuText|sPixmap|sToolTipText/.test(body)) continue;
    out.push({
      name,
      menuText: cppField(body, "sMenuText") ?? name,
      toolTip: cppField(body, "sToolTipText") ?? "",
      pixmap: (cppField(body, "sPixmap") ?? "").replace(/\.svg$/, ""),
      accel: cppField(body, "sAccel") ?? "",
      group: cppField(body, "sGroup") ?? "",
      source,
    });
  }
  return out;
}

function pyField(block: string, key: string): string | undefined {
  const m = new RegExp(`["']${key}["']\\s*:\\s*([\\s\\S]*?)(?:,\\s*\\n|\\n\\s*\\})`).exec(block);
  if (!m) return undefined;
  const expr = m[1]!;
  const tr = /QT_TRANSLATE_NOOP\s*\(\s*["'][^"']*["']\s*,([\s\S]*)\)\s*$/.exec(expr.trim());
  const body = tr ? tr[1]! : expr;
  const strs = [...body.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1] ?? x[2] ?? "");
  return strs.join("");
}

export function parsePythonCommands(text: string, source: string): CommandMeta[] {
  const classes = new Map<string, string>();
  const classRe = /^class\s+(\w+)[^\n]*:\n([\s\S]*?)(?=^class\s|^def\s|^\S)/gm;
  for (const m of text.matchAll(classRe)) classes.set(m[1]!, m[2]!);
  const out: CommandMeta[] = [];
  for (const m of text.matchAll(/addCommand\(\s*["']((?:Std|Part|PartDesign|Sketcher)_\w+)["']\s*,\s*(\w+)\(/g)) {
    const block = classes.get(m[2]!);
    if (!block) continue;
    const res = /def GetResources\([\s\S]*?return\s*(\{[\s\S]*?\n\s*\})/.exec(block);
    if (!res) continue;
    const r = res[1]!;
    out.push({
      name: m[1]!,
      menuText: pyField(r, "MenuText") ?? m[1]!,
      toolTip: pyField(r, "ToolTip") ?? "",
      pixmap: (pyField(r, "Pixmap") ?? "").replace(/\.svg$/, ""),
      accel: pyField(r, "Accel") ?? "",
      group: "",
      source,
    });
  }
  return out;
}

function walk(dir: string, filter: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(e.name)) out.push(p);
  }
  return out;
}

function allCommands(): Map<string, CommandMeta> {
  const src = join(FREECAD, "src");
  const cppDirs = ["Gui", "Mod/Part/Gui", "Mod/PartDesign/Gui", "Mod/Sketcher/Gui"].map((d) => join(src, d));
  const pyDirs = ["Mod/Part", "Mod/PartDesign", "Mod/Sketcher"].map((d) => join(src, d));
  const map = new Map<string, CommandMeta>();
  for (const d of cppDirs) {
    for (const f of walk(d, (n) => n.endsWith(".cpp"))) {
      for (const c of parseCppCommands(readFileSync(f, "utf8"), relative(FREECAD, f))) if (!map.has(c.name)) map.set(c.name, c);
    }
  }
  for (const d of pyDirs) {
    for (const f of walk(d, (n) => n.endsWith(".py"))) {
      for (const c of parsePythonCommands(readFileSync(f, "utf8"), relative(FREECAD, f))) if (!map.has(c.name)) map.set(c.name, c);
    }
  }
  return map;
}

/** Command ids and icon names mentioned in the app's source. */
function referencedNames(): { commands: Set<string>; tokens: Set<string> } {
  const commands = new Set<string>();
  const tokens = new Set<string>();
  for (const f of walk(join(APP, "src"), (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n))) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/["']((?:Std|Part|PartDesign|Sketcher|Materials)_[A-Za-z0-9_]+)["']/g)) commands.add(m[1]!);
    // Any quoted identifier may name an icon (a pixmap, a tree icon); only real icons are copied.
    for (const m of text.matchAll(/["']([A-Za-z][\w-]{1,80})["']/g)) tokens.add(m[1]!);
  }
  return { commands, tokens };
}

// ------------------------------------------------------------------------------------- icons

interface IconEntry {
  file: string;
  source: string;
  /** Licence URL declared in the SVG's RDF metadata, when there is one. */
  license?: string;
}

function iconIndex(): Map<string, string> {
  const src = join(FREECAD, "src");
  const dirs = [
    join(src, "Gui", "Icons"),
    join(src, "Mod", "Part", "Gui", "Resources", "icons"),
    join(src, "Mod", "PartDesign", "Gui", "Resources", "icons"),
    join(src, "Mod", "Sketcher", "Gui", "Resources", "icons"),
  ];
  const idx = new Map<string, string>();
  for (const d of dirs) {
    for (const f of walk(d, (n) => n.endsWith(".svg"))) {
      const name = basename(f, ".svg");
      if (!idx.has(name)) idx.set(name, f);
    }
  }
  return idx;
}

function svgLicense(svg: string): string | undefined {
  const m = /<cc:license[^>]*rdf:resource="([^"]+)"/.exec(svg) ?? /<cc:License[^>]*rdf:about="([^"]+)"/.exec(svg);
  return m?.[1] || undefined;
}

function forkCommit(): string {
  try {
    const head = readFileSync(join(FREECAD, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head;
    const ref = head.slice(5).trim();
    const p = join(FREECAD, ".git", ref);
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
    const packed = readFileSync(join(FREECAD, ".git", "packed-refs"), "utf8");
    return (
      packed
        .split("\n")
        .find((l) => l.endsWith(` ${ref}`))
        ?.split(" ")[0] ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

const NOTICE = (commit: string, licensed: [string, string][]) => `FreeCAD icons
=============

The SVG files in this directory are copied unmodified from the FreeCAD source tree
(https://github.com/FreeCAD/FreeCAD, via the fabPlane fork at commit ${commit}):

  src/Gui/Icons/
  src/Mod/Part/Gui/Resources/icons/
  src/Mod/PartDesign/Gui/Resources/icons/
  src/Mod/Sketcher/Gui/Resources/icons/

They are part of FreeCAD and are distributed under FreeCAD's licence, the GNU Lesser General
Public License, version 2 or (at your option) any later version (LGPL-2.0-or-later; see LICENSE
and src/Doc/LICENSE.html in the FreeCAD tree: "The FreeCAD application is licensed under the
terms of the LGPL2+ license"). Neither directory holds a separate licence or README file for the
icons.

Some of the files additionally carry Creative Commons licence metadata written by their authors
(FreeCAD icon artists) in the SVG itself; manifest.json records it per file ("license"). Those
files are:

${licensed.length ? licensed.map(([n, l]) => `  ${n}.svg  ${l}`).join("\n") : "  (none)"}

The copies are regenerated by \`bun tooling/icons/sync.ts\` in the fab_cad repository; the source
path of every file is listed in manifest.json.
`;

async function main(): Promise<void> {
  if (!existsSync(join(FREECAD, "src", "Gui"))) {
    console.error(`no FreeCAD source tree at ${FREECAD} (pass --freecad <dir> or set FREECAD_SRC)`);
    process.exit(2);
  }
  const catalog = allCommands();
  const idx0 = iconIndex();
  const { commands: wanted, tokens } = referencedNames();
  const commands: Record<string, CommandMeta> = {};
  const missingCommands: string[] = [];
  for (const name of [...wanted].sort()) {
    const c = catalog.get(name);
    if (c) commands[name] = c;
    else if (!idx0.has(name)) missingCommands.push(name);
  }

  const idx = iconIndex();
  const iconNames = new Set<string>([...EXTRA_ICONS, ...[...tokens].filter((t) => idx.has(t))]);
  for (const c of Object.values(commands)) if (c.pixmap) iconNames.add(c.pixmap);
  // Command ids double as icon names for many commands (Part_Box.svg for Part_Box).
  for (const name of Object.keys(commands)) if (idx.has(name)) iconNames.add(name);

  const manifest: Record<string, IconEntry> = {};
  const files = new Map<string, string>();
  const missingIcons: string[] = [];
  for (const name of [...iconNames].sort()) {
    const path = idx.get(name);
    if (!path) {
      missingIcons.push(name);
      continue;
    }
    const svg = readFileSync(path, "utf8");
    const entry: IconEntry = { file: `${name}.svg`, source: relative(FREECAD, path) };
    const lic = svgLicense(svg);
    if (lic) entry.license = lic;
    manifest[name] = entry;
    files.set(`${name}.svg`, svg);
  }
  const commit = forkCommit();
  const iconNamesJson = JSON.stringify([...files.keys()].map((f) => f.slice(0, -4)).sort(), null, 0) + "\n";
  const licensed = Object.entries(manifest)
    .filter(([, e]) => e.license)
    .map(([n, e]) => [n, e.license!] as [string, string]);
  const manifestJson = JSON.stringify({ source: "FreeCAD", commit, icons: manifest }, null, 2) + "\n";
  const commandsJson = JSON.stringify(commands, null, 2) + "\n";
  const notice = NOTICE(commit, licensed);

  if (CHECK) {
    let stale = false;
    const same = (p: string, s: string) => existsSync(p) && readFileSync(p, "utf8") === s;
    if (!same(OUT_COMMANDS, commandsJson)) ((stale = true), console.error(`stale: ${relative(REPO, OUT_COMMANDS)}`));
    if (!same(OUT_ICON_NAMES, iconNamesJson)) ((stale = true), console.error(`stale: ${relative(REPO, OUT_ICON_NAMES)}`));
    if (!same(join(OUT_ICONS, "manifest.json"), manifestJson)) ((stale = true), console.error("stale: icons/manifest.json"));
    for (const [f, s] of files) if (!same(join(OUT_ICONS, f), s)) ((stale = true), console.error(`stale: icons/${f}`));
    process.exit(stale ? 1 : 0);
  }

  await mkdir(OUT_ICONS, { recursive: true });
  await mkdir(dirname(OUT_COMMANDS), { recursive: true });
  for (const f of await readdir(OUT_ICONS)) if (f.endsWith(".svg") && !files.has(f)) await rm(join(OUT_ICONS, f));
  for (const [f, s] of files) await writeFile(join(OUT_ICONS, f), s);
  await writeFile(join(OUT_ICONS, "manifest.json"), manifestJson);
  await writeFile(join(OUT_ICONS, "NOTICE"), notice);
  await writeFile(OUT_COMMANDS, commandsJson);
  await writeFile(OUT_ICON_NAMES, iconNamesJson);
  const size = [...files.keys()].reduce((n, f) => n + statSync(join(OUT_ICONS, f)).size, 0);
  console.log(
    `${Object.keys(commands).length} commands (of ${catalog.size} in FreeCAD), ${files.size} icons (${(size / 1024).toFixed(0)} KiB) from ${FREECAD} @ ${commit.slice(0, 10)}`,
  );
  if (missingCommands.length) console.warn(`commands not found in FreeCAD's sources (app-defined): ${missingCommands.join(", ")}`);
  if (missingIcons.length) console.warn(`icons not found: ${missingIcons.join(", ")}`);
}

if (import.meta.main) await main();

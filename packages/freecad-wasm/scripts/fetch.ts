#!/usr/bin/env bun
/**
 * Puts the Emscripten build of FreeCAD's API core into `dist/`, where `createFreeCadWasm()` looks
 * for it by default. For now the only source is a local build tree:
 *
 *   $FREECAD_WASM_DIR, else $FREECAD_SRC/build/wasm, else ../freecad/build/wasm next to this repo
 *
 *   bun run --filter @fab-cad/freecad-wasm fetch
 *   FREECAD_WASM_DIR=/path/to/build/wasm bun run fetch
 *
 * `freecad_api.js` and `freecad_api.wasm` are required; `freecad_api.data` (a `--preload-file`
 * bundle: FreeCAD's Mod/ and Python stdlib), source maps and a `freecad-wasm.json` manifest are
 * copied when present. A release download (like fab_pcb's kicad-wasm `--release`) comes once the
 * fork publishes wasm builds.
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");
const FREECAD_ROOT = process.env.FREECAD_SRC ? resolve(process.env.FREECAD_SRC) : resolve(PKG, "../../../freecad");
const SRC = resolve(process.env.FREECAD_WASM_DIR ?? join(FREECAD_ROOT, "build/wasm"));
const DIST = join(PKG, "dist");

const REQUIRED = ["freecad_api.js", "freecad_api.wasm"];
const OPTIONAL = ["freecad_api.data", "freecad_api.js.map", "freecad_api.wasm.map", "freecad-wasm.json"];

async function isFile(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isFile())
    .catch(() => false);
}

if (process.argv.includes("--release")) {
  console.error("fetch --release: the FreeCAD fork does not publish wasm builds yet; build locally (see docs/01-architecture.md)");
  process.exit(2);
}

const missing: string[] = [];
for (const f of REQUIRED) if (!(await isFile(join(SRC, f)))) missing.push(f);
if (missing.length > 0) {
  console.error(`no FreeCAD wasm build in ${SRC} (missing ${missing.join(", ")}).`);
  console.error("Build the fork's API core with Emscripten, or point FREECAD_WASM_DIR at a build.");
  process.exit(1);
}

await mkdir(DIST, { recursive: true });
let bytes = 0;
for (const f of [...REQUIRED, ...OPTIONAL]) {
  const from = join(SRC, f);
  if (!(await isFile(from))) continue;
  await copyFile(from, join(DIST, f));
  bytes += (await stat(from)).size;
  console.log(`  ${f}`);
}
console.log(`copied ${(bytes / 1e6).toFixed(1)} MB from ${SRC} to ${DIST}`);

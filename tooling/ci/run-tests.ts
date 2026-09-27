#!/usr/bin/env bun
/**
 * Runs `bun test` in every workspace package, one process per package, split into
 *
 *   unit         every *.test.ts(x) except integration files
 *   integration  *.freecad.test.ts(x) only — tests that need a real `FreeCADApiServer` binary
 *                (or the real `freecad_api.wasm` build)
 *
 * Why one process per package: `bun test` at the repo root loads every file into one process, so a
 * package that registers globals (a DOM shim, a fake WebSocket) would leak into every other
 * package's tests. Each package can also carry its own bunfig.toml preload.
 *
 * Integration files skip themselves when the binary named by FREECAD_API_SERVER does not exist;
 * `integration` warns up front when the variable is unset, so a CI job cannot silently pass with
 * every test skipped. Set FREECAD_INTEGRATION_REQUIRED=1 to turn that warning into a failure.
 *
 *   bun tooling/ci/run-tests.ts unit [--filter <name>] [-- extra bun test args]
 *   bun tooling/ci/run-tests.ts integration
 *   bun tooling/ci/run-tests.ts list          # print the classification and exit
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INTEGRATION = /\.freecad\.test\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-tsc", ".git", "output", "test-results", "playwright-report"]);

type Mode = "unit" | "integration" | "list";

interface Workspace {
  name: string;
  dir: string;
  unit: string[];
  integration: string[];
}

async function workspaces(): Promise<Workspace[]> {
  const root = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as { workspaces: string[] };
  const dirs: string[] = [];
  for (const pattern of root.workspaces) {
    for await (const p of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: REPO, onlyFiles: true })) {
      dirs.push(dirname(join(REPO, p)));
    }
  }
  const out: Workspace[] = [];
  for (const dir of dirs.sort()) {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name: string };
    const files = await collectTests(dir);
    if (files.length === 0) continue;
    out.push({
      name: pkg.name,
      dir,
      unit: files.filter((f) => !INTEGRATION.test(f)),
      integration: files.filter((f) => INTEGRATION.test(f)),
    });
  }
  return out;
}

async function collectTests(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await collectTests(join(dir, e.name))));
    } else if (TEST_FILE.test(e.name)) out.push(join(dir, e.name));
  }
  return out.sort();
}

function parseArgs(argv: string[]): { mode: Mode; filter: string | null; extra: string[] } {
  const mode = (argv[0] ?? "unit") as Mode;
  if (!["unit", "integration", "list"].includes(mode)) {
    console.error(`unknown mode '${mode}'; expected unit | integration | list`);
    process.exit(2);
  }
  let filter: string | null = null;
  const extra: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--filter") filter = argv[++i] ?? null;
    else if (a === "--") (extra.push(...argv.slice(i + 1)), (i = argv.length));
    else extra.push(a);
  }
  return { mode, filter, extra };
}

const { mode, filter, extra } = parseArgs(process.argv.slice(2));
const all = (await workspaces()).filter((w) => !filter || w.name.includes(filter) || relative(REPO, w.dir).includes(filter));

if (mode === "list") {
  for (const w of all) {
    console.log(`${w.name} (${relative(REPO, w.dir)})`);
    for (const f of w.unit) console.log(`  unit         ${relative(w.dir, f)}`);
    for (const f of w.integration) console.log(`  integration  ${relative(w.dir, f)}`);
  }
  process.exit(0);
}

if (mode === "integration") {
  const value = process.env.FREECAD_API_SERVER;
  if (!value) {
    const msg = "FREECAD_API_SERVER is not set; integration tests look for FreeCADApiServer on PATH and skip when it is missing";
    if (process.env.FREECAD_INTEGRATION_REQUIRED === "1") {
      console.error(`error: ${msg}`);
      process.exit(1);
    }
    console.warn(`warning: ${msg}`);
  } else if (!existsSync(value)) {
    console.error(`error: FREECAD_API_SERVER=${value} does not exist`);
    process.exit(1);
  } else {
    console.log(`FREECAD_API_SERVER=${value}`);
  }
}

let failed = 0;
let ran = 0;
const t0 = performance.now();
for (const w of all) {
  const files = mode === "unit" ? w.unit : w.integration;
  if (files.length === 0) continue;
  ran++;
  const rel = files.map((f) => relative(w.dir, f));
  console.log(`\n▶ ${w.name}  (${rel.length} ${mode} file${rel.length === 1 ? "" : "s"})`);
  const proc = Bun.spawn(["bun", "test", ...extra, ...rel], {
    cwd: w.dir,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  });
  const code = await proc.exited;
  if (code !== 0) {
    failed++;
    console.error(`✗ ${w.name}: bun test exited with ${code}`);
  }
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);
if (ran === 0) console.log(`no ${mode} test files found${filter ? ` for filter '${filter}'` : ""}`);
console.log(`\n${mode}: ${ran - failed}/${ran} package(s) passed in ${secs}s`);
process.exit(failed ? 1 : 0);

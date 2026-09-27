#!/usr/bin/env bun
/**
 * The mock FreeCAD API server as a program. It takes `FreeCADApiServer`'s arguments and prints the
 * same `FCAPI_READY <url>` line once it accepts connections, so the bridge can run it in place of
 * the real binary (`FREECAD_API_SERVER="bun …/main.ts"`):
 *
 *   bun packages/mock-server/src/main.ts                       ws://127.0.0.1:8765/, demo document
 *   bun packages/mock-server/src/main.ts --listen ws://127.0.0.1:0/ --key secret
 *   bun packages/mock-server/src/main.ts --stdio               length-prefixed stdin/stdout, events on fd 3
 *   bun packages/mock-server/src/main.ts model.FCStd           open a document saved by the mock
 *
 * FreeCADApiServer options: --listen URL, --stdio, --events-fd N, --key KEY, --allow-origin O
 * (accepted, not enforced), --module NAME (accepted), --no-python (the mock never runs Python),
 * --no-events. Mock-only: --port N and --host H (shorthand for --listen), --token T (fix the
 * instance token), --empty (no demo document), --quiet.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { MockFreeCAD, type MockFileSystem } from "./freecad";
import { startMockServer } from "./server";
import { runStdioHost } from "./stdio";

const USAGE =
  "usage: main.ts [--listen ws://H:N/ | --port N [--host H] | --stdio [--events-fd N]] [--key KEY] [--token T]\n" +
  "               [--empty] [--no-events] [--no-python] [--allow-origin O] [--module M] [--quiet] [FILE]";

const WITH_VALUE = new Set(["--listen", "--port", "--host", "--token", "--key", "--events-fd", "--allow-origin", "--module"]);
const opts = new Map<string, string>();
const flags = new Set<string>();
const files: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const eq = a.indexOf("=");
  const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
  if (WITH_VALUE.has(name)) {
    const v = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
    if (v === undefined) {
      console.error(`${name} needs a value\n${USAGE}`);
      process.exit(2);
    }
    opts.set(name, v);
  } else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith("-")) flags.add(a);
  else files.push(a);
}

const fs: MockFileSystem = {
  readFile: (p) => new Uint8Array(readFileSync(p)),
  writeFile: (p, d) => writeFileSync(p, d),
};
const token = opts.get("--token");
const demo = !flags.has("--empty") && files.length === 0;
const quiet = flags.has("--quiet");

function preload(freecad: MockFreeCAD): void {
  for (const f of files) {
    const { response } = freecad.handle({ id: 0, cmd: "OpenDocument", params: { path: f } });
    if (response.status !== "OK") {
      console.error(`cannot open ${f}: ${response.error}`);
      process.exit(1);
    }
  }
}

if (flags.has("--stdio")) {
  const freecad = new MockFreeCAD({ token, demo, fs, transport: "stdio", url: "stdio:" });
  preload(freecad);
  const fd = Number(opts.get("--events-fd") ?? 3);
  await runStdioHost(freecad, { eventsFd: flags.has("--no-events") || fd < 0 ? null : fd });
  process.exit(0);
}

let hostname = opts.get("--host") ?? "127.0.0.1";
let port = Number(opts.get("--port") ?? 8765);
const listen = opts.get("--listen");
if (listen) {
  const u = new URL(listen);
  if (u.protocol !== "ws:") {
    console.error(`--listen: only ws:// URLs are supported, got ${listen}`);
    process.exit(2);
  }
  hostname = u.hostname;
  port = Number(u.port || 80);
}

const server = startMockServer({
  port,
  hostname,
  token,
  demo,
  fs,
  key: opts.get("--key"),
  log: quiet ? undefined : (l) => console.error(l),
});
preload(server.freecad);
if (flags.has("--no-events")) server.freecad.publish = () => {};
console.log(`FCAPI_READY ${server.url}`);
if (!quiet) console.error(`FreeCAD API (mock) listening on ${server.url} (token ${server.freecad.token})`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

#!/usr/bin/env bun
/**
 * The mock FreeCAD API server as a program. It takes the same arguments as `FreeCADApiServer`, so
 * the bridge can run it in place of the real binary (`FREECAD_API_SERVER="bun …/main.ts"`):
 *
 *   bun packages/mock-server/src/main.ts                       ws://127.0.0.1:8765, demo document
 *   bun packages/mock-server/src/main.ts --port 9000 --empty
 *   bun packages/mock-server/src/main.ts --listen ws://127.0.0.1:9000 --token secret
 *   bun packages/mock-server/src/main.ts --stdio               length-prefixed stdin/stdout, events on fd 3
 *
 * Options: --port N, --host H, --listen ws://H:N, --stdio, --token T, --empty (no demo
 * document), --no-python (accepted; the mock never runs Python), --quiet.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { MockFreeCAD, type MockFileSystem } from "./freecad";
import { startMockServer } from "./server";
import { runStdioHost } from "./stdio";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const value = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${f}=`));
  return eq?.slice(f.length + 1);
};

if (has("--help") || has("-h")) {
  console.log("usage: main.ts [--port N] [--host H] [--listen ws://H:N] [--stdio] [--token T] [--empty] [--no-python] [--quiet]");
  process.exit(0);
}

const fs: MockFileSystem = {
  readFile: (p) => new Uint8Array(readFileSync(p)),
  writeFile: (p, d) => writeFileSync(p, d),
};
const token = value("--token");
const demo = !has("--empty");
const quiet = has("--quiet");

if (has("--stdio")) {
  const freecad = new MockFreeCAD({ token, demo, fs, transport: "stdio" });
  await runStdioHost(freecad);
  process.exit(0);
}

let hostname = value("--host") ?? "127.0.0.1";
let port = Number(value("--port") ?? 8765);
const listen = value("--listen");
if (listen) {
  const u = new URL(listen);
  if (u.protocol !== "ws:") {
    console.error(`--listen: only ws:// URLs are supported, got ${listen}`);
    process.exit(2);
  }
  hostname = u.hostname;
  port = Number(u.port || 80);
}

const server = startMockServer({ port, hostname, token, demo, fs, log: quiet ? undefined : (l) => console.error(l) });
console.log(`FreeCAD API (mock) listening on ${server.url} (token ${server.freecad.token})`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

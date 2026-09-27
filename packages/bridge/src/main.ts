#!/usr/bin/env bun
/**
 * The bridge as a program: `bun packages/bridge/src/main.ts` (configuration from the environment,
 * see `./config`). With the mock in place of FreeCAD:
 *
 *   FREECAD_API_SERVER="bun packages/mock-server/src/main.ts" bun packages/bridge/src/main.ts
 */
import { configFromEnv } from "./config";
import { startBridge } from "./server";

const bridge = await startBridge(configFromEnv());

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  bridge.config.log(`${signal}: shutting down`);
  await bridge.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

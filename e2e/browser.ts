/**
 * Browser launch options shared by the configs. The container ships Chromium under
 * PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers); when it is not the build the pinned
 * @playwright/test expects, launch it by path (PW_CHROMIUM overrides). WebGL runs on SwiftShader.
 */
import { existsSync } from "node:fs";

const candidates = [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium"].filter((p): p is string => !!p);
const executablePath = candidates.find((p) => existsSync(p));

export const launchOptions = {
  ...(executablePath ? { executablePath } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
};

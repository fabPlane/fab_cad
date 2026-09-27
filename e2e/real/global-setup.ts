/**
 * Starts the FreeCADApiServer named by FREECAD_API_SERVER on a free port and hands its URL to the
 * tests (FREECAD_WS_URL). Without the variable the suite skips (see fixtures.ts).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export default async function globalSetup(): Promise<void> {
  const bin = process.env.FREECAD_API_SERVER;
  if (!bin) return;
  if (!existsSync(bin)) throw new Error(`FREECAD_API_SERVER=${bin} does not exist`);
  const child = spawn(bin, ["--listen", "ws://127.0.0.1:0/"], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FreeCADApiServer did not print FCAPI_READY within 60 s")), 60_000);
    let out = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      const m = /FCAPI_READY (\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.stderr.on("data", () => undefined);
    child.on("exit", (code) => reject(new Error(`FreeCADApiServer exited with ${code}: ${out}`)));
  });
  process.env.FREECAD_WS_URL = url;
  process.env.FREECAD_API_SERVER_PID = String(child.pid);
  child.unref();
}

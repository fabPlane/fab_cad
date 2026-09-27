import { createReadStream, existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The bridge (packages/bridge) listens on PORT (default 4030) and serves /sessions, /files,
// /health and the /ws WebSocket. In dev they are proxied so the app can talk to it on the same
// origin; set BRIDGE_PORT (or BRIDGE_URL) when the bridge runs elsewhere.
const bridgePort = process.env.BRIDGE_PORT ?? "4030";
const bridge = process.env.BRIDGE_URL ?? `http://127.0.0.1:${bridgePort}`;
const bridgeWs = bridge.replace(/^http/, "ws");

const here = fileURLToPath(new URL(".", import.meta.url));
/** Where `bun run wasm:fetch` puts `freecad_api.js` / `.wasm` / `.data`. */
const wasmDist = process.env.FREECAD_WASM_DIR ?? join(here, "../../packages/freecad-wasm/dist");
/** The URL `?wasm=1` loads the module from (src/backend/connect.ts). */
const WASM_BASE = "/freecad-wasm";

/**
 * Serves the wasm build under `/freecad-wasm/` in dev and copies it into `dist/` on build. It is
 * loaded by URL at runtime (Emscripten glue fetches its own `.wasm` / `.data`), so a missing build
 * is a warning: only `?wasm=1` needs it, and the page says so when the files are not there.
 */
function freecadWasmAssets(): Plugin {
  return {
    name: "fab-cad:freecad-wasm-assets",
    configureServer(server) {
      server.middlewares.use(WASM_BASE, (req, res, next) => {
        const name = basename((req.url ?? "/").split("?")[0] ?? "");
        const file = name ? join(wasmDist, name) : "";
        if (!file || !existsSync(file)) {
          res.statusCode = 404;
          res.end(`not found: ${WASM_BASE}/${name} (run: bun run wasm:fetch)`);
          return;
        }
        res.setHeader(
          "content-type",
          name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream",
        );
        createReadStream(file).pipe(res);
        void next;
      });
    },
    async closeBundle() {
      if (!existsSync(wasmDist)) {
        this.warn(`no wasm build at ${wasmDist}; ?wasm=1 will not work in this build (run: bun run wasm:fetch)`);
        return;
      }
      await cp(wasmDist, join(here, "dist", WASM_BASE.slice(1)), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), freecadWasmAssets()],
  assetsInclude: ["**/*.wasm", "**/*.data"],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@fab-cad/freecad-wasm"] },
  server: {
    port: 5180,
    proxy: {
      "/sessions": bridge,
      "/files": bridge,
      "/health": bridge,
      "/ws": { target: bridgeWs, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});

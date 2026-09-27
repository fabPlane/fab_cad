/**
 * Worker entry point. Everything it does is in `serveFreeCadWasm` (`worker-core.ts`). Bundlers
 * find this file through `new Worker(new URL("./worker.ts", import.meta.url), {type: "module"})`
 * in `worker-client.ts`; nothing imports it as a module.
 */
import { serveFreeCadWasm } from "./worker-core";
import type { FreeCadWasmWorkerPort } from "./worker-protocol";

// `self` inside a dedicated worker; declared so the DOM lib's Window typing does not apply.
declare const self: FreeCadWasmWorkerPort;

serveFreeCadWasm(self);

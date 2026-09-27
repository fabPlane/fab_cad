/**
 * The messages between a page (or any host thread) and the Web Worker that owns one
 * `createFreeCadWasm()` instance — `worker-core.ts` on the worker side, `worker-client.ts` on the
 * host side. Buffers are transferred, not copied.
 *
 *   host -> worker   { start }            once, first
 *                    { id, req }          one encoded request
 *                    { id, fs }           one MEMFS operation
 *                    { stop }             shut the module down and close the worker
 *   worker -> host   { state, message? }  starting -> running | failed | exited
 *                    { id, res }          the encoded reply for that id
 *                    { id, value }        the result of that fs operation
 *                    { id, error, fatal } that request failed; `fatal` means the module is gone
 *                    { event }            one encoded event message
 *                    { log, level? }      a diagnostic line (the module's stdout/stderr)
 */

export interface WasmFile {
  path: string;
  bytes: Uint8Array;
}

export interface WasmStat {
  kind: "dir" | "file";
  size: number;
}

/** Everything the worker is told once, before it loads the module. */
export interface FreeCadWasmWorkerInit {
  /** ES module whose default export is the factory. Must be absolute (see `worker-client.ts`). */
  moduleUrl: string;
  wasmUrl?: string;
  /** Written into MEMFS before `fcapi_init`, so `preload` can name one of them. */
  files?: WasmFile[];
  home?: string;
  argv0?: string;
  env?: Record<string, string>;
  modules?: string[];
  preload?: string;
  python?: boolean;
  events?: boolean;
  eventEncoding?: "cbor" | "json";
}

export type WasmFsRequest =
  | { op: "writeFiles"; files: WasmFile[] }
  | { op: "readFile"; path: string }
  | { op: "exists"; path: string }
  | { op: "stat"; path: string }
  | { op: "listFiles"; path: string }
  | { op: "mkdir"; path: string }
  | { op: "remove"; path: string };

export type FreeCadWasmWorkerState = "starting" | "running" | "failed" | "exited";

export type ToFreeCadWasmWorker =
  | { start: FreeCadWasmWorkerInit }
  | { id: number; req: Uint8Array }
  | { id: number; fs: WasmFsRequest }
  | { stop: true };

export type FromFreeCadWasmWorker =
  | { state: FreeCadWasmWorkerState; message?: string }
  | { id: number; res: Uint8Array }
  | { id: number; value: unknown }
  | { id: number; error: string; fatal?: boolean }
  | { event: Uint8Array }
  | { log: string; level?: "info" | "warn" };

/** The worker side of the channel (`self` in the worker, or a fake in tests). */
export interface FreeCadWasmWorkerPort {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close?(): void;
}

/** The host side: a `Worker`, or anything shaped like one. */
export interface FreeCadWasmWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

/** Emscripten's `abort()` surfaces as a `WebAssembly.RuntimeError`. */
export function isWasmAbort(e: unknown): boolean {
  return typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;
}

/** The error name the worker client gives an abort on the worker thread (as `@fab-cad/client` checks). */
export const WASM_ABORT_ERROR_NAME = "FreeCadWasmAbort";

# @fab-cad/freecad-wasm

Loader for FreeCAD's API core compiled to WebAssembly (`freecad_api.js` + `freecad_api.wasm`, and
`freecad_api.data` when the build bundles FreeCAD's `Mod/` and the Python stdlib). It speaks the C
ABI of the fork's `src/Api/ApiC.h` — `fcapi_init(configJson)`, `fcapi_dispatch`, `fcapi_free`,
`fcapi_shutdown`, `fcapi_last_error`, events through `Module.__fcapiEvent` — and hands back a
`FreeCadWasmInstance` for `WasmTransport` in `@fab-cad/client`.

```ts
// Same thread (Bun, tests):
const wasm = await createFreeCadWasm({ modules: ["Part"], preload: "/work/model.FCStd" });
const client = new FreeCADClient(new WasmTransport(wasm));

// Browser, off the main thread:
const wasm = await createFreeCadWasmInWorker({ moduleUrl: "/freecad-wasm/freecad_api.js", files: [{ path: "/work/model.FCStd", bytes }] });
const client = new FreeCADClient(new WasmTransport(wasm)); // uses dispatchAsync
```

MEMFS helpers (`./fs`): `writeFile`, `readFile`, `readTextFile`, `exists`, `listFiles`, `remove`,
`mkdirTree`, and (Bun only) `mountFile`, `mountDirectory`, `exportFile`. In a worker the same
operations are async methods on the worker client.

`bun run --filter @fab-cad/freecad-wasm fetch` copies a build from `$FREECAD_WASM_DIR` (default
`../freecad/build/wasm` next to this repo) into `dist/`, the default `moduleUrl`. The fork has no
Emscripten target yet, so the tests drive the loader and the worker protocol with a fake module
(`test/fake-module.ts`) whose `fcapi_dispatch` is the mock server.

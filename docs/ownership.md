# Ownership

Who owns what, in the spirit of a `CODEOWNERS` file. Everybody else changes a path through its
owner, or by changing the contract (`packages/protocol`, following the fork's PROTOCOL.md) first.

| Path                                                                         | Owner              | Notes                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `docs/`, root `package.json`, `bunfig.toml`, `tsconfig*.json`, `.prettierrc` | Coordinator        | workspace list, root scripts, formatting                                                                                     |
| `packages/protocol/`                                                         | Protocol           | follows `src/Api/PROTOCOL.md` in the fork; `FREECAD_COMMIT` is the pin; its README lists where the code and the prose differ |
| `packages/client/`                                                           | Client SDK         | transports, `FreeCADClient`, `DocumentStore`                                                                                 |
| `packages/mock-server/`                                                      | Client SDK         | must keep matching the real server's behaviour; its CLI keeps `FreeCADApiServer`'s arguments                                 |
| `packages/freecad-wasm/`                                                     | WebAssembly        | loader and worker; the Emscripten build itself lives in the fork                                                             |
| `packages/bridge/`                                                           | Transport & bridge | process supervision, ws proxy, file API, static hosting                                                                      |
| `apps/web/`                                                                  | App shell          | the FreeCAD-like UI (next)                                                                                                   |
| `tooling/ci/`                                                                | QA & CI            | per-package unit/integration test runner                                                                                     |
| FreeCAD fork (`../freecad`, `src/Api`)                                       | API (C++)          | every command: handler + PROTOCOL.md + test; then the protocol package and the mock follow                                   |

## Conventions

- Tests: `bun test` per package; `*.freecad.test.ts` = integration (needs a real
  `FreeCADApiServer`, `FREECAD_API_SERVER` names it). `bun run test:unit` / `bun run test:integration`
  run every package in its own process (`tooling/ci/run-tests.ts`).
- Formatting: `.prettierrc` — 2 spaces, semicolons, double quotes, 140 columns.
- Dependencies are pinned to exact versions (`bunfig.toml` `exact = true`); `bun.lock` is committed.

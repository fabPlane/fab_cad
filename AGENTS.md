# Working in this repository

fab_cad is the web frontend for FreeCAD over the FreeCAD API of the fabPlane FreeCAD fork
(`src/Api`, wire format in `src/Api/PROTOCOL.md`). Read `docs/01-architecture.md` first.

## Branches

- **`main` is the only long-lived branch.** Branch from `main` and target `main` with every pull
  request. Merge with a merge commit; never rebase or force-push a branch someone else may have
  checked out, and never push `main` directly.
- A change that needs a protocol change lands in the fork first; then update
  `packages/protocol` (and `FREECAD_COMMIT`), the mock server, and the client, in that order.

## Checks

```sh
bun install --frozen-lockfile
bun run ci                 # format:check + typecheck + test:unit — must pass before every push
bun run format             # fix formatting
bun run test:unit -- --filter client        # one package
FREECAD_API_SERVER=/path/to/FreeCADApiServer bun run test:integration
```

## Code

- TypeScript strict, ES modules, Bun. No new runtime dependency without a reason in the commit
  message; pin exact versions.
- Where the fork's PROTOCOL.md and its code disagree, follow the code and record the difference in
  `packages/protocol/README.md`.
- The mock server is a contract test for the UI: keep it behaving like FreeCAD (names, units,
  events, undo) whenever the real server changes.
- Every package has unit tests; transports are tested against the mock over real sockets and pipes.

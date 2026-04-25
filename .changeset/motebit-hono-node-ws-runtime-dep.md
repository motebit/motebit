---
"motebit": patch
---

Add `@hono/node-ws` to runtime dependencies. The `motebit relay up` path imports `@motebit/api` (bundled via `tsup noExternal: [/^@motebit\//]`), which uses `@hono/node-ws` for WebSocket upgrades. The CLI's `tsup.config.ts` correctly marks it `external` (CJS-era init code that doesn't survive ESM bundling), but it was never declared as a runtime dependency of the `motebit` package itself.

In a workspace dev environment, pnpm's hoisting resolved the transitive dependency through `services/api`'s declaration. On a fresh `npm install motebit`, the package tries to load `@hono/node-ws` and exits with `ERR_MODULE_NOT_FOUND` on first boot.

Caught by `check-dist-smoke` (drift defense #12) on first push of the relay-up commit (`0e924976`) — exactly the regression class the gate was built for: a build that compiles clean but the dist binary crashes on startup. Same shape as the prior `@noble/hashes × @solana/web3.js` bundling break (2026-04-13).

Fix: declare `@hono/node-ws@^1.3.0` in `apps/cli/package.json` dependencies, matching the version pin already used by `services/api`.

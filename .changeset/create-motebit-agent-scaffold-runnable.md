---
"create-motebit": minor
---

`create-motebit --agent` scaffold is now actually runnable.

The published `--agent` path was structurally broken in two independent ways, both at 100% reproduction rate, both silent because release.yml's smoke test only exercised the default (identity-only) scaffold. Found in the 2026-04-25 first-time-user walkthrough of the agent path.

What was broken:

1. **`npm run build` failed immediately** with three TypeScript errors: `Cannot find module 'node:fs'`, `'node:path'`, `'node:child_process'`. The agent scaffold's `src/index.ts` imports Node built-ins, but the scaffold's `package.json` did not include `@types/node` in `devDependencies` and the `tsconfig.json` had no `types` array — so TypeScript couldn't resolve the type declarations and bailed before ever producing `dist/`.
2. **The entrypoint recursively spawned `motebit serve` forever.** `motebit serve --tools <path>` re-imports the agent's compiled entrypoint to discover tool definitions. Without a main-module guard, that re-import re-executed the spawn block at module top level, spawning another `motebit serve`, which re-imported, spawning another, recursive. 12 spawns in 8 seconds before manual kill. The agent never registered with the relay, never accepted a task, never did anything.

What changed:

- Added `@types/node ^22.0.0` to the agent scaffold's `devDependencies`. Build now compiles cleanly on a fresh checkout.
- Added a main-module guard to the rendered `src/index.ts` using `process.argv[1] === fileURLToPath(import.meta.url)`. The spawn block now fires only when the file is executed directly (`npm run dev`, `node dist/index.js`); re-importing the file as a tool source returns the default export without side effects.
- Updated the agent scaffold's `package.json` `verify` script to use `npx -p @motebit/verify motebit-verify motebit.md`, matching the next-steps fix already shipped for the default scaffold.
- Three new regression tests in `index.test.ts` assert: `@types/node` is in devDependencies, the entrypoint contains the main-module guard pattern with `execFileSync` inside the guard block, and the `verify` script uses the canonical `@motebit/verify` invocation.
- Extended `.github/workflows/release.yml`'s post-publish smoke to also exercise the `--agent` path: scaffolds, installs, builds, and imports `dist/index.js` as a module (the import would hang or fail without the main-module guard). The default-scaffold smoke remains as the first stage. Both stages run with isolated `MOTEBIT_CONFIG_DIR`s so the smoke can never affect a real motebit identity.

Migration: none. Existing agents already running locally are unaffected (they presumably have `@types/node` installed). The fix is purely scaffold-side.

---
"@motebit/crypto": patch
---

Fix tsup-bundle race that shipped a broken `@motebit/crypto@1.2.0` to npm.

Symptom: `import` of `@motebit/crypto` from a clean `npm install` (post-publish smoke test, `create-motebit` scaffold) fails with `Cannot find package '@noble/ed25519' imported from .../dist/suite-dispatch.js`. The published `dist/suite-dispatch.js` was 8.9 KB with unbundled imports instead of the expected ~100 KB tsup bundle. Confirmed by inspecting the npm tarball directly.

Root cause: race between this package's own `tsup && tsc --emitDeclarationOnly` build and other workspace packages' `tsc -b` invocations during `pnpm build` (turbo, parallel). Composite project references in `tsconfig.base.json` make `tsc -b` from any package walk into `@motebit/crypto` and recompile it. Without `emitDeclarationOnly` pinned in this package's own tsconfig, the cross-package `tsc -b` invocations emit per-file `.js` into `dist/`, overwriting tsup's bundled output. The CLI flag in `scripts.build` only takes effect when this package's own build runs — too late to protect the bundle from concurrent foreign emit.

Fix: pin `emitDeclarationOnly: true` in `packages/crypto/tsconfig.json:compilerOptions`. Now every tsc invocation against this project — including `tsc -b` from any other workspace package following references — emits `.d.ts` only, never `.js`. tsup's `dist/index.js` and `dist/suite-dispatch.js` are no longer at risk of being clobbered.

Reproduced + verified locally:

```text
# Before fix:
$ pnpm build --force
$ wc -c packages/crypto/dist/suite-dispatch.js
8942 packages/crypto/dist/suite-dispatch.js   # broken — multi-file tsc output

# After fix:
$ pnpm build --force
$ wc -c packages/crypto/dist/suite-dispatch.js
100828 packages/crypto/dist/suite-dispatch.js  # correct — tsup bundle
$ grep -c "^import" packages/crypto/dist/suite-dispatch.js
0                                              # zero unbundled imports
```

Other published packages reviewed in the same pass: only `@motebit/crypto` and `motebit` (CLI) use tsup. The CLI declares its externalized deps in `package.json:dependencies` and is structurally fine. No other publishables affected.

Followup gate candidate: lint `packages/*/tsconfig.json` against `package.json:scripts.build` — if `build` invokes tsup, `tsconfig.json:compilerOptions.emitDeclarationOnly` must be `true`. Would have caught this before publish.

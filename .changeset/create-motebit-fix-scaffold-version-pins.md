---
"create-motebit": patch
---

Fix scaffold-emitted version pins for `@motebit/sdk` and `motebit`. The
1.1.0 release shipped a misconfigured tsup constant: `__VERIFY_VERSION__`
was misnamed (the variable read `@motebit/crypto`'s version, not
`@motebit/verify`'s) and was reused for three packages on different
release cadences. After the 2026-04-27 release: `@motebit/crypto` minor
to 1.1.0, `@motebit/sdk` patch to 1.0.1, `motebit` patch to 1.0.1 — but
the scaffold emitted `^1.1.0` for all three. `npm install` failed with
`ETARGET No matching version found for @motebit/sdk@^1.1.0` — the
post-publish smoke test caught this immediately.

Replaces the single misnamed `__VERIFY_VERSION__` constant with three
correctly-named per-package constants (`__CRYPTO_VERSION__`,
`__SDK_VERSION__`, `__MOTEBIT_VERSION__`) read from each package's
`package.json` at tsup-build time. Each scaffold-emitted dep now pins
the actual published version of the package it names.

Verified: `node create-motebit dist/index.js test-agent --agent --yes`
produces `package.json` with `@motebit/sdk: ^1.0.1` and
`motebit: ^1.0.1` (matching what shipped). `npm install` in the
scaffolded project resolves cleanly.

Adds `@motebit/sdk` and `motebit` to create-motebit's devDependencies
(`workspace:*`) so the tsup build can `require.resolve` them
deterministically across pnpm workspace hoisting variations.

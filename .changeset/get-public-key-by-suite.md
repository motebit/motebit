---
"@motebit/crypto": minor
"motebit": patch
---

`getPublicKeyBySuite(privateKey, suite)` — new permissive-floor (Apache-2.0) primitive for suite-dispatched public-key derivation. Closes a real protocol-primitive-blindness violation in the CLI and plugs the regex hole that let it slip past `check-suite-dispatch`.

A surface-parity audit on 2026-04-18 found that `apps/cli/src/subcommands/delegate.ts` was calling `ed.getPublicKeyAsync(privateKey)` directly via dynamic import — protocol-primitive-blindness as defined in `feedback_protocol_primitive_blindness.md` and the `@motebit/crypto/CLAUDE.md` Rule 1 ("`src/suite-dispatch.ts` is the ONLY file permitted to call `@noble/ed25519` primitives directly"). The violation slipped past `check-suite-dispatch` because its FORBIDDEN_PATTERNS regex `/\bed\.getPublicKey\b/` does not match `ed.getPublicKeyAsync` — `\b` requires a word/non-word transition, and `K` followed by `A` (both word chars) is not a boundary.

This pass:

- **`getPublicKeyBySuite(privateKey: Uint8Array, suite: SuiteId): Promise<Uint8Array>`** added to `packages/crypto/src/suite-dispatch.ts`. Sibling to `verifyBySuite` / `signBySuite` / `generateEd25519Keypair` — same exhaustive switch on the `SuiteId` literal union so the TypeScript compiler refuses to compile when ML-DSA / SLH-DSA suites land without an explicit arm. Re-exported through `signing.ts` so it surfaces from `@motebit/crypto`.
- **Permissive export allowlist updated.** `getPublicKeyBySuite` added to `PERMISSIVE_ALLOWED_FUNCTIONS["@motebit/crypto"]` in `scripts/check-deps.ts`.
- **CLI delegate path routed through the dispatcher.** `apps/cli/src/subcommands/delegate.ts` now imports `getPublicKeyBySuite` from `@motebit/crypto` instead of dynamically importing `@noble/ed25519`. PQ-ready by construction — when ML-DSA suites land, only the dispatcher arm changes. `apps/cli/package.json` declares `@motebit/crypto` directly (was previously consumed only transitively through `@motebit/runtime`).
- **Regex hole patched.** `scripts/check-suite-dispatch.ts` adds `\bed\.getPublicKeyAsync\b` to FORBIDDEN_PATTERNS and tightens the existing `\bed\.getPublicKey\b` to `\b...\b(?!Async)` matching the established convention used by `verify` / `sign` (every primitive name has both a sync rule and an explicit Async rule). The next time anyone tries to call `ed.getPublicKeyAsync` outside the dispatcher, CI fails immediately.

The Ring 1 doctrine ("capability, not form") is unchanged — surfaces correctly continue to consume crypto through `@motebit/encryption` (which re-exports from `@motebit/crypto`) where appropriate. Adding `check-surface-primitives` to mandate dep declarations was considered and rejected: the existing `check-suite-dispatch` already covers the real failure mode (direct `@noble` calls); the dep-declaration question is style, not architecture.

# @motebit/crypto

Sign and verify every Motebit artifact. MIT, Layer 0, **zero monorepo dependencies**. `@noble/ed25519` is bundled.

## Rules

1. **`src/suite-dispatch.ts` is the ONLY file permitted to call `@noble/ed25519` primitives directly.** `check-suite-dispatch` enforces this across `packages/crypto/`, `services/`, and `apps/`. Every verifier routes through `verifyBySuite`.
2. **Explicit escape hatches use a named waiver.** `// crypto-suite: intentional-primitive-call` on the same line exempts a single call (reviewer-gated). Don't waive broadly.
3. **Missing or unknown `suite` values are rejected fail-closed.** No legacy-no-suite acceptance path. Adding a new suite means a new `SuiteId` entry in `@motebit/protocol` and a new dispatch arm here.
4. **Self-verification is the contract.** A third party must be able to verify any Motebit artifact (identity file, execution receipt, credential, credential anchor, revocation, succession) with only this package and the signer's public key. No relay contact, no external system required.
5. **MIT purity.** No imports from BSL packages. `check-deps` enforces.

Post-quantum migration (ML-DSA-44, ML-DSA-65, SLH-DSA) is a new `SuiteId` plus a new dispatch arm — not a wire-format break. The protocol plane is crypto-agile; rails that happen to share Ed25519 (e.g. Solana) are coincidental and remain their own concern.

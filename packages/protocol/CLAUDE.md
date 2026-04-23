# @motebit/protocol

The open protocol surface. Apache-2.0 (permissive floor), Layer 0, **zero monorepo dependencies**.

## Rules

1. **No I/O, no algorithms that bind the runtime.** Export only types, enums, branded ID casts, constants, and deterministic math (semiring algebra, canonical JSON, hash primitives). If an export decides, adapts, routes, prioritizes, governs, or stores anything, it belongs in BSL — not here.
2. **`check-deps` enforces permissive-floor purity.** Imports from BSL packages are a CI failure. New non-trivial function exports must be added to `PERMISSIVE_ALLOWED_FUNCTIONS` in `scripts/check-deps.ts` with review justification.
3. **Spec Wire format types live here.** Every type named under a `#### Wire format (foundation law)` subsection in any `spec/*.md` must be exported from this package. `check-spec-coverage` enforces the mapping.
4. **Cryptosuite registry is law.** `SuiteId` in `src/crypto-suite.ts` is a closed string-literal union. Adding a suite is additive (new entry + new dispatch arm in `@motebit/crypto`). Renaming or removing one is a wire-format break.
5. **Interfaces at this layer are the interoperable contract.** `SettlementRail`, `GuestRail`, `SovereignRail`, `ChainAnchorSubmitter`, `CredentialSource`, `ServerVerifier` — a third party building an alternative implementation binds to these, not to BSL.

Details on the three-layer model (permissive floor / BSL / accumulated state), the operational test, and protocol-shaped events: [`docs/doctrine/protocol-model.md`](../../docs/doctrine/protocol-model.md).

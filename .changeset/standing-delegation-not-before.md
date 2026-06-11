---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

standing-delegation v1.1 — optional `not_before` on `DelegationToken` makes pre-minting honest.

agency, building standing monitors on `standing-delegation@1.0`, surfaced a real gap: a sovereign delegator (passkey-gated seed) can't sign per-tick tokens at tick time, so the conformant pattern is **pre-minting** — sign every cadence slot's token at grant-creation. But `DelegationToken` had no activation field and `verifyDelegation` checked only `expires_at`, so a future-windowed pre-minted token verified **early** — offline, a slot's token was indistinguishable from one minted at its slot.

Fix (additive, fully backward-compatible — 1.0 tokens replay identically):

- `@motebit/protocol`: `DelegationToken` gains an optional `not_before` (Unix ms).
- `@motebit/crypto`: `verifyDelegation` rejects when `now < not_before` (gated under `checkExpiry`, so historical chain verification skips it like expiry). `@motebit/wire-schemas` zod + regenerated `spec/schemas/delegation-token-v1.json`.
- Spec: `standing-delegation-v1.md` §1/§4 reframed — the per-tick token is **signed by the delegator** (the prose said "the delegate mints"; the code rejects delegate-signed ticks, so the prose was the drift), pre-minting is the documented v1.0 model, and cadence is bound cryptographically by the signed token set rather than demoted to a rate-limit. `market-v1.md` §12.1 gains the `not_before` field + verification step.

Holder-side (delegate-signed) minting stays a deliberate **non-goal in v1.0** — agency's doctrine-grounded call: for a receipts-over-trust product, keeping cadence cryptographic beats deleting pre-mint code. A future version MAY add it behind an explicit trigger.

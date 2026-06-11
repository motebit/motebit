---
"@motebit/protocol": minor
---

Land `seed-escrow@1.0` — durability without custody.

A `SeedEscrowPayload` is an identity's Ed25519 seed, AES-256-GCM-encrypted under a key only the owner's authenticator can reproduce (v1: a WebAuthn passkey's PRF output), parked with a custodian that is **structurally unable to open it**. Escrow, not custody — restore is relay-optional, exactly as the identity doctrine requires. The sibling of `KeyTransferPayload`: transfer moves a key between parties under key agreement; escrow parks a seed with a custodian under an authenticator-held secret (no X25519 ephemeral, `kdf` as a closed registry, same `identity_pubkey_check` post-decryption verification).

Forced by agency (Q2), who run it in production (`apps/app/lib/passkey.ts`).

Adds:

- `@motebit/protocol`: the `SeedEscrowPayload` type.
- `@motebit/wire-schemas` (private): zod schema + committed `spec/schemas/seed-escrow-payload-v1.json` (parity-locked, drift-tested).
- `spec/seed-escrow-v1.md`.

Unsigned by design — integrity is the AES-GCM tag, correctness is the mandatory `identity_pubkey_check`, and placement is authenticated by `signed-request-envelope@1.0` (the two compose; no signing primitive). "Escrow, not custody" is enforceable foundation law: a custodian that can decrypt its escrows is in protocol violation, and conformance requires demonstrating it can't. The fresh-device restore anchor is the identity registry / key-transparency log, not the payload's self-asserted `identity_pubkey_check` (review note folded into §6).

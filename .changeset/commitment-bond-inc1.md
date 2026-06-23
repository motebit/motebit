---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Commitment bond — the `BondCommitment` wire artifact + verifier (commitment-bond doctrine, phase 1 Inc 1).

A commitment bond is an agent's OWN sovereign capital, posted as a self-signed proof-of-funds and RPC-verified by the relay, never custodied. **Phase 1 is an anti-sybil staked _signal_, NOT collateral / escrow / recourse** — honest naming is load-bearing; the recourse half (`BondCall` / `BondDefault`) is deferred-with-trigger.

`@motebit/protocol`:

- `BondCommitment` — the signed wire type (`motebit/bond@1.0`): `bonded_public_key` + `bonded_address` + `bond_amount_micro` + `asset` + `chain` (CAIP-2) + `issued_at`/`expires_at`. `BOND_COMMITMENT_SPEC_ID` pins the family; `isBondCommitment` is a structural guard (shape only — NOT signature or binding validity).

`@motebit/crypto`:

- `signBondCommitment` / `verifyBondCommitment` (+ `BOND_COMMITMENT_SUITE`). The bond is **self-anchoring**: signed by `bonded_public_key`, which IS the bonded address. `verifyBondCommitment` takes no external key and enforces, fail-closed, **the load-bearing anti-sybil binding** — `bonded_address` MUST equal `base58btc(bonded_public_key)` (the Solana address derivation, computed inside `@motebit/crypto` with zero monorepo deps). So one wallet cannot back many identities. Binding the bond to a claimed `motebit_id` (the key→id check) stays the verifying relay's separate responsibility (the `verifySovereignBinding` shape).

The binding cannot be silently removed: `check-bond-address-binding` (drift invariant #132) locks the type fields, the verifier's fail-closed enforcement, and the `spec/bond-v1.md` §2 foundation law together. The bond is an additive eligibility input, never a new `SettlementMode`. Doctrine: `docs/doctrine/commitment-bond.md`.

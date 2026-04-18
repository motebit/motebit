---
"@motebit/api": minor
---

Sign every per-task SettlementRecord at the relay (audit follow-up
#1, relay integration). The protocol-layer primitive shipped in
the prior commit; this commit makes the relay actually use it.

## What changed

- **Migration v13** (`relay_settlements_signature_columns`): adds
  three nullable columns to `relay_settlements` —
  `issuer_relay_id`, `suite`, `signature`. Backward-compat: rows
  written before this migration carry NULL signatures and remain
  in place.
- **`tasks.ts` settlement INSERT sites** (3 of them: main relay
  settlement, multi-hop sub-settlement, P2P audit settlement):
  call `signSettlement(...)` from `@motebit/encryption` with the
  relay's private key, persist `issuer_relay_id`/`suite`/
  `signature` alongside the existing columns.

Going forward, every emitted SettlementRecord carries a signature
committing the relay to the exact (amount_settled, platform_fee,
platform_fee_rate, status) tuple. A relay that issues
inconsistent records to different observers fails self-attestation:
at most one of the records verifies (delegation-v1.md §6.4).

## Concurrency footgun caught + named

`signSettlement` is async (Ed25519 over canonical bytes). The
naive placement — `await` inside the `BEGIN`/`COMMIT` block — let
concurrent receipts interleave their transactions, corrupting
INSERT-OR-IGNORE semantics. Only 1 of 5 settlements landed in
the money-loop-concurrency test on first attempt.

Fix: pre-compute the signature OUTSIDE the synchronous
transaction. The signature only depends on body fields known
before BEGIN; lifting it preserves transaction atomicity.
Comments at each site name this concurrency invariant for future
maintainers. Caught by the existing
`money-loop-concurrency.test.ts` "concurrent settlements
crediting same worker" suite.

## Closes the doctrinal commitment

`services/api/CLAUDE.md` rule 6: "Every truth the relay asserts
(credential anchor proofs, revocation memos, settlement receipts)
is independently verifiable onchain without relay contact."
Federation settlements deliver this through Merkle batching +
onchain anchoring (relay-federation-v1.md §7.6); per-agent
settlements now deliver it through embedded signatures. Future
work could add Merkle batching for per-agent settlements too —
this commit ships the floor (signature), not the ceiling
(anchoring).

All 862 relay tests pass; all 16 drift defenses green.

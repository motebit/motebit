---
"@motebit/wire-schemas": patch
---

Fix forward-compatibility on the six unsigned wire envelopes —
audit drift #1 from the cross-plane review.

The spec mandates "unknown fields MUST be ignored (forward
compatibility)" (delegation-v1 §3.1, applied across unsigned
envelopes). Six of the published schemas were emitting
`additionalProperties: false`, which inverts the contract: a v1
verifier would REJECT a v2 payload with new fields instead of
ignoring them.

Flipped to `.passthrough()` (emits `additionalProperties: true`):

- AgentTask
- AgentServiceListing
- AgentResolutionResult
- SettlementRecord
- RouteScore
- CredentialAnchorProof

The other 16 schemas correctly remain `.strict()` because they're
**signed wire artifacts** — the bytes are canonicalized and the
signature commits to those exact bytes. A v2 of a signed artifact
ships a new SuiteId; v1 verifiers reject the unknown suite
fail-closed before the unknown-field question is reached. So
strict-mode there enforces the canonical-bytes invariant.

Inner closed protocol surfaces (`sla` / `pricing[]` items in
AgentServiceListing, `sub_scores` in RouteScore, the chain `anchor`
in CredentialAnchorProof) keep `.strict()` — those are
protocol-defined value sets that need explicit versioning, not
silent forward-compat.

The cross-plane audit also flagged "suite literal pinned" as a
potential drift. **Not actually a drift on principal-engineer
review:** each artifact's TS type pins one literal SuiteId, and
cryptosuite agility means new suite + new artifact (or widened
literal in the TS type), not "this artifact accepts any suite."
Widening to `z.enum(SUITE_REGISTRY keys)` would let an
ExecutionReceipt claim it was signed with `eddsa-jcs-2022` (the VC
suite) — incorrect. Literal-per-artifact is the right shape and
matches the TypeScript source of truth.

Three protocol-level findings from the audit remain open as
upstream issues (NOT addressed here — they require @motebit/protocol
type changes + spec discussion):

1. SettlementRecord is unsigned (relay can rewrite settlement
   history undetectably)
2. RouteScore is unsigned (routing transparency is a UX hint, not
   a binding claim)
3. AdjudicatorVote does not bind to dispute_id (replay risk: a
   vote signed for one dispute could be stuffed into another)

Tracked separately for principal-engineer review.

Drift defense #22 (zod ↔ TS ↔ committed JSON Schema) catches the
roundtrip; signed schemas remain bit-for-bit identical to before
this change.

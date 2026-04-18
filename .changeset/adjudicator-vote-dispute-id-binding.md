---
"@motebit/protocol": major
"@motebit/wire-schemas": minor
---

Add `dispute_id` to `AdjudicatorVote`. The signature now covers
`dispute_id`, preventing vote-replay across disputes.

Closes audit finding #3 from the cross-plane review. The previous
shape (no `dispute_id` in the signed body) meant a vote signed for
dispute A could be replayed verbatim into dispute B's
`adjudicator_votes` array. Foundation law §6.5 calls for individual
per-peer votes for federation auditability — without dispute_id
binding, a malicious adjudicator collecting old votes from other
disputes could stuff them into a new resolution and the per-vote
signatures would still verify.

Zero current production impact: no production code today signs or
verifies AdjudicatorVote (no `signAdjudicatorVote` /
`verifyAdjudicatorVote` in `@motebit/crypto`), and the relay's
production dispute code hardcodes `adjudicator_votes: []` for
single-relay adjudication. This is a forward-design fix, shipped
before federation adjudication ships so the wire format is
replay-safe from day one rather than carrying migration debt.

## Migration

`AdjudicatorVote.dispute_id` is now a required field in the wire
format. Any consumer constructing an `AdjudicatorVote` must add it:

```diff
 const vote: AdjudicatorVote = {
+  dispute_id: "<dispute UUID this vote applies to>",
   peer_id: "<federation peer motebit_id>",
   vote: "upheld",
   rationale: "...",
   suite: "motebit-jcs-ed25519-b64-v1",
   signature: "<base64url Ed25519 over canonical JSON of all fields except signature>",
 };
```

Signers MUST include `dispute_id` in the canonical body before
computing the Ed25519 signature. Verifiers reconstructing the
canonical bytes MUST include `dispute_id` for the signature to
verify.

No database migration needed (single-relay adjudication writes
`"[]"` to `relay_dispute_resolutions.adjudicator_votes` in the
relay; federation adjudication is not yet shipped). Future
federation adjudication implementations consume the new shape from
day one.

Spec: `spec/dispute-v1.md` §6.4 wire format updated; §6.5 foundation
law adds the binding requirement.

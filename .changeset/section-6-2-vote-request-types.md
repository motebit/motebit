---
"@motebit/protocol": minor
---

Wire-format additions for §6.2 federation dispute orchestration (`relay-federation@1.2` §16, `dispute-v1` §6.4 + §6.5 + §8.3).

Two changes, both additive at the package level:

```ts
// AdjudicatorVote — new field
interface AdjudicatorVote {
  dispute_id: string;
  round: number; // NEW — 1 for original, 2 for §8.3 appeal
  peer_id: string;
  vote: DisputeOutcome;
  rationale: string;
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

// VoteRequest — new type (leader-to-peer fan-out body for §16)
interface VoteRequest {
  dispute_id: string;
  round: number;
  dispute_request: DisputeRequest;
  evidence_bundle: DisputeEvidence[];
  requester_id: string;
  requested_at: number;
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}
```

`AdjudicatorVote.round` is signature-bound per `dispute-v1.md` §6.5 + §8.3 — round-1 vote bytes do not satisfy round-2 binding even for the same evidence. Cross-round vote replay is cryptographically rejected, not enforced by leader bookkeeping. The §8.3 round-isolation property holds at the wire-format level.

`VoteRequest` carries the leader's signature over `canonicalJson(body minus signature)`, binding `dispute_id`, `round`, `requester_id`, and the evidence bundle.

Sibling consumers updated:

- `@motebit/wire-schemas` regenerated `adjudicator-vote-v1.json` + new `vote-request-v1.json`
- `@motebit/crypto`'s `signAdjudicatorVote` / `verifyAdjudicatorVote` already operate on `canonicalJson(body)`, so the new field is bound automatically without primitive changes — sibling test added (`verify-artifacts.test.ts`) for the round-binding invariant
- `services/relay/src/federation.ts` adds the `POST /federation/v1/disputes/:disputeId/vote-request` peer-side handler
- `dispute-v1.md` stays at @1.0 Draft per the convention (Draft accumulates additive normative changes without bump)
- `relay-federation-v1.md` H1 bumps 1.1 → 1.2 + new §16

No existing in-the-wild `AdjudicatorVote` consumer is broken by the new required `round` field — federation orchestration was 409-blocked under the §6.5 self-adjudication guard prior to this arc; the type existed but no one was producing or consuming the wire artifact. Minor bump rather than major reflects the empty-shipped-consumer-set + Draft-spec-status combination; if a downstream pinned to the pre-round shape, this would have been major.

---
"@motebit/crypto": minor
"@motebit/encryption": minor
---

Add `signDisputeRequest` / `verifyDisputeRequest`, `signDisputeEvidence` /
`verifyDisputeEvidence`, and `signDisputeAppeal` / `verifyDisputeAppeal`
primitives to `@motebit/crypto` (re-exported through `@motebit/encryption`).

Each follows the `signAdjudicatorVote` / `signDisputeResolution` shape:
the signer owns `signature` and `suite`; the verifier fail-closes on
unknown suite, base64url decode error, and primitive verification
failure. The associated suite constants (`DISPUTE_REQUEST_SUITE`,
`DISPUTE_EVIDENCE_SUITE`, `DISPUTE_APPEAL_SUITE`) are added alongside
and currently equal `motebit-jcs-ed25519-b64-v1`.

Motivation: the relay now enforces spec/dispute-v1.md §4.2 + §5.2 + §8.2
foundation law that every dispute artifact MUST be signed by its
authoring party. Previously these were inline `c.req.json<{…}>()`
construction inputs at `services/api/src/disputes.ts`; without the
signature binding the relay could not verify foundation law §4.4
("filing party must be a direct party to the task"). Third parties
implementing motebit/dispute@1.0 now have the canonical sign + verify
recipes available in MIT-licensed `@motebit/crypto` with zero monorepo
dependencies.

### Migration

```ts
import { signDisputeRequest } from "@motebit/encryption"; // or @motebit/crypto

const signed = await signDisputeRequest(
  {
    dispute_id: "dsp-uuid-v7",
    task_id,
    allocation_id,
    filed_by,
    respondent,
    category,
    description,
    evidence_refs,
    filed_at,
  },
  filerPrivateKey,
);
// POST signed → /api/v1/allocations/:allocationId/dispute
```

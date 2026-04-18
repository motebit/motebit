---
"@motebit/wire-schemas": minor
---

Publish the dispute cluster — five wire schemas in one commit, the
full exception-handling subsystem:

- `dispute-request-v1.json` — filing party opens a dispute on a task
- `dispute-evidence-v1.json` — either party submits cryptographically-
  verifiable evidence
- `adjudicator-vote-v1.json` — federation peer's signed vote
- `dispute-resolution-v1.json` — adjudicator's signed verdict + fund
  action + per-peer votes (federation case)
- `dispute-appeal-v1.json` — losing party's one-shot appeal

Why this matters: a dispute resolution MUST be auditable by external
observers, otherwise "the relay decided" becomes "the relay self-
justified." With these schemas, an external auditor (or a future you)
can fetch the artifacts, verify every signature, and check the
resolution's structural soundness against the protocol — without
trusting the adjudicator's word.

Foundation law §6.5 enforced at the type layer:

- DisputeResolution carries `adjudicator_votes: AdjudicatorVote[]`
  for federation cases — aggregated-only verdicts are rejected at
  the schema layer
- Resolution rationale is non-optional (§6.5: opaque verdicts are
  rejected)
- DisputeRequest requires ≥1 evidence_ref at filing time (§4.4:
  disputes without evidence are noise)

Drift defense #23 waiver count: 12 → 7. **17 schemas shipped.**

Cluster shape proven again: subsystem-batch with leaf factories
(suite, signature) keeps each emitted JSON Schema property its own
inline object, so descriptions survive zod-to-json-schema's $ref
collapse pass — same architectural lesson learned in the migration
cluster commit.

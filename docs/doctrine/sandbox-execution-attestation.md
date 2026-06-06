# Sandbox execution attestation — design/scoped, deferred to a producer arc

**Status: trust model proven (prototype), shape discovered (repo), wire format deferred to a deliberate producer arc.** This is the governed-execution analogue of the receipt: a way to prove an action ran inside motebit's governed sandbox — not the agent's word for it. Same discipline as [`evals-as-attestations.md`](evals-as-attestations.md) and [`privileged-atoms.md`](privileged-atoms.md): the design is locked, the wire primitive waits for its forcing function.

## The need (consumer-forced, present)

agency.computer wants to honestly surface **governed/sandboxed execution** — one of its five pillars, and motebit's "governance at the boundary" thesis. The `ExecutionReceipt` carries `status` (completed/failed/denied) and `tools_used`, but nothing that proves an action ran in the governed sandbox. agency, the live external consumer (see [`agency-proof-integration.md`](agency-proof-integration.md)), forces the **need**. It does not force the **shape** — the producer does (below).

## The trust model (proven by prototype — keep)

A `sandboxed: true` boolean the **agent** signs is theater: a compromised agent just sets it — same epistemic weight as `result`. Forbidden, the same way a self-asserted identity is integrity-only, not bound ([`identity-binding-verification.md`](identity-binding-verification.md)).

The honest model is **co-signature**: the sandbox is a **separate trust domain** with its own Ed25519 key that vouches "this execution ran in me." A verifier checks that signature against a **pinned/published** sandbox attestor key — exactly the hierarchical pattern hardware attestation already uses ([`hardware-attestation.md`](hardware-attestation.md): the attestor key attests the identity key, never replaces it). A throwaway prototype proved this end-to-end against a real sovereign fixture: co-signature verifies against the pinned attestor key → `SOVEREIGN + SANDBOX-ATTESTED`; a tampered attestation fails; a forge signed by a _different_ key fails ("not the pinned attestor"). The model stands and needs **no change to `ExecutionReceipt`**.

## Separate artifact, not a receipt field

The attestation is its **own signed artifact that references the receipt**, never a field inside `ExecutionReceipt`. Why:

- **Backward-compatible** — the frozen receipt wire format doesn't change; no churn across every gate/consumer/the Python reference.
- **Composable** — multiple attestors (sandbox, later hardware, others) each vouch for the same execution without anyone touching the receipt. The receipt stays the agent's _account_; attestations are others' _vouches_.
- **Matches existing doctrine** — the transparency anchor and hardware attestation are already separate-but-linked, not self-set fields.

## The shape (forced by reading the producer — captured now)

Reading `services/browser-sandbox` + `packages/runtime` forced the granularity that on-paper design would have gotten wrong (the prototype guessed _task_-level):

- **browser-sandbox has no attestor identity today.** `auth.ts` only _verifies_ relay-signed tokens against the pinned relay key. An attestation requires giving it its **own** Ed25519 key — a new trust domain.
- **It is per-_session_, not per-task.** It knows `motebitId` + `session_id`; it does not know `task_id`. So it can honestly attest **"session S for motebit M ran in sandbox X,"** not "task T."
- **The receipt is produced elsewhere** — the runtime (`invoke-capability.ts`, `agent-task-handler.ts`), per task. So task-level proof is a **cross-service binding**: `sandbox_session_id → task_id → receipt`.

Therefore the locked design:

```
Sandbox attestation is a SEPARATE signed artifact (not a receipt field).
The sandbox attests SESSIONS, not tasks.
The sandbox needs its OWN Ed25519 attestor identity (a new trust domain).
The attestor key is pinned or published via operator transparency
  (/.well-known/motebit-transparency.json) — an operator-SECURITY posture decision.
Task-level proof requires a CRYPTOGRAPHIC binding:
  sandbox_session_id ↔ task_id, committed in signed material.
The honest claim is:
  "This task is linked to a session attested by sandbox X (whose key you trust)."
NOT:
  "This was provably isolated."
```

## The central open constraint the producer arc must solve

**Session→task binding integrity.** A session-level attestation _loosely joined_ to a task-level receipt (both merely referencing the same `motebit_id` over an overlapping window) would let a real sandboxed session vouch for an _unsandboxed_ task. The link must live in **signed material**: the runtime commits the `session_id` into what it signs (the receipt body or a linking artifact), and the sandbox attestation commits the same `session_id` — so a verifier confirms _this_ task rode _that_ attested session, not just that the motebit had some sandboxed session once. Getting this binding wrong is the failure mode that turns the whole attestation into theater; it is the hard part, and it is the producer arc's job.

## Bounds (honest-claim guardrails)

- **No trust-root circularity** — the trusted sandbox key comes out-of-band (pinned, or via the operator transparency declaration), never from the attestation itself.
- **No isolation overclaim** — "ran in sandbox X you trust," never "provably isolated." Recognition rooted in a key, not a proof of containment.
- **No self-asserted boolean** — forbidden; it is the theater this primitive exists to replace.

## Trigger (why the wire format waits)

Crystallize the wire format + `@motebit/crypto` primitive + `wire-schemas` JSON schema + conformance-gate coverage + agency copy **when we build the browser-sandbox attestor as a real producer** — committed deliberately, because it stands up a **new signing trust domain in the operator's security posture**, not as casual forward motion. The producer forces the final field set (per-session shape is known; policy version, isolation profile, observed-action scope are what the real sandbox can _honestly_ attest). Until then: agency keeps "sandboxed" an honest **unclaimed gap** — `tools_used` + `status` are the governance signal the receipt carries today. Promotion follows [`promoting-private-to-public.md`](promoting-private-to-public.md).

## What's proven vs deferred

| Layer                | Status                                                           | Decision            |
| -------------------- | ---------------------------------------------------------------- | ------------------- |
| Trust model          | Proven by prototype (co-signature, pinned attestor)              | Keep                |
| Shape / granularity  | Repo-revealed: per-session, sandbox-keyed, session→task bind     | Captured here       |
| Production primitive | New attestor trust domain + cross-service binding + transparency | Dedicated arc later |

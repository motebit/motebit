# PROPOSAL — relay scheduler seam (DRAFT, not committed)

**Status:** APPROVED 2026-06-10 (D1 finite+renewable, D2 signed-feed-canonical, D3 revoke-terminal, D4 push, D5 seam-only). Authorization layer (protocol types + /crypto sign/verify + tests) IMPLEMENTED in increment 1. Committed spec + wire-schemas + verifier integration + relay feed are follow-ups.
**Author:** motebit PE
**Forcing consumer:** agency (standing-monitor vertical)
**Relationship:** consumes `standing-delegation@1.0` (authorization); does NOT replace the existing per-task router

## 1. What this is and is not

The relay today is a **per-task delegation router**, not a scheduler:

- submit `POST /agent/:worker/task` (signed `task:submit` token) → relay **pushes** to the worker's registered MCP `endpoint_url` → worker returns a signed receipt. Immediate-claim only; `expires_at` TTL (10 min); **no** `scheduled_at`/cadence; **no** lease/heartbeat (a claimed tick whose worker dies TTL-expires and is dropped, never re-queued — audit Gap 2).

So the relay cannot host a "run daily until revoked" monitor today. **Agency builds the cadence trigger on their own cron — that is correct, not a workaround.** This document pins the **seam** so that when the relay grows a scheduler, agency's migration is a _re-point_, not a rewrite. It is an interface contract first; the relay implementation is a later, separate build.

## 2. The seam (what agency writes against)

Agency isolates the entire "fire one monitor tick" behind a single function whose contract is the relay's future API:

```
interface StandingMonitorScheduler {
  // Register a monitor. Today: agency-local store + cron. Later: relay-hosted.
  enqueueStanding(args: {
    grant: StandingDelegation;        // the revocable authorization root (standing-delegation@1.0)
    cadence_ms: number;               // must equal grant.cadence_ms
    worker: string;                   // target motebit_id (agency's own worker, self-delegation)
    payload_template: AgentTaskBody;  // the per-tick task minus the per-tick token
  }): Promise<{ monitor_id: string }>;

  cancelStanding(args: {
    monitor_id: string;
    revocation: DelegationRevocation; // signed; also revokes the grant on the feed
  }): Promise<void>;

  listStanding(delegator_id: string): Promise<MonitorStatus[]>;
}
```

A **tick** (whoever fires it) executes the identical path today and tomorrow:

```
1. select due (cadence elapsed since last tick, grant not revoked, grant not expired)
2. mint a per-tick DelegationToken from grant   (standing-delegation@1.0 §3)
3. submit:  POST /agent/:worker/task  with that token   ← EXISTS TODAY, unchanged
4. receive signed ExecutionReceipt
5. hash-link: receipt references prev receipt digest + grant_id (the monitor's chain)
6. ack: the tick is "done" only after the receipt is persisted+acked  (lease semantics)
```

**Only steps 1, 5, 6 differ between cron-now and relay-later.** Step 3 (the actual task submission + push-to-worker + receipt) is the existing, unchanged delegation path. That is what makes the migration a re-point: agency's `fireMonitorTick()` body keeps step 3 calling the live endpoint, and swaps steps 1/5/6 from cron+local-store to relay-driven.

## 3. What the relay scheduler adds when it lands (the Gap-2 close)

Two capabilities, both deferred to a dedicated relay build (not this proposal):

- **Cadence enqueue:** a durable `relay_standing_monitors` row (grant_id, worker, cadence_ms, next_run_at, last_receipt_digest, status) and a relay loop that selects `next_run_at <= now` and drives the tick. (Note: the relay's background-loop layer just gained a supervisor — `loop-supervisor.ts` — so a scheduler loop would be supervised from day one.)
- **Lease + heartbeat on the per-tick task:** a claimed tick carries a lease; a worker that misses its heartbeat returns the tick to `pending` instead of TTL-dropping it. This is the audit's Gap-2 fix and benefits _all_ task consumers, not just monitors.

## 4. Migration contract (the promise to agency)

If agency builds steps 1/5/6 behind `StandingMonitorScheduler` with step 3 going through the live `POST /agent/:worker/task`, then when the relay scheduler ships:

- `enqueueStanding`/`cancelStanding`/`listStanding` get a relay-hosted implementation agency swaps in,
- the per-tick **authorization** (StandingDelegation + minted DelegationToken) and **execution** (task submit + receipt) are already protocol artifacts — unchanged,
- the digest-chained receipts agency already produces become the monitor's audit trail verbatim.

No rewrite of the execution path, the authorization, or the receipt chain. Only the _trigger ownership_ moves from agency's cron to the relay.

## 5. Decisions for sign-off

- **D4 — worker topology for monitors.** Self-delegation (agency's own MCP worker, relay pushes to agency's endpoint) is the v1 path and works today. Confirm we do NOT need a pull/claim model for the seam (keeps it consistent with the existing push router).
- **D5 — does the relay scheduler get built now, or is the seam enough?** My recommendation: **ship the seam contract now (this doc → agency), defer the relay scheduler build.** Agency is unblocked by cron; the scheduler is a real arc (durable monitor store + lease/heartbeat) worth doing deliberately when a second consumer or agency's volume forces it. The seam guarantees we don't pay a rewrite for waiting.

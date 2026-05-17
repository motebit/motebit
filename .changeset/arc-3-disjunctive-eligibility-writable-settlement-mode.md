---
"@motebit/protocol": minor
---

Arc 3 of the off-ramp arc — type-level scaffolding for closing the in-flow direction of user funds. Introduces:

**`WritableSettlementMode`** — `type WritableSettlementMode = Extract<SettlementMode, "p2p">`. The asymmetric-typing enforcement shape: reads accept the full `SettlementMode` union (legacy `"relay"` rows must remain readable for audit + verifier + federation compat); writes are structurally restricted to `"p2p"`. Documents the post-Arc-3 architectural intent that new worker-settlement code should write only `"p2p"`. The Layer 1 enforcement shape is documentary at land — the type is exported and consumed at the `SettlementEligibility` result; future arcs (Arc 3.5, multi-hop-as-P2P) tighten the operational enforcement by adopting the narrow type at write sites.

**`SettlementEligibility`** evolves from `{ allowed: boolean; mode: SettlementMode; reason: string }` to a disjunctive shape:

```ts
type SettlementEligibility =
  | { allowed: true; mode: WritableSettlementMode; reason: string }
  | { allowed: false; reason: string };
```

The allowed branch carries `mode: "p2p"` (the only `WritableSettlementMode` value); the disallowed branch has no `mode` field because there's no fallback rail to route to (Arc 3 collapsed the relay-custody fallback for eligible-pair checks). Consumers that destructure `mode` must narrow via `if (result.allowed)` first — the type forces explicit handling of the disallowed case.

**Migration**: callers that read `result.mode` directly will fail to typecheck. Narrow via `if (result.allowed) { ... result.mode ... }`. Pre-Arc-3 callers that wrote `mode: "relay"` on the disallowed branch are no longer valid — disallowed has no mode field.

**Composition with prior arcs**: this is the third enforcement shape in the off-ramp arc's Layer 1 library. Arc 1 demonstrated surface deletion (`BridgeSettlementRail.withdraw` removed entirely) + marker interface (`WithdrawableGuestRail`). Arc 3 demonstrates asymmetric typing — the shape to reach for when reads must stay open but writes must be closed (legacy compat + structural future-closure). See the [`architecture_disjointness_by_construction`](../../../../../.claude/projects/-Users-daniel-src-motebit/memory/architecture_disjointness_by_construction.md) memory for the full six-shape library and the meta-principle.

**Companion** (not in changeset scope — relay is ignored): `services/relay/src/task-routing.ts` `evaluateSettlementEligibility` rewrites to the disjunctive form with established-pair branch (trust ≥ 0.6 AND interactions ≥ 5) OR new-pair branch (`delegatorAcknowledgesNoHistoryRisk` parameter). `services/relay/src/tasks.ts` task-submission payload gains optional `delegator_acknowledges_no_history_risk?: boolean` field that flows through to the eligibility check. The disjunctive gate solves the cold-start problem (new workers with no trust history) via explicit delegator consent rather than weakening the trust algebra with a free-starting-trust hack — see [`trust_as_economic_membrane`](../../../../../.claude/projects/-Users-daniel-src-motebit/memory/trust_as_economic_membrane.md) for the structural-floor-plus-economic-ceiling pattern.

**Arc 3.5 deferred**: the operational submission gate (`TASK_P2P_PROOF_REQUIRED` — reject paid direct delegation without payment_proof) was prototyped during Arc 3 implementation but rolled back because it breaks 32 existing E2E tests that exercise the relay-custody path as legacy contract. Migrating the test suite + production delegator clients to construct P2P payment_proofs for every paid direct delegation is its own bounded arc (Arc 3.5). Until then, paid direct delegation can still use the relay-custody path; new delegator clients SHOULD prefer P2P but aren't structurally required to. The structural enforcement at the protocol type level is in place; the submission-boundary enforcement lands in Arc 3.5.

Doctrine: [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) § "Arc 3 scope and Arc 3.5 deferred" + "Arc 3 carve-outs."

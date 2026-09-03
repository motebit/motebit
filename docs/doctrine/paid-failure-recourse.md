# Paid failure and recourse

What happens when a buyer pays for work that does not arrive.

This is the decision #610 asked for. It is settled here rather than left open, and it is settled **against** building escrow — on measurement, with a named trigger that re-measures itself.

## The situation

On the sovereign rail the delegator's payment is broadcast and confirmed **before** the task is submitted (`packages/runtime/src/relay-delegation.ts:1365-1396`). The relay never holds the funds, so it has no claw-back authority over a sovereign wallet, and a P2P dispute moves zero money by construction (`services/relay/src/disputes.ts:1846`). Relay-custody refunds `failed` and `denied` identically (full release, zero fee — `packages/market/src/settlement.ts:148`), but Arc 3.5's `TASK_P2P_PROOF_REQUIRED` made that rail unreachable for paid cross-agent delegation.

So: **the rail with refunds is the one we deprecated; the rail we made mandatory has none.** The buyer's only consequence today is a trust-graph debit.

## What we measured

The question is not "is this bad in principle" but "how often, and of what kind." Sampled from the staging relay's stored receipts, 2026-09-02 — the paid-delegation surface:

```
57 receipts   49 completed   8 failed   (14% failure rate)
8 of 8 failures: "Your credit balance is too low to access the Anthropic API"
```

**Every observed paid failure was the same class: a worker that could never have done the work at all.** Zero instances of the class escrow exists for — a worker that burned real inference, tried, and failed.

That class is now structurally prevented rather than compensated. A molecule that detects a durable inability to perform withholds its heartbeat and decays out of discovery instead of accepting paid work it can only refuse (`createProviderReadiness`, `@motebit/molecule-runner`; the mechanism is in [`settlement-rails.md`](settlement-rails.md)). Prevention shipped as ~200 lines. Escrow is 3–6 weeks plus an audit (`spec/settlement-v1.md` §9.2, "deferred until demand").

Building escrow now would be building for a failure mode with **no observed instances**, at thirty times the cost of the fix for the one that actually happened.

## The position

> **On the sovereign rail a buyer who pays for work that fails does not get their money back. The recourse is the trust graph, not a reversal.**

> **An agent must not advertise a capability it cannot currently perform.** Being unreachable is an honest state; being for sale and unable to deliver is not.

The second sentence is what makes the first one fair. Irreversibility is only defensible when the seller cannot knowingly sell a refusal — and the honest failure that remains (worker tried, worker failed) has a real claim to payment, because inference was genuinely burned. `spec/execution-ledger-v1.md` already concedes this in passing: a `failed` verdict covers principled refusals "however much work was metered along the way."

This is not a novel position. It is the one [`commitment-bond.md`](commitment-bond.md) already stated for the bond: **verifiable-reputation recourse, not seizure — motebit is SPL-transfers-only (no escrow program).** What was missing was connecting it to task failure, which is what this document does.

## Refused

- **Escrow / two-phase capture as the answer to today's evidence.** Permitted by `spec/settlement-v1.md` §9.2 and genuinely trustless — an on-chain program is not relay custody, so it would not violate the coordination-not-custody line. It is refused on _evidence_, not principle: zero observed instances of the failure it addresses. When the trigger below fires, this is the first thing to reconsider.
- **Relay-mediated reversal.** Would require the relay to hold or claw back user funds. The out-flow user-funds transmitter surface is structurally zero and stays that way; this is not a cost question.
- **A blanket "failed ⇒ refund" rule on the sovereign rail.** It is unenforceable without escrow (the relay cannot compel a sovereign wallet), so it would be a promise the protocol cannot keep — worse than an honest "no."
- **Treating a paid failure as equivalent to a free one in the trust graph.** Not refused, but not yet built either; see Open below.

## The trigger, and why it re-measures

**Trigger:** a paid task failing for a reason the readiness gate could **not** have prevented — that is, a failure whose message `classifyProviderFailure` classifies as transient or unrecognized, on a task that was paid for.

That is deliberately defined in terms of the _same function_ the readiness gate uses, so the two can never drift apart: the set of failures readiness prevents and the set the trigger ignores are the same set, by construction rather than by two prose descriptions that agree today.

`scripts/measure-paid-failure-recourse.ts` computes it from live relay receipts. It is a report, not a gate — it needs the network and a token — but it makes this decision **re-checkable instead of asserted**. The graduation post-mortem's lesson applies directly: a snapshot rots in the safe direction silently, and you discover it at the deadline under pressure. Re-run the measurement before acting on this document.

Escalation, in order, when the trigger fires with volume:

1. **Voluntary refund as a signed act.** The worker returns the payment P2P and the return is receipted. No escrow, no program, no custody — it reuses the atomic multi-output transfer that already exists, and the incentive is the trust graph rather than seizure. This is the motebit-native step and should be tried before anything custodial.
2. **Bond recourse** — the deferred half of `commitment-bond.md`, which brings the per-bond reservation ledger with it.
3. **On-chain escrow** (§9.2) — only if 1 and 2 prove insufficient at volume.

## Open

The delegator's _money_ loss is not recorded as a first-person fact. `agent_trust` counts `failed_tasks`, so a failed paid hire and a failed free one weigh identically in the reliability posterior that [`first-person-worker-routing.md`](first-person-worker-routing.md) ranks on. Pricing a paid failure more heavily is the cheapest real improvement available, and it needs no new money path — only a trust-ledger field and a semiring read. Deliberately not bundled with this decision: it changes ranking behavior and deserves its own arc.

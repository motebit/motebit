# CHECKPOINT — Standing-Delegation Money Execution, Inc 1→2 human sign-off

**Status:** SIGNED OFF 2026-07-04 — all four decisions (D1 relay-coordinated v1 / D2 semantics ratified, USD-micro pinned / D3 `spend_ceiling` @1.2 additive field / D4 settlement-time revocation + 7–30d money-grant lifetime) approved by Daniel Hakim as recommended. Inc 3a (wire: `spend_ceiling` @1.2 + relay delegation-revocation cache) shipped same day; Inc 3b (wiring) is next.
**Author:** motebit PE (grounded audit 2026-07-04, main @ `1a7f7132`)
**Composes with:** [`standing-delegation-v1.md`](standing-delegation-v1.md) (APPROVED 2026-06-10), `spec/standing-delegation-v1.md` (Draft), [`memory-never-confers-authority.md`](../doctrine/memory-never-confers-authority.md), [`verify-family-fail-closed.md`](../doctrine/verify-family-fail-closed.md)

## 0. Grounded state (what is true on main today)

The R4 autonomous-money pipe is **fully coded, tested end-to-end, and dormant at two independent layers**:

1. `verifyGrantForTurn` (`packages/runtime/src/grant-verifier.ts:46`) — the sole producer of `TurnContext.verifiedGrant` (gate `check-money-authority`) — has **zero production callers**. Policy-gate step 8b (`packages/policy/src/policy-gate.ts:385-402`) therefore forces approval on every R4 call. No config switch exists for this branch; that is the invariant.
2. Even where the gate would clear, `evaluateBlastRadius` (`packages/policy/src/grant-blast-radius.ts:177`) denies `ceiling_absent` because **no grant carries a spend ceiling** — `GrantSpendCeiling` is not a wire field yet.

The hard-zero dry-run (#225, `packages/runtime/src/__tests__/standing-delegation-dry-run.test.ts`) proves the full chain reachable with real crypto — grant → token → `verifyGrantForTurn` → gate 8b → enforcer — and proves `gate-allow ∧ enforcer-allow = false` today. Frontends cannot assert `verifiedGrant` over the wire (`runtime-host/src/safe-options.ts` strips it structurally).

**What is structurally missing for live money (Inc 3 scope):** (a) a live caller extracting token+grant+revocations at the delegated-task ingress and threading `verifiedGrant` into `sendMessageStreaming`; (b) a persistent grant store + revocation plumbing; (c) a persistent atomic `GrantSpendStore` (only in-memory exists; needs `appendWithClock`-class atomicity); (d) the signed ceiling on the wire (Axis 3); (e) the dispatch AND-composition — `tryConsume` between gate-clear and money-move, with `MoneyAction` extracted from the real tool call; (f) the actual rail execution.

---

## Axis 1 — Threat model

**What the vault protects (as shipped, post external-review correction `ec3959d6`):** the decomposition attack (one large payment salami-sliced across turns) on the **trusted-runtime / online path only** — honest-but-fallible runtime, runaway loop, prompt injection that does not compromise the key or the store.

**What it explicitly does NOT protect:** a malicious **offline** delegate. Minting is a local signature under the grant, so an offline adversary manufactures fresh short-TTL tokens from stale standing authority until `expires_at`, and controls its own `GrantSpendStore` (simply never commits). Offline ceilings are: grant expiry, counterparty-side enforcement, onchain rate caps (`spec/settlement-v1.md`). The freshness staple (OCSP-style) and epoch-root accumulators are designed-deferred in `verify-family-fail-closed.md`.

**DECISION 1: accept trusted-runtime-only scope for v1 live money?**

**Recommendation — yes, with a structural restriction that makes the offline hole moot:** v1 autonomous money executes **only on the relay-coordinated settlement path**, where the relay re-verifies the grant (incl. revocation) at settlement time and is the trusted accumulator. Pure-P2P autonomous money stays behind the freshness-staple trigger. This is not a compromise — it is the clearing-house doctrine executing (coordination lowers risk; that is what the 5% buys). Add the named adversarial test `revoke-then-self-mint-offline` as a permanent red-team fixture in the same increment.

## Axis 2 — Ceiling semantics

**As implemented** (`grant-blast-radius.ts:67-270`): integer micro-USD; cumulative-within-rolling-window (`cumulative_limit_micro` + `window_ms`, forward-only roll, clock-rollback safe) and/or lifetime (`lifetime_limit_micro`, never resets); per-counterparty bucket; per-window action count; monotonic nonce anti-replay; at least one total bound required or deny `ceiling_absent`; a set limit of 0 = deny-all; strict `>` (hitting the ceiling exactly is allowed, exceeding is denied); deny mutates nothing; overflow-guarded; atomic check-and-commit store contract.

**DECISION 2: ratify these semantics as the signed-commitment semantics?**

**Recommendation — ratify as-is, with one spec-text pin and one named future axis:** (a) pin the denomination as **USD-denominated micro-units** in spec prose — the ceiling has no asset tag today, and ambiguity here is a money bug waiting for the first non-USD rail; (b) name `asset` as a future **agility axis** (registry append per [`agility-as-role.md`](../doctrine/agility-as-role.md)), not a v1 field. The exact-hit-allowed strict-exceed convention and deny-all-zero are correct and standard; do not renegotiate them.

## Axis 3 — Wire shape (the load-bearing decision)

**The gap, stated by the source itself** (`grant-blast-radius.ts:48-51`): the enforcer expects the ceiling to be **the delegator's cryptographic commitment**, but `StandingDelegation` (`packages/protocol/src/index.ts:327-375`) carries WHO/WHAT/WHEN (parties, capability scope, cadence, `max_token_ttl_ms`, `expires_at`, revocation handle) and **no HOW-MUCH**. Today a ceiling could only be unsigned local config — which would violate the arc's own honesty floor (authority from signed artifacts only).

**DECISION 3: how does the ceiling reach the wire?**

**Recommendation — additive optional field `spend_ceiling?` on standing-delegation@1.2** (following the @1.1 `subject_binding` precedent):

- Absent ⇒ `ceiling_absent` ⇒ no autonomous money. **Absence is already fail-closed** — the enforcer's existing behavior makes the additive-optional shape safe by construction. Old grants verify fine and simply cannot move money.
- Inside the signed body (JCS-covered), so the ceiling is the delegator's commitment, not runtime config.
- The wiring invariant that must ship with it: `evaluateBlastRadius` receives its ceiling **only** from the verified grant — never from config, never model-authored. This is the produced-not-authored discipline applied to money; it wants its own drift gate (working name `check-ceiling-from-grant`), sibling of `check-money-authority`.
- Sweep: protocol type + crypto sign/verify + `spec/standing-delegation-v1.md` @1.2 section + `spec/schemas/` + wire-schemas + `@motebit/verifier` + drift tests. One increment, one-pass delivery.

Rejected alternative: a separate signed ceiling artifact — splits the authority story across two artifacts with a binding problem between them, for no gain at v1.

## Axis 4 — Revocation latency

**Grounded facts:** revocation is a signed `DelegationRevocation` (terminal, D3), checked via the injected `isRevoked` seam; `verifyGrantForTurn` re-checks per turn against the **held** revocation set, fail-closed. There is **no relay `delegation_revoked` feed** (deferred at N=1 self-issuance per proposal §6b; only the agent-revocation feed exists at `services/relay/src/agent-revocation.ts`). Online latency = freshness of the held set. Offline latency against a malicious delegate = **up to `expires_at`** (the honest post-`ec3959d6` claim; token TTL does not bound this case).

**DECISION 4: what revocation freshness is required before money moves?**

**Recommendation — two-part:**

1. **Relay checks revocation at settlement time.** Since v1 money is relay-coordinated (Decision 1), extend the existing `RevocationEvent` feed with the `delegation_revoked` type (grant_id, same append-only feed + horizon) **in Inc 3**, and the relay refuses settlement under a revoked grant. Online revocation latency then ≈ one settlement round-trip — effectively immediate at the only checkpoint where money finalizes.
2. **Money-scoped grants get tight lifetimes.** Spec recommends ≤90d for grants generally; for grants carrying `spend_ceiling`, recommend **7–30d renewable** default, `max_token_ttl_ms` 1h. Offline worst-case exposure is then (short grant life × signed ceiling) — a bounded, named, priced risk instead of an open one.

---

## Proposed Inc 3 / Inc 4 sequencing

- **Inc 3a (wire):** `spend_ceiling` @1.2 sweep (Axis 3) + `delegation_revoked` feed type.
- **Inc 3b (wiring):** ingress caller → `verifyGrantForTurn` → `verifiedGrant` threading; persistent atomic `GrantSpendStore`; dispatch AND-composition (`tryConsume` between gate-clear and rail execution); `check-ceiling-from-grant` gate; `revoke-then-self-mint-offline` adversarial fixture.
- **Inc 4 (enable):** first live grant is **self-delegation at N=1** — the founder's own motebit paying a real counterparty under the tightest expressible ceiling (e.g. lifetime $5, per-counterparty $5, 7-day grant). Adversarial-onboarding idiom: the first real autonomous dollar moves under the smallest vault, and produces the first genuine autonomous-money `ExecutionReceipt`s — the first dispute-grade rows the clearing-house moat is made of.

## Sign-off

- [ ] **D1** — trusted-runtime threat model accepted; v1 money relay-coordinated only; pure-P2P deferred behind freshness staple
- [ ] **D2** — ceiling semantics ratified; USD-micro denomination pinned; `asset` named as future agility axis
- [ ] **D3** — `spend_ceiling?` as signed additive field on standing-delegation@1.2; ceiling-from-verified-grant-only gate
- [ ] **D4** — settlement-time revocation check + `delegation_revoked` feed in Inc 3; 7–30d money-grant lifetime convention

Signed-off-by: \***\*\_\_\_\_\*\*** Date: \***\*\_\_\_\_\*\***

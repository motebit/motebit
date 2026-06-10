# PROPOSAL — motebit/standing-delegation@1.0 (DRAFT, not committed)

**Status:** APPROVED 2026-06-10 (D1 finite+renewable, D2 signed-feed-canonical, D3 revoke-terminal, D4 push, D5 seam-only). Authorization layer (protocol types + /crypto sign/verify + tests) IMPLEMENTED in increment 1. Committed spec + wire-schemas + verifier integration + relay feed are follow-ups.
**Author:** motebit PE
**Forcing consumer:** agency (standing-monitor vertical, paused on this)
**Composes with:** `delegation@1.0` (DelegationToken), the relay `RevocationEvent` feed, `execution-ledger@1.0` receipts

## 1. Why this exists

`DelegationToken` (delegation@1.0 §6 / market-v1 §12) is **short-lived and task-scoped by invariant**: `expires_at` required, recommended 1h / max 24h, `verifyDelegation` rejects expired, no cadence field, no published revocation. That is correct for one delegated act. It does **not** model "this key authorizes daily research on subject S until revoked."

The wrong fix is to stretch `DelegationToken` (open-ended `expires_at` breaks the short-lived invariant and the verifier, and leaves no revocation story). The right shape: a **StandingDelegation** grant that does not authorize a task itself — it authorizes its holder to **mint short-lived per-tick `DelegationToken`s** within a fixed scope ceiling and cadence, for an open-ended (but revocable) lifetime. Per-tick tokens stay 1h and task-scoped; the standing authority lives only on the grant; revocation lives on the grant.

This also closes a gap that exists independent of agency: **delegation has no published revocation story.** Delegation is the architectural connector ([delegation.md](../doctrine/delegation.md)); revocation belonging only to an unspecified relay-local deny-list is a real hole.

## 2. The StandingDelegation artifact

```
StandingDelegation {
  grant_id:             string   // UUID v7 — the stable handle revocation targets
  delegator_id:         string   // motebit_id of the granting owner
  delegator_public_key: string   // Ed25519, hex (64 lowercase) — verify key
  delegate_id:          string   // motebit_id authorized to mint per-tick tokens
  delegate_public_key:  string   // Ed25519, hex
  scope:                string   // comma-sep capability CEILING, or "*"; per-tick tokens narrow within (same scope grammar + isScopeNarrowed as delegation@1.0)
  subject:              string   // human-meaningful binding ("research:thesis=X"); opaque to verify, carried for receipt-linkage + legibility
  cadence_ms:           number   // the authorized minimum firing interval — a per-tick token issued faster than this is invalid
  issued_at:            number   // Unix ms
  not_before:           number | null   // optional activation delay
  expires_at:           number         // see Decision D1 — long-but-finite, renewable (NOT null/open-ended)
  max_token_ttl_ms:     number   // ceiling on each minted DelegationToken's (expires_at - issued_at); keeps per-tick tokens short-lived
  suite:                "motebit-jcs-ed25519-b64-v1"
  signature:            string   // base64url Ed25519 over JCS(body) — same suite as DelegationToken
}
```

Signed and verified exactly like `DelegationToken`: JCS-canonicalize all fields except `signature`, Ed25519 over the bytes, base64url. New `@motebit/crypto` exports: `signStandingDelegation`, `verifyStandingDelegation`.

## 3. Per-tick composition (how a monitor tick authorizes)

A `DelegationToken` gains one optional field: `grant_id?: string` (absent ⇒ the existing standalone token; present ⇒ this token was minted under a StandingDelegation). Backward compatible, absent ⇒ today's semantics.

Each monitor tick, the delegate mints a `DelegationToken` with:

- `delegator/delegate` = the grant's parties,
- `scope` ⊆ `grant.scope` (`isScopeNarrowed`),
- `expires_at - issued_at` ≤ `grant.max_token_ttl_ms`,
- `issued_at` ≥ previous tick's `issued_at` + `grant.cadence_ms` (no faster than authorized),
- `grant_id` = `grant.grant_id`.

The tick's `ExecutionReceipt` references **both** the per-tick token digest and `grant_id` (`authorization_root`), so the receipt chain is provably anchored to the standing grant, and the grant's revocation retroactively marks every later tick as unauthorized.

New helper `verifyTokenAgainstGrant(token, grant, { now, isRevoked })`: `verifyDelegation(token)` ∧ `token.grant_id === grant.grant_id` ∧ `verifyStandingDelegation(grant)` ∧ scope-narrowed ∧ ttl-bounded ∧ not-revoked. A monitor's authorization is thus fully offline-verifiable from `{grant, per-tick token, revocation feed}` with no relay trust.

## 4. Revocation (the gap this closes)

Reuse the existing `RevocationEvent` family (`services/relay/src/federation.ts`), add one type:

```
RevocationEvent.type |= "delegation_revoked"
// carries: { type:"delegation_revoked", grant_id, motebit_id: <delegator_id>, timestamp, signature }
```

- **Only the delegator** can revoke their own grant (signature verified against `delegator_public_key`).
- Propagated on the **same signed append-only feed** as agent/credential revocation, under the same revocation horizon. Reversible with an `unrevoke` record (sibling of `AgentRevocationRecord` semantics) if we want grant pause/resume — open question, §6.
- **Source of truth is the signed feed** (offline-verifiable against the delegator's key — per [self-attesting-system.md](../doctrine/self-attesting-system.md)), NOT a relay-asserted boolean. The relay deny-list is a cache/fast-path, not the authority. See Decision D2.

`verifyStandingDelegation` and `verifyTokenAgainstGrant` take an injected `isRevoked(grant_id) → boolean` (same shape as the existing `isAgentRevoked` seam), so the verifier stays I/O-free and the consumer wires the feed lookup.

## 5. What ships where

- **`@motebit/protocol`** (Apache-2.0): `StandingDelegation` type, `grant_id` on `DelegationToken`, `"delegation_revoked"` on the revocation union.
- **`@motebit/crypto`** (Apache-2.0): `signStandingDelegation`, `verifyStandingDelegation`, `verifyTokenAgainstGrant`, `signDelegationRevocation`. Mirrors `signDelegation`/`verifyDelegation`.
- **`@motebit/verifier`**: the grant + per-tick + revocation path joins the offline-verifiable family (agency consumes it).
- **relay**: a `delegation_revoked` row on the existing revocation feed + the `/api/v1/agents/revocations`-style endpoint extended (or a sibling `/delegations/revocations`). No new trust domain.

## 6. Decisions for sign-off (these change what gets built)

- **D1 — open-ended vs long-but-finite expiry.** A truly open-ended grant (`expires_at: null`) makes authority depend on revocation reaching _every_ verifier; the revocation feed has a horizon (>7d truncation), so a verifier that missed the window could honor a revoked grant. **My recommendation: long-but-finite + renewable** (e.g., 90-day max, delegate renews by re-signing). Belt over braces: a grant auto-dies if revocation propagation ever fails. Agency's "until revoked" UX is preserved (silent auto-renew until the user revokes). _Decide: 90d? 30d? truly open-ended?_
- **D2 — revocation source of truth.** Signed feed (offline-verifiable, self-attesting — **my recommendation**) as canonical, relay deny-list as cache. Alternative: relay deny-list only (simpler, but reintroduces relay-trust for a security-critical check, violating "convenience layer, not trust root"). _Decide: confirm signed-feed-canonical._
- **D3 — pause/resume.** Do standing grants need pause (unrevoke) like agent revocations, or is revoke terminal? Monitors arguably want pause. _Decide: support unrevoke for grants, or revoke-is-terminal v1._

## 7. Out of scope (v1)

The _scheduler_ that fires the cadence ticks is NOT this spec (that's the Q3 seam — see `scheduler-seam-v1.md`). This spec is the **authorization** layer only: it makes a standing monitor's authority a real, revocable, offline-verifiable protocol artifact, whether the ticks are fired by agency's cron today or a relay scheduler later.

# motebit/standing-delegation@1.0

**Status:** Draft  
**Authors:** Daniel Hakim  
**Created:** 2026-06-10

## 1. Purpose

`delegation@1.0` authorizes ONE act: a `DelegationToken` is short-lived by invariant (required `expires_at`, recommended 1h / max 24h, rejected once expired) and carries no cadence and no revocation. That is correct for a single delegated task. It does not model **standing** work — "this key authorizes daily research on subject S until I revoke it."

This spec defines that missing shape. A `StandingDelegation` is a signed, revocable grant that does **not** authorize a task itself — it authorizes short-lived per-tick `DelegationToken`s, **each signed by the delegator**, to be issued and exercised within a fixed scope ceiling and cadence, for a long-but-finite, revocable lifetime. The standing authority lives only on the grant; each per-tick token stays short-lived and task-scoped; revocation lives on the grant. It also closes a gap that exists independently: delegation previously had no published revocation story.

For a **sovereign delegator** whose key is unlocked only at grant-creation (e.g. a passkey-gated seed that cannot sign at tick time), the canonical pattern is **pre-minting**: sign the grant AND every per-tick token for the grant's life up front — one per cadence slot, future-dated, each `not_before`-gated to its slot (§4) — so a slot's token cannot verify before its slot. This is the v1.0 model and the one a "receipts over trust" consumer should prefer: **cadence is bound cryptographically** by the signed token set (every tick the holder exercises was individually signed by the delegator's key), not merely rate-limited. Letting the delegate sign its own per-tick tokens (holder-side minting) is a deliberate non-goal in v1.0 — see §4.

Every artifact here is signed and **offline-verifiable** (self-attesting): a third party validates a standing monitor's authorization root, every per-tick token, and a revocation with only `@motebit/crypto` (or any Ed25519 library + these JSON Schemas) and the signer's public key — no relay contact.

## 2. Design Principles

**The grant mints; it does not act.** A `StandingDelegation` is authorization to issue per-tick `DelegationToken`s, not authorization to execute. Each tick still produces a real, short-lived `DelegationToken` and a signed `ExecutionReceipt`. Compromising or expiring the grant stops new ticks; it does not retroactively un-execute completed ones, but it does mark every later tick as unauthorized.

**Short-lived tokens, long-lived grant.** The per-tick token's invariant (≤ 24h) is preserved. Open-ended authority lives only on the grant, and even the grant is **finite and renewable** — never `null`/infinite — because revocation propagation is bounded (§6, D1).

**Revocation is first-class and offline-verifiable.** A grant is terminated by a signed `DelegationRevocation`, which is the canonical source of truth. A relay deny-list is a permitted cache, never the authority.

## 3. StandingDelegation

### 3.1 — StandingDelegation

#### Wire format (foundation law)

The signed grant. Field names, types, and the canonical-JSON signing order are binding.

```
StandingDelegation {
  grant_id:             string   // UUID v7 — the stable handle a DelegationRevocation targets
  delegator_id:         string   // MotebitId of the granting owner
  delegator_public_key: string   // Ed25519 public key, hex (64 lowercase) — verifies `signature`
  delegate_id:          string   // MotebitId authorized to mint per-tick tokens
  delegate_public_key:  string   // Ed25519 public key, hex (64 lowercase)
  scope:                string   // Comma-separated capability CEILING, or "*". Per-tick tokens narrow within. Grammar per market-v1 §12.3.
  subject:              string   // Human-meaningful binding (e.g. "research:thesis=acme-q3"). Opaque to verify.
  cadence_ms:           number   // Authorized minimum firing interval (ms). A mint/relay rate limit; NOT a single-token verify rule.
  issued_at:            number   // Unix ms
  not_before:           number | null  // Optional activation delay. Null ⇒ active from issued_at.
  expires_at:           number   // Unix ms. Long-but-finite and renewable — NOT open-ended (§6 D1).
  max_token_ttl_ms:     number   // Ceiling on each minted token's (expires_at - issued_at).
  suite:                string   // "motebit-jcs-ed25519-b64-v1" — cryptosuite identifier (see @motebit/protocol SUITE_REGISTRY)
  signature:            string   // Ed25519 over canonical JSON of all fields except signature
}
```

The `StandingDelegation` type in `@motebit/protocol` is the binding machine-readable form; `StandingDelegationSchema` in `@motebit/wire-schemas` derives the committed JSON Schema at `spec/schemas/standing-delegation-v1.json`.

#### Verification (foundation law)

A complete verification has two parts: **intrinsic** validity (checkable from the grant alone) and the **revocation** check (requires the revocation set). A verifier MUST reject a `StandingDelegation` unless ALL hold:

**Intrinsic (from the grant alone):**

1. `suite == "motebit-jcs-ed25519-b64-v1"`.
2. `not_before == null` OR `now >= not_before`.
3. `now <= expires_at` (unless verifying historical context).
4. The Ed25519 signature over `canonicalJson(body)` (everything except `signature`) verifies against `delegator_public_key`.

**Revocation (requires the revocation set — the consumer's responsibility):**

5. The grant is not revoked — no valid `DelegationRevocation` for `grant_id` signed by `delegator_public_key` (see §5 for what makes a revocation authoritative).

`@motebit/crypto` `verifyStandingDelegation` performs items 1–4. It is I/O-free by contract and so **does not fetch the revocation feed**: item 5 is the caller's responsibility, performed by wiring the injected `isRevoked` seam — a `grant_id → boolean` lookup. **A verifier that omits `isRevoked` is incomplete: a revoked grant passes items 1–4 and verifies.** The canonical way to build the lookup is `findGrantRevocation(grant, revocations)`, which does the authoritative binding check (§5) over a revocation set; precompute the revoked set, then provide the sync lookup. The seam mirrors the relay's existing agent-revocation lookup.

## 4. Per-tick tokens

A `DelegationToken` (delegation@1.0) gains two OPTIONAL fields, `grant_id` and `not_before`. `grant_id` absent ⇒ a standalone single-act delegation (today's semantics — backward compatible); present ⇒ this token is one tick of a `StandingDelegation`. `not_before` (Unix ms) absent ⇒ active from `issued_at`; present ⇒ the token is invalid before it (verifiers reject when `now < not_before`). Both are additive and replay-compatible; 1.0 tokens verify identically.

Each tick is a `DelegationToken` **signed by the delegator** (verified against `delegator_public_key`; the parties are pinned, so a tick the delegate signed for itself is rejected) with: the grant's parties; `scope ⊆ grant.scope`; `expires_at - issued_at <= grant.max_token_ttl_ms`; `issued_at` no sooner than the previous tick's `issued_at + grant.cadence_ms`; and `grant_id = grant.grant_id`. The tick's `ExecutionReceipt` references both the per-tick token and `grant_id`, anchoring the receipt chain to the grant.

**Who signs, and pre-minting (v1.0 model).** The delegator signs each tick — so for a sovereign delegator the ticks are **pre-minted** at grant-creation while the key is unlocked: one per cadence slot, each future-dated with `not_before` set to its slot start so it cannot verify early. This binds cadence cryptographically (the signed token set _is_ the schedule) and keeps the delegator the sole signer. **Holder-side minting** — letting the grant's `delegate_public_key` sign its own per-tick tokens — would let the holder act with the delegator offline, but it demotes cadence from a cryptographic property to a mint/relay rate-limit (only `scope` stays crypto-bounded). It is a deliberate **non-goal in v1.0**; a future version MAY add it behind an explicit trigger (a consumer that genuinely cannot pre-mint), with the cadence trade-off documented.

#### Verification (foundation law)

A per-tick `DelegationToken` is a valid tick of a grant iff ALL hold (`@motebit/crypto` `verifyTokenAgainstGrant`):

1. The token verifies as a `DelegationToken` (signature + expiry + `not_before` activation).
2. `token.grant_id == grant.grant_id`.
3. The grant verifies (§3.1 — including not-revoked).
4. The parties match: both `delegator_*` AND `delegate_*` equal the grant's.
5. `scope` narrows within the grant's ceiling.
6. `token.expires_at - token.issued_at <= grant.max_token_ttl_ms`.

**Cadence is NOT a single-token verification rule.** The minimum inter-tick interval (`cadence_ms`) is a rate limit enforced by the issuer / relay at mint time; it is not derivable from a single token, so the offline verifier does not check it.

## 5. DelegationRevocation

### 5.1 — DelegationRevocation

#### Wire format (foundation law)

Terminates a grant. Only the grant's delegator may sign one. Revocation is terminal in v1.

```
DelegationRevocation {
  grant_id:             string   // The StandingDelegation.grant_id being revoked
  delegator_id:         string   // MotebitId of the delegator. MUST equal the grant's delegator.
  delegator_public_key: string   // Ed25519 public key, hex (64 lowercase). To bind a grant, MUST equal that grant's delegator_public_key.
  revoked_at:           number   // Unix ms
  suite:                string   // "motebit-jcs-ed25519-b64-v1" — cryptosuite identifier (see @motebit/protocol SUITE_REGISTRY)
  signature:            string   // Ed25519 over canonical JSON of all fields except signature
}
```

The `DelegationRevocation` type in `@motebit/protocol` is the binding machine-readable form; `DelegationRevocationSchema` in `@motebit/wire-schemas` derives `spec/schemas/delegation-revocation-v1.json`.

#### Foundation Law

- A `DelegationRevocation` is **authoritative over a grant** only when `grant_id` matches AND `delegator_public_key` equals that grant's `delegator_public_key`. A well-formed signature alone proves the statement, not the authority — `verifyDelegationRevocation` checks the signature; the caller checks the grant binding. `@motebit/crypto` `findGrantRevocation` does all three (grant_id match, key match, signature) over a candidate set and is the canonical consumer-side check; matching `grant_id` alone is the foot-gun it forecloses.
- The signed revocation is the **canonical source of truth**. Relays MAY maintain a deny-list cache (analogous to the `auth-token-v1 §8.1` jti deny-list) and SHOULD propagate revocations on the same signed, append-only feed as agent/credential revocations, under the same revocation horizon — but a relay-asserted boolean is never the authority (self-attesting-system doctrine).

## 6. Conventions

- **D1 — Grant lifetime.** `expires_at` is long-but-finite and renewable; implementations SHOULD NOT issue open-ended grants. Recommended max: 90 days; the delegate renews by re-signing before expiry. Rationale: revocation propagation is bounded (a feed horizon), so authority that outlives revocation reachability is unsafe — a finite grant auto-dies if propagation ever fails, while preserving an "until revoked" experience via silent renewal.
- **D2 — Revocation source of truth** is the signed `DelegationRevocation` (offline-verifiable); the relay deny-list is a cache, not the authority.
- **D3 — Revocation is terminal** in v1 (no unrevoke). Pausing a standing monitor is a scheduler concern (stop firing ticks), not a grant-state change.
- **Token lifetime** (`max_token_ttl_ms`): SHOULD be ≤ the delegation@1.0 token maximum (24h); 1h recommended.

## 7. Relationship to Other Specs

- `delegation@1.0` — defines `DelegationToken` (this spec adds the optional `grant_id`) and the task submission/receipt/settlement loop each tick flows through.
- `execution-ledger@1.0` — each tick's signed receipt; references `grant_id` as the authorization root.
- `auth-token-v1 §8.1` — the deny-list pattern the relay revocation cache follows.

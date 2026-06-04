# motebit/agent-revocation@1.0

Operator de-listing of agents from the relay's discovery registry, made
sovereign-verifiable. The relay is a convenience layer, not a trust root
(`services/relay/CLAUDE.md` rule 6); an operator who can silently disappear an
agent would be exactly the trust root the relay must not be. This spec makes the
operator's de-list power **accountable**: every de-listing and reinstatement is a
signed, reasoned, publicly-fetchable record, verifiable against the relay's
pinned Ed25519 key — the same key committed by the operator-transparency
declaration (`motebit/relay-transparency@1.0`).

Doctrine: [`docs/doctrine/agents-as-first-person-trust-graph.md`](../docs/doctrine/agents-as-first-person-trust-graph.md)
§8, [`docs/doctrine/self-attesting-system.md`](../docs/doctrine/self-attesting-system.md),
[`docs/doctrine/operator-transparency.md`](../docs/doctrine/operator-transparency.md).

## 1. Scope

A permissionless registry accumulates junk: spam listings, abandoned test
agents, abusive capabilities. The only automatic remedy is the 90-day
no-heartbeat TTL — too slow for live abuse. The operator therefore needs a
de-list tool. Two invariants bound it:

- **De-list, not de-identify.** Revoking a _listing_ removes the agent from
  Discover (the relay sets its `agent_registry.revoked` flag, which the
  discovery query filters). The agent's identity, key, succession chain, and
  receipts remain served by the identity endpoint — it stays hireable directly
  by `motebit_id`. This is distinct from **identity revocation**
  (`motebit/identity@1.0`, `POST /api/v1/agents/:motebitId/revoke`), which marks
  a key compromised and anchors an on-chain revocation memo. De-listing asserts
  nothing about the agent's key.
- **Hygiene, not curation.** Discovery stays permissionless — no allowlist, no
  pre-approval. The operator only _removes_ junk/abuse; it never _selects_
  agents. Quality remains earned trust (first-person, bilateral), never operator
  blessing.

#### Routes (foundation law)

The public, verifiable surface is the feed. The production endpoints
(`/revoke-listing`, `/restore-listing`) are operator-authenticated relay
endpoints and are described informatively in §4 — they are not part of the
cross-implementation interop contract; the **feed format is**.

- `GET /api/v1/agents/revocations` — the relay's complete, signed, append-only
  moderation history as an `AgentRevocationFeed` (§3). Unauthenticated; anyone
  may fetch and verify it against the relay's pinned key.

## 2. AgentRevocationReason

The closed, categorized reason on every record. Wire values are snake_case
identifiers; verifiers reading the feed agree on this vocabulary, so it is
interop law (a registered registry in `@motebit/protocol`,
`check-agent-revocation-reason-canonical`):

`operator_test_cleanup`, `spam`, `abuse`, `malware`, `policy_violation`,
`dmca`, `reinstated`.

`reinstated` is the canonical reason on a reinstatement (a record with
`revoked: false`). Adding a reason is an additive, intentional protocol change.

## 3. Wire types

### 3.1 — AgentRevocationRecord

#### Wire format (foundation law)

One immutable state change — a de-listing (`revoked: true`) or a reinstatement
(`revoked: false`). Field names, types, and the canonical-JSON signing order are
binding. The optional `note` participates in the canonical bytes only when
present (JCS includes a key only when its value is defined).

```
AgentRevocationRecord {
  spec:             string   // "motebit-agent-revocation/draft-2026-06-04"
  motebit_id:       string   // the agent whose discoverability changed
  revoked:          boolean  // true = de-listed from Discover, false = reinstated
  reason:           string   // AgentRevocationReason (§2)
  actor:            string   // "operator" | "self"
  note:             string   // OPTIONAL — free-text operator note (not a substitute for reason)
  effective_at:     number   // Unix ms when the change took effect
  relay_id:         string   // the relay's MotebitId
  relay_public_key: string   // hex Ed25519 (64 chars) — the trust anchor
  hash:             string   // hex SHA-256 of canonicalJson of the signed payload
  suite:            string   // "motebit-jcs-ed25519-hex-v1" (see @motebit/protocol SUITE_REGISTRY)
  signature:        string   // hex Ed25519 over the canonical JSON of the signed payload
}
```

The signed payload is every field except `hash`, `suite`, `signature`. The
`AgentRevocationRecord` type in `@motebit/protocol` is the binding
machine-readable form.

### 3.2 — AgentRevocationFeed

#### Wire format (foundation law)

The signed envelope served at `GET /api/v1/agents/revocations`. The relay signs
the list digest so a consumer can fetch the entire moderation history in one
verifiable response; each contained record is also independently signed.

```
AgentRevocationFeed {
  spec:             string                    // matches the records' spec
  relay_id:         string                    // the relay's MotebitId
  relay_public_key: string                    // hex Ed25519 (64 chars)
  generated_at:     number                    // Unix ms — feed snapshot time
  records:          AgentRevocationRecord[]    // oldest-first, append-only history
  suite:            string                    // "motebit-jcs-ed25519-hex-v1"
  signature:        string                    // hex Ed25519 over canonicalJson({spec, relay_id, relay_public_key, generated_at, records})
}
```

The `AgentRevocationFeed` type in `@motebit/protocol` is the binding
machine-readable form.

## 4. Production endpoints (informative)

Operator-only, master-token-authenticated. Distinct from identity revocation
(different act, different route). Each appends one signed `AgentRevocationRecord`
to the feed and flips the agent's `agent_registry.revoked` flag.

- `POST /api/v1/agents/:motebitId/revoke-listing` — de-list. Body
  `{ reason: AgentRevocationReason (not "reinstated"), note?: string }`.
- `POST /api/v1/agents/:motebitId/restore-listing` — reinstate. Records with
  `revoked: false`, reason `reinstated`.

An agent removes its _own_ listing via `DELETE /api/v1/agents/deregister`
(`motebit/discovery@1.0`); it never de-lists a peer.

## 5. Verification

A third party verifies the feed offline against the relay's pinned key
(obtained via the transparency declaration's trust-on-first-use bootstrap):

1. Fetch `GET /api/v1/agents/revocations`.
2. `verifyAgentRevocationFeed(feed, pinnedRelayKeyHex)` — recompute the feed
   digest, check the envelope signature under the declared suite, then verify
   every contained record (`verifyAgentRevocationRecord`) against the same key.
3. Current discoverability of any `motebit_id` is the latest record for it; the
   full feed is the auditable history.

Both verifiers live in `@motebit/state-export-client` (Apache-2.0, browser-safe),
alongside `verifyTransparencyDeclaration`. Fail-closed, typed reasons, no thrown
exceptions for verification failures.

## 6. Security Considerations

### 6.1 — Operator accountability, not operator trust

The point is not that the operator is trusted to de-list fairly — it is that
every de-listing is a **signed public claim**. A bad-faith de-listing is visible
in the feed and challengeable; the operator cannot remove an agent without
leaving a signed record. The `reason` is operator-asserted prose-of-category, not
a proof of abuse; the accountability is that the claim is signed and public.

### 6.2 — De-list is not key revocation

A consumer MUST NOT treat an `AgentRevocationRecord` as evidence that the agent's
key is compromised. Identity/key revocation is a separate artifact
(`motebit/identity@1.0`) carrying an on-chain memo. A de-listed agent's
signatures and receipts remain valid; only its discoverability via this relay is
removed.

### 6.3 — Reversibility and append-only history

Reinstatement is itself a signed record, never a mutation or deletion of the
de-listing record. The feed is the complete append-only history; a verifier sees
every state change, not a collapsed current view.

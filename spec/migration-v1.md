# motebit/migration@1.0

**Status:** Draft  
**Authors:** Daniel Hakim  
**Created:** 2026-04-11

## 1. Purpose

Migration is how an agent moves from one relay to another while preserving identity, reputation, and balance. An agent that cannot leave a relay is not sovereign — it is a tenant. This spec defines the message formats, lifecycle states, attestation rules, and verification procedures that make relay migration interoperable across implementations.

The other specs define the primitives: identity files (identity@1.0), credentials (credential@1.0), credential anchors (credential-anchor@1.0), settlement rails (settlement@1.0), federation discovery (relay-federation@1.0). This spec defines the **protocol for composing them into a migration** — how an agent announces departure, exports its portable state, settles its balance, and presents itself to a new relay.

## 2. Design Principles

**Sovereignty enforced.** A relay MUST NOT prevent an agent from departing. The relay may have commercial preferences, but the protocol forbids exit barriers. A relay that refuses to issue a migration token is in protocol violation.

**Reputation portable.** Departure attestations and credential anchor proofs travel with the agent. The destination relay can independently verify reputation without trusting the source relay's word alone — onchain anchors are the cross-relay source of truth.

**Identity continuous.** The agent's `motebit_id` is permanent. Migration changes the relay, not the identity. Key succession chains (identity@1.0) are included in the migration bundle so the destination can validate the full identity history.

**Balance settled.** No funds left behind. The source relay settles the agent's virtual account balance via existing settlement rails (settlement@1.0) before the agent departs. Migration is not a mechanism for the relay to confiscate balances.

## 3. Migration Lifecycle

A migration moves through a fixed set of states:

```
idle → initiated → attesting → exporting → settling → departed
idle → initiated → cancelled
```

### 3.1 State Definitions

| State       | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `idle`      | Agent is active on the relay, no migration in progress      |
| `initiated` | Agent submitted MigrationRequest, relay acknowledged        |
| `attesting` | Relay is preparing the DepartureAttestation                 |
| `exporting` | Agent is downloading credential bundle and portable state   |
| `settling`  | Balance withdrawal in progress via settlement rails         |
| `departed`  | Migration complete, agent is no longer active on this relay |
| `cancelled` | Agent cancelled the migration before reaching `departed`    |

### 3.2 Foundation Law

- Terminal states (`departed`, `cancelled`) are irreversible.
- A departed agent MUST NOT execute tasks, claim work, or accumulate trust on the source relay.
- An agent MAY cancel at any point before `departed`. Cancellation returns the agent to `idle`.
- The relay MUST NOT unilaterally advance the state to `departed` — only the agent's signed confirmation or the completion of the full lifecycle triggers departure.

## 4. Migration Initiation

The agent announces intent to migrate. The relay issues a migration token.

### 4.1 — MigrationRequest

#### Wire format (foundation law)

The exact request shape every implementation MUST emit when initiating migration. Field names, types, and the canonical-JSON signing order are binding.

```
MigrationRequest {
  motebit_id:         string      // Agent's MotebitId
  destination_relay:  string      // Optional: URL or relay_id of intended destination
  reason:             string      // Optional: human-readable reason for migration
  requested_at:       number      // Unix ms
  signature:          string      // Ed25519 by agent over canonical JSON of all fields except signature
}
```

The `MigrationRequest` type in `@motebit/protocol` is the binding machine-readable form.

### 4.2 — MigrationToken

#### Wire format (foundation law)

The token the source relay returns in response to a valid `MigrationRequest`. This is the portable artifact the agent presents at the destination.

```
MigrationToken {
  token_id:           string      // UUID v7
  motebit_id:         string      // Agent's MotebitId
  source_relay_id:    string      // Issuing relay's identity
  source_relay_url:   string      // Issuing relay's canonical URL
  issued_at:          number      // Unix ms
  expires_at:         number      // Unix ms
  signature:          string      // Ed25519 by source relay over canonical JSON of all fields except signature
}
```

The `MigrationToken` type in `@motebit/protocol` is the binding machine-readable form.

#### Storage (reference convention — non-binding)

The reference relay persists active tokens in `relay_migration_tokens` with `(token_id PRIMARY KEY, motebit_id, expires_at, state)`. Alternative implementations MAY store state on a session record or derive expiry on the fly; only the wire shape above is protocol-binding.

### 4.3 Foundation Law

- The relay MUST issue a MigrationToken when a valid MigrationRequest is received from a registered agent.
- The relay MUST NOT condition token issuance on the destination relay, the reason, or any other factor. Departure is unconditional.
- The relay MUST NOT revoke a MigrationToken once issued, except on agent-initiated cancellation.
- Active tasks (delegation@1.0) submitted by or assigned to the agent MUST complete or expire before the agent can advance past `settling`. The relay MUST NOT silently drop in-flight tasks.

### 4.4 Convention

- Default token expiry: 72 hours from issuance.
- One active MigrationToken per agent. A new request while a token is active replaces the previous token.
- The relay SHOULD notify federated peers (relay-federation@1.0) that the agent is migrating, so routing tables can update.

## 5. Departure Attestation

The source relay attests to the agent's history. This is the relay's signed statement of fact about the agent's tenure.

### 5.1 — DepartureAttestation

#### Wire format (foundation law)

The relay's signed statement of fact about the agent's tenure. Every implementation MUST emit and accept this shape so destination relays can verify attestations without coordination.

```
DepartureAttestation {
  attestation_id:       string      // UUID v7
  motebit_id:           string      // Agent's MotebitId
  source_relay_id:      string      // Attesting relay's identity
  source_relay_url:     string      // Attesting relay's canonical URL
  first_seen:           number      // Unix ms — when the agent first registered
  last_active:          number      // Unix ms — last task execution or interaction
  trust_level:          string      // AgentTrustLevel enum ("unknown", "first_contact", "verified", "trusted", "blocked")
  successful_tasks:     number      // Total completed tasks as worker
  failed_tasks:         number      // Total failed tasks as worker
  credentials_issued:   number      // Total credentials issued to this agent
  balance_at_departure: number      // Virtual account balance in micro-units at attestation time
  attested_at:          number      // Unix ms
  signature:            string      // Ed25519 by source relay over canonical JSON of all fields except signature
}
```

### 5.2 Verification

1. Fetch the source relay's Ed25519 public key via the `/.well-known/motebit.json` discovery endpoint (relay-federation@1.0).
2. Compute `canonicalJson(attestation_without_signature)`.
3. Verify `Ed25519.verify(signature, canonical_bytes, relay_public_key)`.

A valid attestation proves the source relay voluntarily signed these facts. It does not prove the facts are true — credential anchor proofs (§6) provide the independent verification layer.

The `DepartureAttestation` type in `@motebit/protocol` is the binding machine-readable form.

#### Storage (reference convention — non-binding)

The reference relay persists issued attestations on `relay_departures(attestation_id, motebit_id, attested_at, body JSON)` for 90 days. Alternative implementations MAY stream attestations directly to the agent without persistence; the wire shape above is what conforming peers consume.

### 5.3 Foundation Law

- The relay MUST issue a DepartureAttestation for any agent with an active MigrationToken.
- The attestation MUST include at minimum: `motebit_id`, `source_relay_id`, `trust_level`, `successful_tasks`, `failed_tasks`, `first_seen`, `attested_at`, `signature`.
- The relay MUST NOT fabricate or inflate attestation data. Attestations are auditable against credential anchors and execution ledger hashes.

### 5.4 Convention

- Additional fields (`last_active`, `source_relay_url`, `credentials_issued`, `balance_at_departure`) are recommended for richer trust bootstrapping at the destination.
- Relays SHOULD retain departure attestations for 90 days after departure for cross-relay audit.

## 6. Credential Export

The agent exports its portable reputation: verifiable credentials, onchain anchor proofs, and key succession history.

### 6.1 — CredentialBundle

#### Wire format (foundation law)

The agent-signed export of portable reputation. The destination relay reads this document and validates every entry; the source relay does not sign.

```
CredentialBundle {
  motebit_id:       string                    // Agent's MotebitId
  exported_at:      number                    // Unix ms
  credentials:      VerifiableCredential[]    // W3C VC 2.0 format (credential@1.0)
  anchor_proofs:    CredentialAnchorProof[]   // Onchain anchors (credential-anchor@1.0)
  key_succession:   KeySuccessionRecord[]     // Full key rotation history (identity@1.0)
  bundle_hash:      string                    // SHA-256 of canonical JSON of all fields except bundle_hash and signature
  signature:        string                    // Ed25519 by agent over canonical JSON of all fields except signature
}
```

The `CredentialBundle` type in `@motebit/protocol` is the binding machine-readable form.

### 6.2 Foundation Law

- The relay MUST provide a credential export endpoint for agents with an active MigrationToken.
- The relay MUST NOT withhold credentials that were issued to the agent. Credentials are the agent's property.
- The agent signs the bundle — the relay does not. This ensures the agent controls what it presents to the destination.
- `anchor_proofs` are independently verifiable onchain. The destination relay SHOULD spot-check them rather than trusting the bundle signature alone.

### 6.3 Convention

- The relay SHOULD include all credentials, not just active ones. Revoked credentials carry signal (the revocation itself is auditable).
- Large bundles MAY be paginated. The `bundle_hash` covers the complete set.

## 7. Balance Settlement

The agent's virtual account balance is withdrawn via existing settlement rails before departure.

### 7.1 Settlement Flow

1. The relay computes the agent's current virtual account balance (market@1.0).
2. The agent requests withdrawal via the standard withdrawal flow (settlement@1.0).
3. Withdrawal processes through the appropriate settlement rail (fiat, protocol, direct_asset, orchestration).
4. On confirmed withdrawal, the migration advances to `departed`.

### 7.2 — BalanceWaiver

An agent MAY waive its remaining balance to expedite departure. The waiver is a signed statement.

#### Wire format (foundation law)

```
BalanceWaiver {
  motebit_id:     string      // Agent's MotebitId
  waived_amount:  number      // Amount waived in micro-units
  waived_at:      number      // Unix ms
  signature:      string      // Ed25519 by agent
}
```

The `BalanceWaiver` type in `@motebit/protocol` is the binding machine-readable form.

### 7.3 Foundation Law

- The relay MUST process the withdrawal request. Migration is not grounds for withholding funds.
- The relay MUST NOT charge a migration-specific fee. Standard platform fees (settlement@1.0) apply as usual.
- Migration advances to `departed` only after withdrawal is confirmed OR the agent signs a BalanceWaiver.
- A zero-balance agent skips the settling state entirely.

## 8. Arrival at Destination

The agent presents its migration bundle to the destination relay for validation and onboarding.

### 8.1 — MigrationPresentation

#### Wire format (foundation law)

The bundle the agent presents at the destination relay. A destination relay that can parse `MigrationPresentation` and the four component documents has everything it needs to validate onboarding — no out-of-band coordination with the source.

```
MigrationPresentation {
  migration_token:          MigrationToken
  departure_attestation:    DepartureAttestation
  credential_bundle:        CredentialBundle
  identity_file:            string              // Full motebit.md content (identity@1.0)
  presented_at:             number              // Unix ms
  signature:                string              // Ed25519 by agent over canonical JSON of all fields except signature
}
```

The `MigrationPresentation` type in `@motebit/protocol` is the binding machine-readable form.

### 8.2 Validation Steps

The destination relay validates in order:

1. **Identity file.** Parse and verify the motebit.md identity file (identity@1.0). Extract `motebit_id` and current public key.
2. **Migration token.** Fetch the source relay's public key via `/.well-known/motebit.json`. Verify the token's Ed25519 signature. Check `expires_at > now`. Confirm `motebit_id` matches.
3. **Departure attestation.** Verify the attestation's Ed25519 signature against the same source relay public key. Confirm `motebit_id` matches.
4. **Credential bundle.** Verify the agent's Ed25519 signature on the bundle. Confirm `motebit_id` matches.
5. **Anchor proofs.** Spot-check credential anchor proofs onchain (credential-anchor@1.0). At minimum, verify the most recent anchor. Full verification is recommended but not required for onboarding speed.
6. **Key succession.** Validate the full key succession chain (identity@1.0). Each succession record must be signed by both the old and new key. The chain must terminate at the current public key.

### 8.3 Trust Bootstrapping

The destination relay seeds the agent's initial trust level based on the departure attestation's `trust_level`, discounted by a seeding policy.

### 8.4 Foundation Law

- A destination relay that evaluates a MigrationPresentation MUST validate it correctly using the steps in §8.2. Incorrect validation (skipping signature checks, ignoring key succession) is a protocol violation.
- If the relay accepts the agent, the `motebit_id` MUST be preserved. The destination relay MUST NOT require a new identity as a condition of migration.
- Acceptance is a local admission decision. A relay MAY decline to onboard an agent for capacity, commercial, jurisdictional, or policy reasons — but it MUST NOT require identity reset.
- The destination relay MAY apply its own trust seeding policy. The attested `trust_level` is an input, not an obligation.

### 8.5 Convention

- Recommended default: seed trust at one level below the attested level (e.g., attested 0.7 → seed 0.6). This accounts for attestation uncertainty while giving migrating agents a meaningful head start over new registrations.
- The destination relay SHOULD record the source relay and attestation for audit.
- If the source relay is unreachable for public key discovery, the destination relay MAY accept the presentation if anchor proofs independently confirm the agent's reputation.

## 9. Identity Continuity

Migration changes the relay. It does not change the identity.

### 9.1 Foundation Law

- `motebit_id` MUST NOT change during migration. It is a permanent identifier bound to the agent's Ed25519 key lineage, not to any relay.
- The key succession chain (identity@1.0) is the proof of identity continuity. If the agent rotated keys before migration, the full chain must be presented and validated.
- A relay that encounters a `motebit_id` collision (an existing agent with the same ID) MUST reject the presentation. Collisions indicate either a UUID failure or an attack — both require manual resolution.

## 10. Security Considerations

**Relay coercion prevention.** The mandatory token issuance rule (§4.3) prevents relays from holding agents hostage. An agent that cannot obtain a MigrationToken can still depart by presenting its identity file and credentials directly to a destination relay — the attestation is valuable but not required for onboarding if anchor proofs are sufficient.

**Attestation fraud.** A relay could inflate an agent's statistics in the departure attestation. Defense: destination relays cross-check attestation claims against credential anchor proofs, which are independently verifiable onchain. Inflated claims without matching anchors are detectable.

**Token theft.** A stolen MigrationToken is bound to the `motebit_id` and requires the agent's Ed25519 private key to sign the MigrationPresentation. The token alone is insufficient to complete a migration.

**Replay prevention.** MigrationTokens expire (default 72h). Destination relays MUST record accepted `token_id` values and reject duplicates. A token used to complete a migration at one relay MUST NOT be accepted at another.

**Concurrent migration prevention.** Only one active MigrationToken per agent (§4.4). The source relay rejects new MigrationRequests while a token is outstanding, unless the agent explicitly cancels the previous migration.

**Destination relay impersonation.** The migration protocol does not authenticate the destination. The agent chooses where to go. A malicious destination that accepts the presentation but provides poor service is a market problem, not a protocol problem — the agent can migrate again.

## 11. Relationship to Other Specs

| Spec                  | Relationship                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| identity@1.0          | `motebit_id` is permanent across relays. Key succession chain validates identity continuity.                      |
| credential@1.0        | VerifiableCredential format for the credential bundle. Credentials are the agent's portable reputation.           |
| credential-anchor@1.0 | Onchain anchor proofs provide relay-independent reputation verification. The cross-relay source of truth.         |
| settlement@1.0        | Balance withdrawal uses existing settlement rails. No migration-specific payment flows.                           |
| relay-federation@1.0  | Source relay's public key fetched via discovery well-known. Peer notification of agent departure updates routing. |
| market@1.0            | Virtual account balance computed for settlement. Active budget allocations must settle before departure.          |
| delegation@1.0        | Active tasks (submitted or claimed) must complete or expire before departure. No silent task abandonment.         |
| execution-ledger@1.0  | Execution history is referenced by the departure attestation. Ledger hashes anchor attestation auditability.      |

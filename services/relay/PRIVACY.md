# Privacy and operator transparency

This document is the human-readable form of relay.motebit.com's transparency declaration. The signed, machine-verifiable JSON form is served at `/.well-known/motebit-transparency.json`. Both are derived from `services/relay/src/transparency.ts` — the file is the single source of truth.

Doctrine: [`docs/doctrine/operator-transparency.md`](../../docs/doctrine/operator-transparency.md).

## Operator

- **Name** — Motebit, Inc.
- **Entity** — Delaware C Corporation
- **Jurisdiction** — United States
- **Contact** — https://github.com/motebit/motebit/issues

## Retention by layer

### Presence

Tables: `agent_registry`, `relay_identity`, `pairing_sessions`.

Observable:
- motebit_id (UUID v7)
- Ed25519 public key
- endpoint_url
- capabilities list
- registration timestamp
- last heartbeat timestamp
- expires_at TTL
- optional device label (claiming_device_name) when set by user during pairing

Retention window: indefinite while motebit is active; expires per TTL after last heartbeat.

### Operational

Tables: `relay_tasks`, `relay_allocations`, `relay_settlements`, `relay_settlement_proofs`, `relay_receipts`, `relay_pending_withdrawals`, `relay_credentials`, `relay_credential_anchor_batches`, `relay_revocation_events`, `relay_revoked_credentials`, `relay_disputes`, `relay_dispute_evidence`, `relay_dispute_resolutions`, `relay_peers`, `relay_federation_settlements`, `relay_execution_ledgers`, `relay_delegation_edges`, `relay_service_listings`, `relay_accounts`, `relay_subscriptions`, `relay_deposit_log`, `relay_refund_log`, `relay_accepted_migrations`.

Observable:
- every delegation request and its routing decision
- every signed execution receipt the relay verified
- full signed execution receipt JSON, byte-identical to the signer's canonical form, archived per (motebit_id, task_id) for independent audit re-verification
- every settlement (relay-mediated and p2p audit)
- every pending aggregated withdrawal intent enqueued by the sweep, with state machine history until fired or failed
- every credential issued, anchored, or revoked
- every dispute, evidence submission, and resolution
- every federation peer relationship
- every onchain settlement proof attached

Retention window: permanent ledger; required for audit, dispute, and settlement reconciliation.

### Content

none — content is gated at the agent boundary by @motebit/privacy-layer; medical/financial/secret memory categories never cross the surface to the relay

Enforcement: see packages/privacy-layer for the sensitivity gating implementation.

### IP addresses

Handling: **transient**.

client IP is read for rate limiting (in-memory FixedWindowLimiter, no DB) and included in auth-event log lines (Fly.io retention applies, no app-level persistence).

## PII collected

### email

- **Collected when**: user completes Stripe subscription checkout
- **Stored in**: `relay_subscriptions.email`
- **Retention**: while subscription active; required for billing and account recovery
- **Shared with**: Stripe (processor)

### device_label

- **Collected when**: optional user input during multi-device pairing
- **Stored in**: `pairing_sessions.claiming_device_name`
- **Retention**: until pairing session expires (short-lived)
- **Shared with**: none

### push_token

- **Collected when**: user opts into mobile push notifications
- **Stored in**: `relay_push_tokens.push_token`
- **Retention**: until token expires or device is unregistered
- **Shared with**: Apple Push Notification Service (iOS) or Firebase Cloud Messaging (Android)

## Not collected

- real names
- phone numbers
- physical addresses
- long-term IP address logs
- AI prompts at the relay layer (proxy at services/proxy passes them to providers without storage)
- memory content of any sensitivity level above 'none'
- browser fingerprints, advertising identifiers, or cross-site identifiers

## Third-party processors

### Stripe

- **Role**: fiat payment processor
- **Data shared**: email, payment method (held by Stripe), subscription metadata
- **Jurisdiction**: United States
- **DPA / terms**: https://stripe.com/legal/dpa

### x402 facilitator

- **Role**: HTTP-native crypto payment protocol
- **Data shared**: payment payloads (amount, recipient address, tx hash)
- **Jurisdiction**: varies by facilitator deployment
- **DPA / terms**: https://x402.org

### Solana RPC provider

- **Role**: blockchain anchoring + sovereign settlement verification
- **Data shared**: public credential hashes, revocation memos, transaction lookups
- **Jurisdiction**: varies by RPC operator
- **DPA / terms**: configured via SOLANA_RPC_URL env var

### Apple Push Notification Service

- **Role**: mobile push delivery (iOS only, opt-in)
- **Data shared**: push token, notification payload
- **Jurisdiction**: United States
- **DPA / terms**: https://www.apple.com/legal/internet-services/push/

### Firebase Cloud Messaging

- **Role**: mobile push delivery (Android only, opt-in)
- **Data shared**: push token, notification payload
- **Jurisdiction**: United States
- **DPA / terms**: https://firebase.google.com/terms/data-processing-terms

### Anthropic

- **Role**: AI inference provider (via services/proxy)
- **Data shared**: model prompts and responses (per request, not retained at proxy beyond cache TTL)
- **Jurisdiction**: United States
- **DPA / terms**: https://www.anthropic.com/legal/dpa

### Fly.io

- **Role**: container hosting for relay and reference services
- **Data shared**: host-level metadata (no app data beyond what Fly captures from log streams)
- **Jurisdiction**: United States
- **DPA / terms**: https://fly.io/legal/dpa

### Vercel

- **Role**: edge hosting for the web app and proxy service
- **Data shared**: edge HTTP request metadata
- **Jurisdiction**: United States
- **DPA / terms**: https://vercel.com/legal/dpa

## Analytics

- **Relay-side**: none
- **Web-side**: none committed yet — Plausible (self-hosted) is the planned choice per docs/doctrine/operator-transparency.md anti-patterns

## Honest gaps

- onchain anchor of this declaration is not yet in place; only cached copies of the JSON survive operator deletion. See `spec/relay-transparency-v1.md` (when shipped) for the mandatory-anchor wire format.
- Fly.io and Vercel log retention windows are governed by their respective DPAs and are not separately enforced by motebit code.
- receipts verified before the relay_receipts archive landed (migration v10) retained only `receipt_hash` in `relay_settlements`; their full canonical JSON was not preserved and cannot be reconstructed. Receipts verified on and after v10 are archived byte-identically.

## Verification

The JSON form at `/.well-known/motebit-transparency.json` is signed by the relay's Ed25519 identity key under suite `motebit-jcs-ed25519-hex-v1`. Verifiers compute `sha256(canonicalJson({spec, declared_at, relay_id, relay_public_key, content}))` and check the signature against `relay_public_key`. No relay contact is required to verify a cached copy.

Onchain anchoring of the declaration hash will land with `spec/relay-transparency-v1.md`. Until then the disappearance test is partially passed: a cached JSON proves what Motebit claimed at a point in time, but a coordinated deletion of the published copy and absence of a third-party cache would erase the public claim. This gap is documented in `honest_gaps` above.


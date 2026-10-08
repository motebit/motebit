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

Tables: `agent_registry`, `relay_registry_key_evidence`, `relay_guardian_evidence`, `relay_identity`, `pairing_sessions`.

Observable:
- motebit_id (UUID v7)
- Ed25519 public key
- endpoint_url
- capabilities list
- registration timestamp
- last heartbeat timestamp
- expires_at TTL
- which evidence proved the registry public key, and when (relay_registry_key_evidence)
- each guardian public key the identity set, the identity key the setting request proved, which evidence proved it, and when (relay_guardian_evidence)
- optional device label (claiming_device_name) when set by user during pairing

Retention window: discovery fields (endpoint_url, capabilities) are cleared when the motebit deregisters, is revoked, or 90 days pass without a heartbeat (the lease); the row itself — motebit_id, public key, guardian key, settlement configuration — is retained until revocation, and revocation keeps the row with its revoked mark so the identity's binding and its end stay verifiable (#703, since 2026-09-24).

### Device registry

Tables: `devices`.

Observable:
- device_id
- the motebit_id the device belongs to
- the device's Ed25519 public key
- registered_at timestamp
- optional device_name
- an opaque per-device bearer token (never the identity's private key)
- optional self-issued hardware-attestation credential (JSON) for the device

Retention window: indefinite — device rows carry no TTL and are never reaped for silence; there is no automatic removal.

### Accepted proofs of possession

Tables: `relay_key_proofs_accepted`.

Observable:
- the motebit_id and Ed25519 public key a proof of possession named
- the proof's signature
- which registration door accepted it, and when

Retention window: 11 minutes — long enough to cover the proof's ±5-minute validity window, pruned on the next accepted proof after that.

### Operational

Tables: `relay_tasks`, `relay_allocations`, `relay_settlements`, `relay_settlement_proofs`, `relay_receipts`, `relay_pending_withdrawals`, `relay_credentials`, `relay_credential_anchor_batches`, `relay_revocation_events`, `relay_revoked_credentials`, `relay_agent_revocations`, `relay_identity_revocations`, `relay_disputes`, `relay_dispute_evidence`, `relay_dispute_resolutions`, `relay_dispute_fund_actions`, `relay_peers`, `relay_federation_settlements`, `relay_execution_ledgers`, `relay_delegation_edges`, `relay_service_listings`, `relay_accounts`, `relay_subscriptions`, `relay_deposit_log`, `relay_refund_log`, `relay_accepted_migrations`, `relay_treasury_reconciliations`, `relay_p2p_proof_claims`, `relay_settlement_payee_corrections`, `relay_x402_settlements`, `relay_withdrawal_chain_claims`, `relay_withdrawal_payout_attempts`, `relay_withdrawal_payout_queue`.

Observable:
- every delegation request and its routing decision
- every P2P payment proof bound to the one task it admitted (tx_hash, task_id, submitting motebit_id, whether that submitter was proven by a signed token, claimed_at — no content): one proof funds at most one task; a claim is written in the admission transaction and never deleted (migration v47, #918)
- every x402 payment the relay settles for a task submission (the EIP-3009 authorization's payer address and nonce, network, token, treasury address, amount, validAfter and validBefore, the Idempotency-Key and path motebit_id it was presented under, the delegator credited, the task id reserved for it, status pending/credited/failed, tx hash, failure reason, the reconciler's block-scan range and cursors (start, fixed end, pass cursor, last visit), expiry-observation and re-check bookkeeping, the latest chain observation, whether an AuthorizationUsed log was seen (with the transaction hash, for the operator), and the chain-time visit cadence (wall-clock and the confirmed chain head's timestamp at each), the consumed Transfer log index, timestamps — no content): written before the facilitator is called, so a settle whose outcome is unknown is reconciled from the chain's EIP-3009 events (proof of execution; a cancelled authorization is never credited) and credited once; one authorization is settled at most once; never deleted (migration v49, #907)
- every signed execution receipt the relay verified
- full signed execution receipt JSON, byte-identical to the signer's canonical form, archived per (motebit_id, task_id) for independent audit re-verification
- every settlement (relay-mediated and p2p audit), naming the signature of the receipt it settled — a task settles once, only on the receipt its answer is claimed for (#890 round 9)
- every pending aggregated withdrawal intent enqueued by the sweep, with state machine history until fired or failed
- every Solana transaction a withdrawal payout signs (withdrawal id, transaction signature, whether it is the payout or the kill of its durable nonce, the nonce account and nonce value it was signed over — or, for a payout an earlier build signed, its last valid block height — when it was recorded, and its FINALIZED chain status once read: succeeded or failed, the slot, when it was read; no content), recorded before the transaction is broadcast, which withdrawals were claimed under that record, and which Solana withdrawals are queued for the treasury's nonce lane (withdrawal id, when queued): whether the payout landed is decided from the finalized statuses of exactly these transactions (#949, #990); never deleted (a queue entry is removed when its withdrawal is claimed or leaves pending)
- every credential issued, anchored, or revoked
- every operator agent de-listing and reinstatement — the signed, append-only `AgentRevocationRecord` history (motebit_id, reason, actor, note, effective_at) served publicly at GET /api/v1/agents/revocations and verifiable against the relay's pinned key; a de-list removes an agent from Discover only — its identity, key, succession chain, and receipts stay served
- every identity revocation (POST /api/v1/agents/:motebitId/revoke) — motebit_id, the time it was recorded, and the key the revoking token verified under (or `operator`); kept for every identity the relay authenticates, registered or not, until the identity proves its key by migrating in or the operator reinstates the listing (#787)
- every dispute, evidence submission, and resolution
- every federation peer relationship
- every onchain settlement proof attached
- every treasury-reconciliation cycle on mainnet — the recorded x402 platform-fee sum, the onchain USDC balance at the operator's fee-collection address, the drift between them, and the consistent flag — append-only audit log
- every Solana treasury-reconciliation cycle — the recorded verified-p2p platform-fee sum, the onchain USDC balance at the relay's identity-derived Solana treasury wallet, the drift between them, and the consistent flag — append-only audit log, written alongside EVM rows in the same table and discriminated by CAIP-2 chain

Retention window: permanent ledger; required for audit, dispute, and settlement reconciliation.

### Content

Tables: `events`, `relay_event_seq`, `relay_event_seq_counter`, `sync_conversations`, `sync_conversation_messages`, `memory_nodes`.

Observable:
- synced event-log entries, including memory_formed payloads at sensitivity none/personal — content above that ceiling is replaced with [REDACTED] at ingress, before any write (services/relay/src/redaction.ts; historical rows scrubbed by migration v34)
- the relay's per-identity ingest sequence for each stored event (seq, event_id, motebit_id — no content), and each identity's sequence counter (motebit_id, last seq assigned): the pull cursor devices sync by, counted per identity so no identity's cursor reveals another's write volume or timing; a seq row is written with its event and deleted with it, the counter only ever increases (migration v46, services/relay/src/event-seq.ts)
- conversation titles, summaries, and message content synced for multi-device continuity — protected by the agent-side outbound sensitivity gate, and stored as opaque ciphertext when the client enables end-to-end encrypted sync
- memory node projections for cross-device restore, subject to the same sensitivity ceiling

Retention window: while the motebit's sync data is active; memory content above the none/personal sensitivity ceiling is never stored (ingress-redacted before write); a synced DeleteRequested for a memory node erases that node's stored memory_formed content from the relay's event store (deletion propagation — services/relay/src/deletion-propagation.ts); clients MAY end-to-end encrypt event payloads, in which case the relay stores ciphertext only and erasure is the client-side key lifecycle.
Enforcement: three layers — agent-boundary gating in packages/privacy-layer, relay ingress redaction in services/relay/src/redaction.ts (applied on both the HTTP and WebSocket sync push paths before eventStore.append), and optional client-side E2E encryption in packages/sync-engine.

### Auth events

Tables: `relay_auth_events`.

Observable:
- every presentation of the operator master token — HTTP method, route path, request correlation id
- every refused signed token — the token's claimed motebit_id, the audience the route expected, the rejection reason, route path, correlation id
- never the token bytes; never the client IP (see ip_addresses below)

Retention window: 30-day rolling window, swept every minute by the task-cleanup loop; an operator's audit aid ("who presented the master token, what did we refuse") readable at GET /api/v1/admin/auth-events, not a surveillance log.

### Task routes

Tables: `relay_task_routes`, `relay_task_answers`, `relay_result_deliveries`.

Observable:
- for every task the relay hands to an executor: the task id, the executor's motebit_id, the peer relay it was forwarded through (empty when local), whether the hand-off was this relay's own admission or a peer's inbound forward, and when — no content, no prompt, no amount; a receipt for the task is accepted only from a recorded executor through its recorded peer, under the task's own origin (migrations v50, v51)
- for every answered task: its answer — the executor's signed receipt (its motebit_id, status, result hash, and the result text the executor signed), the receipt its settlement is claimed for, and when — so the task's poll answers the same after the queue forgets it (#890 round 9)
- for every task a peer forwarded here and this relay's agent answered: that its answer is owed to the origin relay — the task id, the origin relay id, the delivery attempts, the last error, and when it was delivered — so the result is retried until the origin acknowledges it (#890 round 10, migration v53); the answer itself is the archived one above

Retention window: 7 days from the hand-off (a route) or the answer (an answer), swept every minute by the task-cleanup loop — beyond the 24-hour idempotency window, the longest any reader consults a route or an answer; an answer whose settlement is claimed but not yet written is kept while its task is still queued (a queued task with such an answer is held up to 7 days past its expiry), so the next retry or the settlement-recovery sweep settles it; an owed result is kept while it is still owed, and 7 days from its first attempt once delivered, refused or out of attempts.

### Machine roster

Tables: `relay_host_roster_entries`, `relay_host_liveness`.

Observable:
- the sovereign-signed HostEnrollment / HostRetirement artifacts a motebit presents (motebit_id, device_id, the signing public key, a self-asserted time, the signature), stored verbatim as signed; the relay never mints, edits, reorders, expires, or evaluates one, and never decides which machines are members
- when the relay received each artifact
- for a connection that proved its device id with a signed device token AND announced that it hosts unattended work (unattended_runtime): ONE overwritten value per (device_id, the key that token verified under) — the last time this relay held a socket bound as that pair open (there is no heartbeat yet, so a half-open socket reads as open; and after a crash without the shutdown flush it is a lower bound, up to five minutes early) — never a history of connections, and not the capabilities it announced
- nothing stored about any other connection — phones, browsers, desktop sessions, and sockets that did not prove their device id; sockets the relay believes open are reported live as two counts per device and key — every bound socket, and the subset that is a host's liveness (device id verified and announcing unattended_runtime; derived from the same live connections, nothing new is kept) — and never persisted
- no entry larger than 4096 bytes (canonical JSON, signature included) is held — refused as too_large — and a presentation's request body is capped at 266,240 bytes
- never the client IP

Retention window: signed roster entries: indefinite — never pruned by age (a retirement must stay present for remove-wins to hold, and a machine silent for a year is still a line) and no removal path exists, per-identity erase included; growth is bounded by per-signer-key caps. Liveness values: deleted 90 days after last_seen_at, swept every five minutes by the task-cleanup loop, except while a socket bound as that (device_id, key) that announces unattended_runtime is open.
Access: first-person only: readable and writable solely with a device token of that motebit (GET/POST /api/v1/agents/:motebitId/roster, audience device:auth); the operator master token is refused; never published, ranked, aggregated, reduced, or served to another identity.

### IP addresses

Handling: **transient**.

client IP is read for rate limiting (in-memory FixedWindowLimiter, no DB) and included in auth-event LOG LINES only (Fly.io retention applies); the relay's own auth-event record (relay_auth_events) deliberately has no IP column — no app-level persistence.

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
- memory content of any sensitivity level above 'personal' (ingress-redacted before storage)
- browser fingerprints, advertising identifiers, or cross-site identifiers

## Third-party processors

### npm registry

- **Role**: release witness source (services/relay/src/release-witness.ts). The relay fetches PUBLIC package metadata and tarballs for the `motebit` package to sign the release witness served at /.well-known/motebit-releases.json. Read-only observation: no user, agent, or operator data is transmitted — the request itself (relay IP, user-agent) is the only signal npm receives.
- **Data shared**: none (public registry reads only; requester IP visible to npm as with any HTTP fetch)
- **Jurisdiction**: United States (npm, Inc. / GitHub / Microsoft)
- **DPA / terms**: https://docs.npmjs.com/policies/privacy

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

### Bridge

- **Role**: Crypto-to-fiat off-ramp orchestration (services/relay/src/offramp.ts). Forwards a Solana USDC transfer from a motebit's sovereign wallet through Bridge's deposit address, with Bridge converting to fiat and ACH-ing to the user's bank. Used only when the operator configures a Bridge API key + customer ID at startup; otherwise the rail is omitted from `/health/ready`.
- **Data shared**: Bridge customer_id (operator-scoped), external_account_id (per user, supplied at withdrawal time), transfer instructions (amount, source rail, source currency, deposit address), settlement transaction hash
- **Jurisdiction**: United States
- **DPA / terms**: https://bridge.xyz/legal

### Coinbase Developer Platform (x402 production facilitator)

- **Role**: Mainnet x402 facilitator — JWT-authed per-request settlement of relay-mediated x402 payments on Base mainnet (and other supported chains). Used only when X402_TESTNET=false and CDP_API_KEY_ID + CDP_API_KEY_SECRET are configured.
- **Data shared**: payment authorization payloads, settlement requests (amount, recipient address, network), request-signing JWT bound to method+host+path
- **Jurisdiction**: United States
- **DPA / terms**: https://www.coinbase.com/legal/cloud/terms

### EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)

- **Role**: Treasury reconciliation onchain reads — eth_call balanceOf(treasuryAddress) on the chain's USDC contract every 15 min when X402_TESTNET=false. No write path; observability only. The address is publicly observable onchain; the RPC reads no operator-private data.
- **Data shared**: public treasury address, USDC contract address, block number
- **Jurisdiction**: varies by RPC operator (default https://mainnet.base.org)
- **DPA / terms**: configured via deposit-detector's DEFAULT_RPC_URLS map

### Solana RPC provider

- **Role**: blockchain anchoring + sovereign settlement verification
- **Data shared**: public credential hashes, revocation memos, transaction lookups
- **Jurisdiction**: varies by RPC operator
- **DPA / terms**: configured via SOLANA_RPC_URL env var

### Expo Push Service

- **Role**: mobile push transport (forwards wake-signal payloads to APNS/FCM)
- **Data shared**: push token, wake-signal payload (motebit_id, pending task count, timestamp — see invariant below)
- **Jurisdiction**: United States
- **DPA / terms**: https://expo.dev/terms

### Apple Push Notification Service

- **Role**: mobile push delivery (iOS only, opt-in)
- **Data shared**: push token, wake-signal payload (motebit_id, pending task count, timestamp — no message body, no memory content, no prompt or response text; relay-side invariant enforced by the `PushPayload` type in `services/relay/src/push-adapter.ts`)
- **Jurisdiction**: United States
- **DPA / terms**: https://www.apple.com/legal/internet-services/push/

### Firebase Cloud Messaging

- **Role**: mobile push delivery (Android only, opt-in)
- **Data shared**: push token, wake-signal payload (motebit_id, pending task count, timestamp — no message body, no memory content, no prompt or response text; relay-side invariant enforced by the `PushPayload` type in `services/relay/src/push-adapter.ts`)
- **Jurisdiction**: United States
- **DPA / terms**: https://firebase.google.com/terms/data-processing-terms

### Anthropic

- **Role**: AI inference provider (via services/proxy when motebit-cloud routing selects an Anthropic model)
- **Data shared**: model prompts and responses (per request, not retained at proxy beyond cache TTL)
- **Jurisdiction**: United States
- **DPA / terms**: https://www.anthropic.com/legal/dpa

### OpenAI

- **Role**: AI inference provider (via services/proxy when motebit-cloud routing selects an OpenAI model)
- **Data shared**: model prompts and responses (per request, not retained at proxy beyond cache TTL)
- **Jurisdiction**: United States
- **DPA / terms**: https://openai.com/policies/data-processing-addendum

### Google (Generative Language API)

- **Role**: AI inference provider (via services/proxy when motebit-cloud routing selects a Gemini model)
- **Data shared**: model prompts and responses (per request, not retained at proxy beyond cache TTL)
- **Jurisdiction**: United States
- **DPA / terms**: https://cloud.google.com/terms/data-processing-addendum

### Groq

- **Role**: AI inference provider (via services/proxy when motebit-cloud routing selects an open-source model on Groq LPU hardware: Llama 3.3 70B, GPT-OSS 120B)
- **Data shared**: model prompts and responses (per request, not retained at proxy beyond cache TTL)
- **Jurisdiction**: United States
- **DPA / terms**: https://groq.com/terms-of-use

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

- Fly.io and Vercel log retention windows are governed by their respective DPAs and are not separately enforced by motebit code.
- Before migration v34, memory_formed events above the personal sensitivity ceiling were stored unredacted at the relay (redaction ran only on read paths). v34 scrubbed those rows in place; database backups created during that window may retain unredacted copies until backup retention expires.
- Before migration v35, a memory deleted by its subject (a synced DeleteRequested) did not erase the stored memory_formed content for deletions that predated deletion propagation — including none/personal-sensitivity nodes the v34 scrub skips. v35 backfills those historical deletions; database backups from before it may retain the content until backup retention expires.
- receipts verified before the relay_receipts archive landed (migration v10) retained only `receipt_hash` in `relay_settlements`; their full canonical JSON was not preserved and cannot be reconstructed. Receipts verified on and after v10 are archived byte-identically.

## Verification

The JSON form at `/.well-known/motebit-transparency.json` is signed by the relay's Ed25519 identity key under suite `motebit-jcs-ed25519-hex-v1`. Verifiers compute `sha256(canonicalJson({spec, declared_at, relay_id, relay_public_key, content}))` and check the signature against `relay_public_key`. No relay contact is required to verify a cached copy.

The declaration hash is committed onchain via the Solana Memo program at boot when the relay is configured with `SOLANA_RPC_URL` and its Ed25519-derived Solana wallet is funded (per `spec/relay-transparency-v1.md` §5 — Stage 2 trust-anchor primitive). A third party can find the anchor transaction by searching Solana memos signed by `relay_public_key` and matching the declaration's `hash` field, proving Motebit's claim even if the published copy disappears. Without a configured anchor, the declaration remains valid via trust-on-first-use over HTTPS — the anchor is additive evidence.


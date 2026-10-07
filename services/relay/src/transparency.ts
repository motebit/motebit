/**
 * Operator transparency declaration for relay.motebit.com.
 *
 * Stage 1.5 of the operator-transparency doctrine
 * (`docs/doctrine/operator-transparency.md`). This module is the single
 * source of truth for what relay.motebit.com retains, what processors it
 * uses, and what jurisdiction it operates under. Both PRIVACY.md and
 * /.well-known/motebit-transparency.json are derived from the same
 * declaration object below — disagreement between the two artifacts is a
 * sibling-boundary violation enforceable by the test in __tests__.
 *
 * Honesty rule: every claim in DECLARATION_CONTENT must reflect observable
 * behavior in this codebase. If you ship a code change that adds a new
 * processor, retains a new field, or changes a retention window, this file
 * must change in the same PR. Otherwise the relay's signed declaration
 * lies, and the doctrine the declaration cites becomes worthless.
 *
 * Stage 2 onchain anchoring is lifted forward (per `index.ts` startup
 * wiring + `spec/relay-transparency-v1.md` §5): when the relay is
 * configured with `SOLANA_RPC_URL` and its identity-derived Solana
 * wallet is funded, the declaration hash is committed via the Solana
 * Memo program at boot. A third party can find the anchor by searching
 * memos signed by `relay_public_key` and matching the declaration's
 * `hash` field — proves Motebit's claim even if the published copy
 * disappears. Without a configured anchor, declarations remain valid
 * via trust-on-first-use over HTTPS; the anchor is additive evidence.
 */

import type { Hono } from "hono";
import { canonicalJson, sign, bytesToHex, sha256 } from "@motebit/encryption";
import type { SignedTransparencyDeclaration } from "@motebit/protocol";
import { TRANSPARENCY_SPEC_ID, TRANSPARENCY_SUITE } from "@motebit/protocol";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import { anchorSubmitPacerFor } from "./anchor-submit-pacing.js";
import { submitRecordedAnchor, type AnchorBroadcastHooks } from "./anchor-broadcasts.js";
import type { DatabaseDriver } from "@motebit/persistence";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";

const logger = createLogger({ service: "relay", module: "transparency" });

// ---------------------------------------------------------------------------
// Source of truth — every field here must match observable retention behavior
// ---------------------------------------------------------------------------

/**
 * Spec version identifier. The wire format is codified in
 * `spec/relay-transparency-v1.md` (Stage 2b-i, shipped 2026-05-11);
 * the declaration shape is the canonical
 * `SignedTransparencyDeclaration` from `@motebit/protocol`. Operators
 * MAY bump the draft suffix when the spec's wire format breaks.
 */
const SPEC_DRAFT_ID = TRANSPARENCY_SPEC_ID;

/** Cryptosuite for the declaration signature — pinned by spec/relay-transparency-v1.md §3.1. */
const SIGNATURE_SUITE = TRANSPARENCY_SUITE;

/**
 * The canonical declaration content. Edit here and both the markdown and
 * the JSON regenerate. Add no field that does not correspond to a real
 * observation about this relay's retention behavior.
 */
export const DECLARATION_CONTENT = {
  operator: {
    name: "Motebit, Inc.",
    entity_type: "Delaware C Corporation",
    jurisdiction: "United States",
    contact: "https://github.com/motebit/motebit/issues",
  },
  retention: {
    presence: {
      tables: [
        "agent_registry",
        "relay_registry_key_evidence",
        "relay_identity",
        "pairing_sessions",
      ],
      observable: [
        "motebit_id (UUID v7)",
        "Ed25519 public key",
        "endpoint_url",
        "capabilities list",
        "registration timestamp",
        "last heartbeat timestamp",
        "expires_at TTL",
        "which evidence proved the registry public key, and when (relay_registry_key_evidence)",
        "optional device label (claiming_device_name) when set by user during pairing",
      ],
      retention_window:
        "discovery fields (endpoint_url, capabilities) are cleared when the motebit deregisters, is revoked, or 90 days pass without a heartbeat (the lease); the row itself — motebit_id, public key, guardian key, settlement configuration — is retained until revocation, and revocation keeps the row with its revoked mark so the identity's binding and its end stay verifiable (#703, since 2026-09-24)",
    },
    // Its own category, not a line under presence: presence is TTL-governed
    // and this table is not, and one `retention_window` string per category
    // cannot say both. Undeclared until 2026-09-24 (#696).
    device_registry: {
      tables: ["devices"],
      observable: [
        "device_id",
        "the motebit_id the device belongs to",
        "the device's Ed25519 public key",
        "registered_at timestamp",
        "optional device_name",
        "an opaque per-device bearer token (never the identity's private key)",
        "optional self-issued hardware-attestation credential (JSON) for the device",
      ],
      retention_window:
        "indefinite — device rows carry no TTL and are never reaped for silence; there is no automatic removal",
    },
    // Accepted proofs of possession (#875 review F2): the signature of each
    // accepted device-registration body, so an exact replay inside its
    // 5-minute window writes nothing. Pruned past the window.
    key_proofs_accepted: {
      tables: ["relay_key_proofs_accepted"],
      observable: [
        "the motebit_id and Ed25519 public key a proof of possession named",
        "the proof's signature",
        "which registration door accepted it, and when",
      ],
      retention_window:
        "11 minutes — long enough to cover the proof's ±5-minute validity window, pruned on the next accepted proof after that",
    },
    operational: {
      tables: [
        "relay_tasks",
        "relay_allocations",
        "relay_settlements",
        "relay_settlement_proofs",
        "relay_receipts",
        "relay_pending_withdrawals",
        "relay_credentials",
        "relay_credential_anchor_batches",
        "relay_revocation_events",
        "relay_revoked_credentials",
        "relay_agent_revocations",
        "relay_identity_revocations",
        "relay_disputes",
        "relay_dispute_evidence",
        "relay_dispute_resolutions",
        "relay_dispute_fund_actions",
        "relay_peers",
        "relay_federation_settlements",
        "relay_execution_ledgers",
        "relay_delegation_edges",
        "relay_service_listings",
        "relay_accounts",
        "relay_subscriptions",
        "relay_deposit_log",
        "relay_refund_log",
        "relay_accepted_migrations",
        "relay_treasury_reconciliations",
        "relay_p2p_proof_claims",
        "relay_settlement_payee_corrections",
        "relay_x402_settlements",
        "relay_withdrawal_chain_claims",
        "relay_withdrawal_payout_attempts",
        "relay_withdrawal_payout_queue",
      ],
      observable: [
        "every delegation request and its routing decision",
        "every P2P payment proof bound to the one task it admitted (tx_hash, task_id, submitting motebit_id, whether that submitter was proven by a signed token, claimed_at — no content): one proof funds at most one task; a claim is written in the admission transaction and never deleted (migration v47, #918)",
        "every x402 payment the relay settles for a task submission (the EIP-3009 authorization's payer address and nonce, network, token, treasury address, amount, validAfter and validBefore, the Idempotency-Key and path motebit_id it was presented under, the delegator credited, the task id reserved for it, status pending/credited/failed, tx hash, failure reason, the reconciler's block-scan range and cursors (start, fixed end, pass cursor, last visit), expiry-observation and re-check bookkeeping, the latest chain observation, whether an AuthorizationUsed log was seen (with the transaction hash, for the operator), and the chain-time visit cadence (wall-clock and the confirmed chain head's timestamp at each), the consumed Transfer log index, timestamps — no content): written before the facilitator is called, so a settle whose outcome is unknown is reconciled from the chain's EIP-3009 events (proof of execution; a cancelled authorization is never credited) and credited once; one authorization is settled at most once; never deleted (migration v49, #907)",
        "every signed execution receipt the relay verified",
        "full signed execution receipt JSON, byte-identical to the signer's canonical form, archived per (motebit_id, task_id) for independent audit re-verification",
        "every settlement (relay-mediated and p2p audit), naming the signature of the receipt it settled — a task settles once, only on the receipt its answer is claimed for (#890 round 9)",
        "every pending aggregated withdrawal intent enqueued by the sweep, with state machine history until fired or failed",
        "every Solana transaction a withdrawal payout signs (withdrawal id, transaction signature, whether it is the payout or the kill of its durable nonce, the nonce account and nonce value it was signed over — or, for a payout an earlier build signed, its last valid block height — when it was recorded, and its FINALIZED chain status once read: succeeded or failed, the slot, when it was read; no content), recorded before the transaction is broadcast, which withdrawals were claimed under that record, and which Solana withdrawals are queued for the treasury's nonce lane (withdrawal id, when queued): whether the payout landed is decided from the finalized statuses of exactly these transactions (#949, #990); never deleted (a queue entry is removed when its withdrawal is claimed or leaves pending)",
        "every credential issued, anchored, or revoked",
        "every operator agent de-listing and reinstatement — the signed, append-only `AgentRevocationRecord` history (motebit_id, reason, actor, note, effective_at) served publicly at GET /api/v1/agents/revocations and verifiable against the relay's pinned key; a de-list removes an agent from Discover only — its identity, key, succession chain, and receipts stay served",
        "every identity revocation (POST /api/v1/agents/:motebitId/revoke) — motebit_id, the time it was recorded, and the key the revoking token verified under (or `operator`); kept for every identity the relay authenticates, registered or not, until the identity proves its key by migrating in or the operator reinstates the listing (#787)",
        "every dispute, evidence submission, and resolution",
        "every federation peer relationship",
        "every onchain settlement proof attached",
        "every treasury-reconciliation cycle on mainnet — the recorded x402 platform-fee sum, the onchain USDC balance at the operator's fee-collection address, the drift between them, and the consistent flag — append-only audit log",
        "every Solana treasury-reconciliation cycle — the recorded verified-p2p platform-fee sum, the onchain USDC balance at the relay's identity-derived Solana treasury wallet, the drift between them, and the consistent flag — append-only audit log, written alongside EVM rows in the same table and discriminated by CAIP-2 chain",
      ],
      retention_window:
        "permanent ledger; required for audit, dispute, and settlement reconciliation",
    },
    content: {
      tables: [
        "events",
        "relay_event_seq",
        "relay_event_seq_counter",
        "sync_conversations",
        "sync_conversation_messages",
        "memory_nodes",
      ],
      observable: [
        "synced event-log entries, including memory_formed payloads at sensitivity none/personal — content above that ceiling is replaced with [REDACTED] at ingress, before any write (services/relay/src/redaction.ts; historical rows scrubbed by migration v34)",
        "the relay's per-identity ingest sequence for each stored event (seq, event_id, motebit_id — no content), and each identity's sequence counter (motebit_id, last seq assigned): the pull cursor devices sync by, counted per identity so no identity's cursor reveals another's write volume or timing; a seq row is written with its event and deleted with it, the counter only ever increases (migration v46, services/relay/src/event-seq.ts)",
        "conversation titles, summaries, and message content synced for multi-device continuity — protected by the agent-side outbound sensitivity gate, and stored as opaque ciphertext when the client enables end-to-end encrypted sync",
        "memory node projections for cross-device restore, subject to the same sensitivity ceiling",
      ],
      retention_window:
        "while the motebit's sync data is active; memory content above the none/personal sensitivity ceiling is never stored (ingress-redacted before write); a synced DeleteRequested for a memory node erases that node's stored memory_formed content from the relay's event store (deletion propagation — services/relay/src/deletion-propagation.ts); clients MAY end-to-end encrypt event payloads, in which case the relay stores ciphertext only and erasure is the client-side key lifecycle",
      enforcement:
        "three layers — agent-boundary gating in packages/privacy-layer, relay ingress redaction in services/relay/src/redaction.ts (applied on both the HTTP and WebSocket sync push paths before eventStore.append), and optional client-side E2E encryption in packages/sync-engine",
    },
    auth_events: {
      tables: ["relay_auth_events"],
      observable: [
        "every presentation of the operator master token — HTTP method, route path, request correlation id",
        "every refused signed token — the token's claimed motebit_id, the audience the route expected, the rejection reason, route path, correlation id",
        "never the token bytes; never the client IP (see ip_addresses below)",
      ],
      retention_window:
        '30-day rolling window, swept every minute by the task-cleanup loop; an operator\'s audit aid ("who presented the master token, what did we refuse") readable at GET /api/v1/admin/auth-events, not a surveillance log',
    },
    // Who the relay handed each task to (#890 round 6): read by every
    // receipt door and the receipt archive, swept by age.
    task_routes: {
      tables: ["relay_task_routes", "relay_task_answers", "relay_result_deliveries"],
      observable: [
        "for every task the relay hands to an executor: the task id, the executor's motebit_id, the peer relay it was forwarded through (empty when local), whether the hand-off was this relay's own admission or a peer's inbound forward, and when — no content, no prompt, no amount; a receipt for the task is accepted only from a recorded executor through its recorded peer, under the task's own origin (migrations v50, v51)",
        "for every answered task: its answer — the executor's signed receipt (its motebit_id, status, result hash, and the result text the executor signed), the receipt its settlement is claimed for, and when — so the task's poll answers the same after the queue forgets it (#890 round 9)",
        "for every task a peer forwarded here and this relay's agent answered: that its answer is owed to the origin relay — the task id, the origin relay id, the delivery attempts, the last error, and when it was delivered — so the result is retried until the origin acknowledges it (#890 round 10, migration v53); the answer itself is the archived one above",
      ],
      retention_window:
        "7 days from the hand-off (a route) or the answer (an answer), swept every minute by the task-cleanup loop — beyond the 24-hour idempotency window, the longest any reader consults a route or an answer; an answer whose settlement is claimed but not yet written is kept while its task is still queued (a queued task with such an answer is held up to 7 days past its expiry), so the next retry or the settlement-recovery sweep settles it; an owed result is kept while it is still owed, and 7 days from its first attempt once delivered, refused or out of attempts",
    },
    // The machine roster (docs/doctrine/machine-roster.md; design:
    // docs/proposals/machine-roster-relay-v1.md D3/D4). Its own category:
    // one table is indefinite with no removal path, the other TTL-governed,
    // and one retention_window string per category must say both.
    machine_roster: {
      tables: ["relay_host_roster_entries", "relay_host_liveness"],
      observable: [
        "the sovereign-signed HostEnrollment / HostRetirement artifacts a motebit presents (motebit_id, device_id, the signing public key, a self-asserted time, the signature), stored verbatim as signed; the relay never mints, edits, reorders, expires, or evaluates one, and never decides which machines are members",
        "when the relay received each artifact",
        "for a connection that proved its device id with a signed device token AND announced that it hosts unattended work (unattended_runtime): ONE overwritten value per (device_id, the key that token verified under) — the last time this relay held a socket bound as that pair open (there is no heartbeat yet, so a half-open socket reads as open; and after a crash without the shutdown flush it is a lower bound, up to five minutes early) — never a history of connections, and not the capabilities it announced",
        "nothing stored about any other connection — phones, browsers, desktop sessions, and sockets that did not prove their device id; sockets the relay believes open are reported live as two counts per device and key — every bound socket, and the subset that is a host's liveness (device id verified and announcing unattended_runtime; derived from the same live connections, nothing new is kept) — and never persisted",
        "no entry larger than 4096 bytes (canonical JSON, signature included) is held — refused as too_large — and a presentation's request body is capped at 266,240 bytes",
        "never the client IP",
      ],
      retention_window:
        "signed roster entries: indefinite — never pruned by age (a retirement must stay present for remove-wins to hold, and a machine silent for a year is still a line) and no removal path exists, per-identity erase included; growth is bounded by per-signer-key caps. Liveness values: deleted 90 days after last_seen_at, swept every five minutes by the task-cleanup loop, except while a socket bound as that (device_id, key) that announces unattended_runtime is open",
      access:
        "first-person only: readable and writable solely with a device token of that motebit (GET/POST /api/v1/agents/:motebitId/roster, audience device:auth); the operator master token is refused; never published, ranked, aggregated, reduced, or served to another identity",
    },
    ip_addresses: {
      handling: "transient",
      detail:
        "client IP is read for rate limiting (in-memory FixedWindowLimiter, no DB) and included in auth-event LOG LINES only (Fly.io retention applies); the relay's own auth-event record (relay_auth_events) deliberately has no IP column — no app-level persistence",
      no_app_db_storage: true,
    },
  },
  declared_collected_pii: [
    {
      kind: "email",
      collected_when: "user completes Stripe subscription checkout",
      stored_in: "relay_subscriptions.email",
      retention: "while subscription active; required for billing and account recovery",
      shared_with: "Stripe (processor)",
    },
    {
      kind: "device_label",
      collected_when: "optional user input during multi-device pairing",
      stored_in: "pairing_sessions.claiming_device_name",
      retention: "until pairing session expires (short-lived)",
      shared_with: "none",
    },
    {
      kind: "push_token",
      collected_when: "user opts into mobile push notifications",
      stored_in: "relay_push_tokens.push_token",
      retention: "until token expires or device is unregistered",
      shared_with: "Apple Push Notification Service (iOS) or Firebase Cloud Messaging (Android)",
    },
  ],
  declared_not_collected: [
    "real names",
    "phone numbers",
    "physical addresses",
    "long-term IP address logs",
    "AI prompts at the relay layer (proxy at services/proxy passes them to providers without storage)",
    "memory content of any sensitivity level above 'personal' (ingress-redacted before storage)",
    "browser fingerprints, advertising identifiers, or cross-site identifiers",
  ],
  third_party_processors: [
    {
      name: "npm registry",
      role: "release witness source (services/relay/src/release-witness.ts). The relay fetches PUBLIC package metadata and tarballs for the `motebit` package to sign the release witness served at /.well-known/motebit-releases.json. Read-only observation: no user, agent, or operator data is transmitted — the request itself (relay IP, user-agent) is the only signal npm receives.",
      data_shared: [
        "none (public registry reads only; requester IP visible to npm as with any HTTP fetch)",
      ],
      jurisdiction: "United States (npm, Inc. / GitHub / Microsoft)",
      data_processing_terms: "https://docs.npmjs.com/policies/privacy",
    },
    {
      name: "Stripe",
      role: "fiat payment processor",
      data_shared: ["email", "payment method (held by Stripe)", "subscription metadata"],
      jurisdiction: "United States",
      data_processing_terms: "https://stripe.com/legal/dpa",
    },
    {
      name: "x402 facilitator",
      role: "HTTP-native crypto payment protocol",
      data_shared: ["payment payloads (amount, recipient address, tx hash)"],
      jurisdiction: "varies by facilitator deployment",
      data_processing_terms: "https://x402.org",
    },
    {
      name: "Bridge",
      role: "Crypto-to-fiat off-ramp orchestration (services/relay/src/offramp.ts). Forwards a Solana USDC transfer from a motebit's sovereign wallet through Bridge's deposit address, with Bridge converting to fiat and ACH-ing to the user's bank. Used only when the operator configures a Bridge API key + customer ID at startup; otherwise the rail is omitted from `/health/ready`.",
      data_shared: [
        "Bridge customer_id (operator-scoped)",
        "external_account_id (per user, supplied at withdrawal time)",
        "transfer instructions (amount, source rail, source currency, deposit address)",
        "settlement transaction hash",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://bridge.xyz/legal",
    },
    {
      name: "Coinbase Developer Platform (x402 production facilitator)",
      role: "Mainnet x402 facilitator — JWT-authed per-request settlement of relay-mediated x402 payments on Base mainnet (and other supported chains). Used only when X402_TESTNET=false and CDP_API_KEY_ID + CDP_API_KEY_SECRET are configured.",
      data_shared: [
        "payment authorization payloads",
        "settlement requests (amount, recipient address, network)",
        "request-signing JWT bound to method+host+path",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://www.coinbase.com/legal/cloud/terms",
    },
    {
      name: "EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)",
      role: "Treasury reconciliation onchain reads — eth_call balanceOf(treasuryAddress) on the chain's USDC contract every 15 min when X402_TESTNET=false. No write path; observability only. The address is publicly observable onchain; the RPC reads no operator-private data.",
      data_shared: ["public treasury address", "USDC contract address", "block number"],
      jurisdiction: "varies by RPC operator (default https://mainnet.base.org)",
      data_processing_terms: "configured via deposit-detector's DEFAULT_RPC_URLS map",
    },
    {
      name: "Solana RPC provider",
      role: "blockchain anchoring + sovereign settlement verification",
      data_shared: ["public credential hashes", "revocation memos", "transaction lookups"],
      jurisdiction: "varies by RPC operator",
      data_processing_terms: "configured via SOLANA_RPC_URL env var",
    },
    {
      name: "Expo Push Service",
      role: "mobile push transport (forwards wake-signal payloads to APNS/FCM)",
      data_shared: [
        "push token",
        "wake-signal payload (motebit_id, pending task count, timestamp — see invariant below)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://expo.dev/terms",
    },
    {
      name: "Apple Push Notification Service",
      role: "mobile push delivery (iOS only, opt-in)",
      data_shared: [
        "push token",
        "wake-signal payload (motebit_id, pending task count, timestamp — no message body, no memory content, no prompt or response text; relay-side invariant enforced by the `PushPayload` type in `services/relay/src/push-adapter.ts`)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://www.apple.com/legal/internet-services/push/",
    },
    {
      name: "Firebase Cloud Messaging",
      role: "mobile push delivery (Android only, opt-in)",
      data_shared: [
        "push token",
        "wake-signal payload (motebit_id, pending task count, timestamp — no message body, no memory content, no prompt or response text; relay-side invariant enforced by the `PushPayload` type in `services/relay/src/push-adapter.ts`)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://firebase.google.com/terms/data-processing-terms",
    },
    {
      name: "Anthropic",
      role: "AI inference provider (via services/proxy when motebit-cloud routing selects an Anthropic model)",
      data_shared: [
        "model prompts and responses (per request, not retained at proxy beyond cache TTL)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://www.anthropic.com/legal/dpa",
    },
    {
      name: "OpenAI",
      role: "AI inference provider (via services/proxy when motebit-cloud routing selects an OpenAI model)",
      data_shared: [
        "model prompts and responses (per request, not retained at proxy beyond cache TTL)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://openai.com/policies/data-processing-addendum",
    },
    {
      name: "Google (Generative Language API)",
      role: "AI inference provider (via services/proxy when motebit-cloud routing selects a Gemini model)",
      data_shared: [
        "model prompts and responses (per request, not retained at proxy beyond cache TTL)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://cloud.google.com/terms/data-processing-addendum",
    },
    {
      name: "Groq",
      role: "AI inference provider (via services/proxy when motebit-cloud routing selects an open-source model on Groq LPU hardware: Llama 3.3 70B, GPT-OSS 120B)",
      data_shared: [
        "model prompts and responses (per request, not retained at proxy beyond cache TTL)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://groq.com/terms-of-use",
    },
    {
      name: "Fly.io",
      role: "container hosting for relay and reference services",
      data_shared: ["host-level metadata (no app data beyond what Fly captures from log streams)"],
      jurisdiction: "United States",
      data_processing_terms: "https://fly.io/legal/dpa",
    },
    {
      name: "Vercel",
      role: "edge hosting for the web app and proxy service",
      data_shared: ["edge HTTP request metadata"],
      jurisdiction: "United States",
      data_processing_terms: "https://vercel.com/legal/dpa",
    },
  ],
  analytics: {
    relay_side: "none",
    web_side:
      "none committed yet — Plausible (self-hosted) is the planned choice per docs/doctrine/operator-transparency.md anti-patterns",
  },
  honest_gaps: [
    "Fly.io and Vercel log retention windows are governed by their respective DPAs and are not separately enforced by motebit code.",
    "Before migration v34, memory_formed events above the personal sensitivity ceiling were stored unredacted at the relay (redaction ran only on read paths). v34 scrubbed those rows in place; database backups created during that window may retain unredacted copies until backup retention expires.",
    "Before migration v35, a memory deleted by its subject (a synced DeleteRequested) did not erase the stored memory_formed content for deletions that predated deletion propagation — including none/personal-sensitivity nodes the v34 scrub skips. v35 backfills those historical deletions; database backups from before it may retain the content until backup retention expires.",
    "receipts verified before the relay_receipts archive landed (migration v10) retained only `receipt_hash` in `relay_settlements`; their full canonical JSON was not preserved and cannot be reconstructed. Receipts verified on and after v10 are archived byte-identically.",
  ],
} as const;

// ---------------------------------------------------------------------------
// Build, sign, render
// ---------------------------------------------------------------------------

/**
 * Reference-relay narrowing of `SignedTransparencyDeclaration` from
 * `@motebit/protocol`. The protocol surface treats `content` as
 * `unknown` (operator-extensible per `spec/relay-transparency-v1.md`
 * §3.1); the reference relay narrows `content` to its specific
 * `DECLARATION_CONTENT` shape so call sites that consume the relay's
 * declaration get the full content type without casting.
 */
export type SignedDeclaration = Omit<SignedTransparencyDeclaration, "content"> & {
  readonly content: typeof DECLARATION_CONTENT;
};

/**
 * Build the canonical signed declaration. Hash and signature cover the
 * `{spec, declared_at, relay_id, relay_public_key, content}` payload —
 * `hash`, `suite`, and `signature` are appended after.
 */
export async function buildSignedDeclaration(
  relayIdentity: RelayIdentity,
  declaredAt: number = Date.now(),
): Promise<SignedDeclaration> {
  const payload = {
    spec: SPEC_DRAFT_ID,
    declared_at: declaredAt,
    relay_id: relayIdentity.relayMotebitId,
    relay_public_key: bytesToHex(relayIdentity.publicKey),
    content: DECLARATION_CONTENT,
  };

  const canonical = canonicalJson(payload);
  const canonicalBytes = new TextEncoder().encode(canonical);
  const hashBytes = await sha256(canonicalBytes);
  const hashHex = bytesToHex(hashBytes);
  const sigBytes = await sign(canonicalBytes, relayIdentity.privateKey);
  const signatureHex = bytesToHex(sigBytes);

  return {
    ...payload,
    hash: hashHex,
    suite: SIGNATURE_SUITE,
    signature: signatureHex,
  };
}

/**
 * Process-wide singleton signed declaration, keyed by relay identity.
 *
 * `declared_at` is inside the hashed+signed payload (see
 * `buildSignedDeclaration`), so two independent `buildSignedDeclaration`
 * calls produce two different `Date.now()` timestamps → two different
 * hashes. The serve path (`registerTransparencyRoutes`) and the onchain
 * anchor path (`index.ts` boot) MUST therefore consume the SAME built
 * instance — otherwise the anchor certifies a hash the endpoint never
 * serves, and the TOFU cross-check the anchor exists to provide (fetch
 * declaration → hash → find matching Solana memo) can never succeed.
 * This accessor is the single shared source: build once, serve AND anchor
 * the same bytes. Keyed by identity object so tests with distinct
 * identities stay isolated.
 */
const declarationCache = new WeakMap<RelayIdentity, Promise<SignedDeclaration>>();

export function getSignedDeclaration(relayIdentity: RelayIdentity): Promise<SignedDeclaration> {
  let declaration = declarationCache.get(relayIdentity);
  if (declaration === undefined) {
    declaration = buildSignedDeclaration(relayIdentity);
    declarationCache.set(relayIdentity, declaration);
  }
  return declaration;
}

/**
 * Anchor a signed transparency declaration to Solana via the Memo
 * program. Closes the trust-on-first-use (TOFU) gap on the first fetch
 * of `/.well-known/motebit-transparency.json` — a verifier who knows
 * the relay's Solana address (pinned out-of-band) can confirm the
 * declaration's hash matches a memo at that address, without trusting
 * the network channel that delivered the declaration.
 *
 * Fire-and-forget at the relay; chain submission failure logs but does
 * not block startup or unregister the unanchored declaration. The
 * anchor's value compounds when one exists — without an anchor, the
 * verifier falls back to TOFU.
 *
 * Doctrine: `docs/doctrine/operator-transparency.md` § "Stage 2 onchain
 * anchor" (lifted forward 2026-05-11, decoupled from the multi-operator
 * wire-format spec); `docs/doctrine/nist-alignment.md` §8 "savant gap".
 */
export async function anchorTransparencyDeclaration(
  declaration: SignedDeclaration,
  submitter: TransparencyAnchorSubmitter,
  db?: DatabaseDriver,
): Promise<{ txHash: string }> {
  // Paced with every other anchoring stream on this submitter (shared backoff;
  // a deferral throws without an RPC call, so the supervised loop retries).
  // With a database, sign → record → send → confirm that signature
  // (anchor-broadcasts.ts): the loop retries every tick until it lands, and a
  // memo already sent for this hash is reconciled, never re-sent blindly —
  // across restarts too.
  return anchorSubmitPacerFor(submitter).submit("transparency", declaration.hash, () =>
    db
      ? submitRecordedAnchor(db, submitter, "transparency", declaration.hash, (hooks) =>
          submitter.submitTransparencyAnchor(declaration.hash, hooks),
        )
      : submitter.submitTransparencyAnchor(declaration.hash),
  );
}

/** The transparency anchor's submitter (`SolanaMemoSubmitter`). */
export interface TransparencyAnchorSubmitter {
  submitTransparencyAnchor: (
    hashHex: string,
    hooks?: AnchorBroadcastHooks,
  ) => Promise<{ txHash: string }>;
}

/** Default retry cadence for the transparency anchor loop (1 minute). */
export const TRANSPARENCY_ANCHOR_RETRY_MS = 60_000;

/** Mutable landed-flag threaded through the anchor loop's ticks. */
export interface TransparencyAnchorState {
  anchored: boolean;
}

/**
 * One anchor attempt, idempotent-guarded. Returns the anchored hash + txHash
 * on the attempt that lands, `null` once already anchored (a cheap no-op —
 * re-anchoring an unchanged, idempotent hash only wastes SOL). Throws on
 * submitter failure WITHOUT setting `anchored`, so the supervised loop records
 * the error and retries on the next tick rather than giving up permanently.
 *
 * Consumes the SAME shared singleton the serve path caches
 * (`getSignedDeclaration`), so what lands on chain is exactly what the endpoint
 * serves — the invariant `getSignedDeclaration` exists to hold.
 */
export async function attemptTransparencyAnchor(
  state: TransparencyAnchorState,
  relayIdentity: RelayIdentity,
  submitter: TransparencyAnchorSubmitter,
  db?: DatabaseDriver,
): Promise<{ txHash: string; hash: string } | null> {
  if (state.anchored) return null;
  const declaration = await getSignedDeclaration(relayIdentity);
  // Exactly once (anchor-submit-pacing.ts `submitOnce`): a tick that starts
  // while the previous attempt is still queued joins it, and the flag is
  // re-read once this attempt reaches the front.
  return anchorSubmitPacerFor(submitter).submitOnce("transparency", declaration.hash, async () => {
    if (state.anchored) return null;
    const result = await anchorTransparencyDeclaration(declaration, submitter, db);
    state.anchored = true;
    return { txHash: result.txHash, hash: declaration.hash };
  });
}

/**
 * Start the supervised transparency-anchor loop.
 *
 * Replaces the prior fire-and-forget boot IIFE, which had TWO invisible
 * failure modes: a transient RPC failure at boot left the live declaration
 * PERMANENTLY unanchored (no retry), and the failure never reached the
 * `GET /api/v1/admin/health` `loops` surface (off-supervisor). Both are the
 * rule-18 class — money/trust-adjacent boot work must be supervised, not
 * `void asyncWork()`.
 *
 * The loop attempts the anchor each tick until it lands, then idempotent-guards
 * to a cheap no-op `ok` tick (it stays registered so the supervisor keeps
 * reporting `ok`; clearing it on success would let the freshness window flip it
 * to a false `stale` and poison `anyUnhealthy()`). A persistent failure shows
 * as `transparency-anchor` `erroring`. First attempt fires after `intervalMs`
 * (superviseInterval's cadence) — a negligible delay for an additive,
 * TOFU-backed trust anchor.
 *
 * Doctrine: `services/relay/CLAUDE.md` rule 18;
 * `docs/doctrine/operator-transparency.md` § Stage 2 onchain anchor.
 */
export function startTransparencyAnchorLoop(
  relayIdentity: RelayIdentity,
  submitter: TransparencyAnchorSubmitter & { address: string },
  isFrozen: () => boolean,
  supervisor?: LoopSupervisor,
  intervalMs: number = TRANSPARENCY_ANCHOR_RETRY_MS,
  db?: DatabaseDriver,
): ReturnType<typeof setInterval> {
  const state: TransparencyAnchorState = { anchored: false };
  return superviseInterval(
    supervisor,
    "transparency-anchor",
    intervalMs,
    async () => {
      const landed = await attemptTransparencyAnchor(state, relayIdentity, submitter, db);
      if (landed) {
        logger.info("transparency.anchored", {
          hash: landed.hash,
          tx_hash: landed.txHash,
          anchor_address: submitter.address,
        });
      }
    },
    { isFrozen },
  );
}

/**
 * Render the declaration as human-readable Markdown. The output is the
 * canonical text of `services/relay/PRIVACY.md`. Sibling-boundary test
 * asserts the committed PRIVACY.md matches this render exactly.
 */
export function renderMarkdown(): string {
  const c = DECLARATION_CONTENT;
  const lines: string[] = [];

  lines.push("# Privacy and operator transparency");
  lines.push("");
  lines.push(
    "This document is the human-readable form of relay.motebit.com's transparency declaration. The signed, machine-verifiable JSON form is served at `/.well-known/motebit-transparency.json`. Both are derived from `services/relay/src/transparency.ts` — the file is the single source of truth.",
  );
  lines.push("");
  lines.push(
    "Doctrine: [`docs/doctrine/operator-transparency.md`](../../docs/doctrine/operator-transparency.md).",
  );
  lines.push("");

  lines.push("## Operator");
  lines.push("");
  lines.push(`- **Name** — ${c.operator.name}`);
  lines.push(`- **Entity** — ${c.operator.entity_type}`);
  lines.push(`- **Jurisdiction** — ${c.operator.jurisdiction}`);
  lines.push(`- **Contact** — ${c.operator.contact}`);
  lines.push("");

  lines.push("## Retention by layer");
  lines.push("");
  lines.push("### Presence");
  lines.push("");
  lines.push(`Tables: ${c.retention.presence.tables.map((t) => `\`${t}\``).join(", ")}.`);
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.presence.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.presence.retention_window}.`);
  lines.push("");

  lines.push("### Device registry");
  lines.push("");
  lines.push(`Tables: ${c.retention.device_registry.tables.map((t) => `\`${t}\``).join(", ")}.`);
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.device_registry.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.device_registry.retention_window}.`);
  lines.push("");

  lines.push("### Accepted proofs of possession");
  lines.push("");
  lines.push(
    `Tables: ${c.retention.key_proofs_accepted.tables.map((t) => `\`${t}\``).join(", ")}.`,
  );
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.key_proofs_accepted.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.key_proofs_accepted.retention_window}.`);
  lines.push("");

  lines.push("### Operational");
  lines.push("");
  lines.push(`Tables: ${c.retention.operational.tables.map((t) => `\`${t}\``).join(", ")}.`);
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.operational.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.operational.retention_window}.`);
  lines.push("");

  lines.push("### Content");
  lines.push("");
  lines.push(`Tables: ${c.retention.content.tables.map((t) => `\`${t}\``).join(", ")}.`);
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.content.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.content.retention_window}.`);
  lines.push(`Enforcement: ${c.retention.content.enforcement}.`);
  lines.push("");
  lines.push("### Auth events");
  lines.push("");
  lines.push(`Tables: ${c.retention.auth_events.tables.map((t) => `\`${t}\``).join(", ")}.`);
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.auth_events.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.auth_events.retention_window}.`);
  lines.push("");

  lines.push("### Task routes");
  lines.push("");
  lines.push(`Tables: ${c.retention.task_routes.tables.map((t) => `\`${t}\``).join(", ")}.`);
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.task_routes.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.task_routes.retention_window}.`);
  lines.push("");

  lines.push("### Machine roster");
  lines.push("");
  lines.push(`Tables: ${c.retention.machine_roster.tables.map((t) => `\`${t}\``).join(", ")}.`);
  lines.push("");
  lines.push("Observable:");
  for (const item of c.retention.machine_roster.observable) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Retention window: ${c.retention.machine_roster.retention_window}.`);
  lines.push(`Access: ${c.retention.machine_roster.access}.`);
  lines.push("");

  lines.push("### IP addresses");
  lines.push("");
  lines.push(`Handling: **${c.retention.ip_addresses.handling}**.`);
  lines.push("");
  lines.push(c.retention.ip_addresses.detail + ".");
  lines.push("");

  lines.push("## PII collected");
  lines.push("");
  for (const pii of c.declared_collected_pii) {
    lines.push(`### ${pii.kind}`);
    lines.push("");
    lines.push(`- **Collected when**: ${pii.collected_when}`);
    lines.push(`- **Stored in**: \`${pii.stored_in}\``);
    lines.push(`- **Retention**: ${pii.retention}`);
    lines.push(`- **Shared with**: ${pii.shared_with}`);
    lines.push("");
  }

  lines.push("## Not collected");
  lines.push("");
  for (const item of c.declared_not_collected) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Third-party processors");
  lines.push("");
  for (const p of c.third_party_processors) {
    lines.push(`### ${p.name}`);
    lines.push("");
    lines.push(`- **Role**: ${p.role}`);
    lines.push(`- **Data shared**: ${p.data_shared.join(", ")}`);
    lines.push(`- **Jurisdiction**: ${p.jurisdiction}`);
    lines.push(`- **DPA / terms**: ${p.data_processing_terms}`);
    lines.push("");
  }

  lines.push("## Analytics");
  lines.push("");
  lines.push(`- **Relay-side**: ${c.analytics.relay_side}`);
  lines.push(`- **Web-side**: ${c.analytics.web_side}`);
  lines.push("");

  lines.push("## Honest gaps");
  lines.push("");
  for (const gap of c.honest_gaps) lines.push(`- ${gap}`);
  lines.push("");

  lines.push("## Verification");
  lines.push("");
  lines.push(
    "The JSON form at `/.well-known/motebit-transparency.json` is signed by the relay's Ed25519 identity key under suite `motebit-jcs-ed25519-hex-v1`. Verifiers compute `sha256(canonicalJson({spec, declared_at, relay_id, relay_public_key, content}))` and check the signature against `relay_public_key`. No relay contact is required to verify a cached copy.",
  );
  lines.push("");
  lines.push(
    "The declaration hash is committed onchain via the Solana Memo program at boot when the relay is configured with `SOLANA_RPC_URL` and its Ed25519-derived Solana wallet is funded (per `spec/relay-transparency-v1.md` §5 — Stage 2 trust-anchor primitive). A third party can find the anchor transaction by searching Solana memos signed by `relay_public_key` and matching the declaration's `hash` field, proving Motebit's claim even if the published copy disappears. Without a configured anchor, the declaration remains valid via trust-on-first-use over HTTPS — the anchor is additive evidence.",
  );
  lines.push("");

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

export interface TransparencyRouteDeps {
  app: Hono;
  relayIdentity: RelayIdentity;
}

/**
 * Register the public transparency endpoint at
 * `/.well-known/motebit-transparency.json`. The declaration is built once
 * at startup and re-signed only if the source content changes (it does not
 * change between deploys). For now the timestamp is set at startup; future
 * versions may anchor onchain and rotate per anchor cycle.
 */
export async function registerTransparencyRoutes(deps: TransparencyRouteDeps): Promise<void> {
  const { app, relayIdentity } = deps;

  // Build once at startup, via the shared singleton so the onchain anchor
  // path (index.ts) serves and anchors the SAME bytes (same declared_at,
  // same hash). See getSignedDeclaration.
  const declaration = await getSignedDeclaration(relayIdentity);

  // Public endpoint — unauthenticated, served as canonical JSON for
  // verifier compatibility (no Express middleware-style key reordering).
  /** @internal */
  app.get("/.well-known/motebit-transparency.json", (_c) => {
    return new Response(canonicalJson(declaration), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  });

  // Admin endpoint — same declaration plus a future-anchor placeholder so
  // operators can see whether the disappearance test is fully satisfied
  // by this build. Master-token gated via bearerAuth in middleware.ts;
  // the public-facing transparency artifact is the signed JSON at
  // /.well-known/motebit-transparency.json (above), which non-operator
  // consumers read without authentication.
  /** @internal */
  app.get("/api/v1/admin/transparency", (c) => {
    return c.json({
      declaration,
      onchain_anchor: {
        status: "not-yet-implemented",
        rationale:
          "Onchain anchoring lands with spec/relay-transparency-v1.md (Stage 2). Until then, the disappearance test is partially passed: cached JSON survives operator deletion via third-party caches, but no chain record exists.",
      },
      doctrine: "docs/doctrine/operator-transparency.md",
    });
  });
}

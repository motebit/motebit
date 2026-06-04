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
      tables: ["agent_registry", "relay_identity", "pairing_sessions"],
      observable: [
        "motebit_id (UUID v7)",
        "Ed25519 public key",
        "endpoint_url",
        "capabilities list",
        "registration timestamp",
        "last heartbeat timestamp",
        "expires_at TTL",
        "optional device label (claiming_device_name) when set by user during pairing",
      ],
      retention_window: "indefinite while motebit is active; expires per TTL after last heartbeat",
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
        "relay_disputes",
        "relay_dispute_evidence",
        "relay_dispute_resolutions",
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
      ],
      observable: [
        "every delegation request and its routing decision",
        "every signed execution receipt the relay verified",
        "full signed execution receipt JSON, byte-identical to the signer's canonical form, archived per (motebit_id, task_id) for independent audit re-verification",
        "every settlement (relay-mediated and p2p audit)",
        "every pending aggregated withdrawal intent enqueued by the sweep, with state machine history until fired or failed",
        "every credential issued, anchored, or revoked",
        "every operator agent de-listing and reinstatement — the signed, append-only `AgentRevocationRecord` history (motebit_id, reason, actor, note, effective_at) served publicly at GET /api/v1/agents/revocations and verifiable against the relay's pinned key; a de-list removes an agent from Discover only — its identity, key, succession chain, and receipts stay served",
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
      tables: [],
      observable: [],
      retention_window:
        "none — content is gated at the agent boundary by @motebit/privacy-layer; medical/financial/secret memory categories never cross the surface to the relay",
      enforcement: "see packages/privacy-layer for the sensitivity gating implementation",
    },
    ip_addresses: {
      handling: "transient",
      detail:
        "client IP is read for rate limiting (in-memory FixedWindowLimiter, no DB) and included in auth-event log lines (Fly.io retention applies, no app-level persistence)",
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
    "memory content of any sensitivity level above 'none'",
    "browser fingerprints, advertising identifiers, or cross-site identifiers",
  ],
  third_party_processors: [
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
  submitter: { submitTransparencyAnchor: (hashHex: string) => Promise<{ txHash: string }> },
): Promise<{ txHash: string }> {
  return submitter.submitTransparencyAnchor(declaration.hash);
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
  lines.push(c.retention.content.retention_window);
  lines.push("");
  lines.push(`Enforcement: ${c.retention.content.enforcement}.`);
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

  // Build once at startup. The declaration content is static between deploys.
  const declaration = await buildSignedDeclaration(relayIdentity);

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

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
 * Stage 1.5 deliberately omits onchain anchoring; that lands when
 * `spec/relay-transparency-v1.md` ships and makes the anchor mandatory.
 * Until then the declaration is signed by the relay's identity key and
 * served at /.well-known/motebit-transparency.json — partial disappearance
 * test: any holder of the cached JSON can verify it was Motebit's claim,
 * but the operator could silently delete the published copy. The future
 * onchain anchor closes that gap.
 */

import type { Hono } from "hono";
import { canonicalJson, sign, bytesToHex, sha256 } from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";

// ---------------------------------------------------------------------------
// Source of truth — every field here must match observable retention behavior
// ---------------------------------------------------------------------------

/**
 * Pre-spec version identifier. Once `spec/relay-transparency-v1.md` lands,
 * this becomes `motebit/relay-transparency@1.0`. Until then, the draft
 * marker signals to readers that the wire format is operator convention,
 * not protocol law.
 */
const SPEC_DRAFT_ID = "motebit-transparency/draft-2026-04-14" as const;

/** Cryptosuite for the declaration signature — same as identity files. */
const SIGNATURE_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

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
        "relay_credentials",
        "relay_credential_anchor_batches",
        "relay_revocation_events",
        "relay_revoked_credentials",
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
      ],
      observable: [
        "every delegation request and its routing decision",
        "every signed execution receipt the relay verified",
        "every settlement (relay-mediated and p2p audit)",
        "every credential issued, anchored, or revoked",
        "every dispute, evidence submission, and resolution",
        "every federation peer relationship",
        "every onchain settlement proof attached",
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
      name: "Solana RPC provider",
      role: "blockchain anchoring + sovereign settlement verification",
      data_shared: ["public credential hashes", "revocation memos", "transaction lookups"],
      jurisdiction: "varies by RPC operator",
      data_processing_terms: "configured via SOLANA_RPC_URL env var",
    },
    {
      name: "Apple Push Notification Service",
      role: "mobile push delivery (iOS only, opt-in)",
      data_shared: ["push token", "notification payload"],
      jurisdiction: "United States",
      data_processing_terms: "https://www.apple.com/legal/internet-services/push/",
    },
    {
      name: "Firebase Cloud Messaging",
      role: "mobile push delivery (Android only, opt-in)",
      data_shared: ["push token", "notification payload"],
      jurisdiction: "United States",
      data_processing_terms: "https://firebase.google.com/terms/data-processing-terms",
    },
    {
      name: "Anthropic",
      role: "AI inference provider (via services/proxy)",
      data_shared: [
        "model prompts and responses (per request, not retained at proxy beyond cache TTL)",
      ],
      jurisdiction: "United States",
      data_processing_terms: "https://www.anthropic.com/legal/dpa",
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
    "onchain anchor of this declaration is not yet in place; only cached copies of the JSON survive operator deletion. See `spec/relay-transparency-v1.md` (when shipped) for the mandatory-anchor wire format.",
    "Fly.io and Vercel log retention windows are governed by their respective DPAs and are not separately enforced by motebit code.",
  ],
} as const;

// ---------------------------------------------------------------------------
// Build, sign, render
// ---------------------------------------------------------------------------

export interface SignedDeclaration {
  spec: typeof SPEC_DRAFT_ID;
  declared_at: number;
  relay_id: string;
  relay_public_key: string;
  content: typeof DECLARATION_CONTENT;
  hash: string;
  suite: typeof SIGNATURE_SUITE;
  signature: string;
}

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
 * Render the declaration as human-readable Markdown. The output is the
 * canonical text of `services/api/PRIVACY.md`. Sibling-boundary test
 * asserts the committed PRIVACY.md matches this render exactly.
 */
export function renderMarkdown(): string {
  const c = DECLARATION_CONTENT;
  const lines: string[] = [];

  lines.push("# Privacy and operator transparency");
  lines.push("");
  lines.push(
    "This document is the human-readable form of relay.motebit.com's transparency declaration. The signed, machine-verifiable JSON form is served at `/.well-known/motebit-transparency.json`. Both are derived from `services/api/src/transparency.ts` — the file is the single source of truth.",
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
    "Onchain anchoring of the declaration hash will land with `spec/relay-transparency-v1.md`. Until then the disappearance test is partially passed: a cached JSON proves what Motebit claimed at a point in time, but a coordinated deletion of the published copy and absence of a third-party cache would erase the public claim. This gap is documented in `honest_gaps` above.",
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
  // by this build. Audience-bound at the auth layer (admin:query).
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

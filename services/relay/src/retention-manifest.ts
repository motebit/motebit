/**
 * Operator retention manifest for relay.motebit.com.
 *
 * Phase 6a of the retention-policy doctrine
 * (`docs/doctrine/retention-policy.md` §"Self-attesting transparency").
 * Sibling to the operator-transparency manifest at
 * `/.well-known/motebit-transparency.json` — same suite, same signing
 * flow, same disappearance-test posture. Built once at startup, signed
 * by the relay's identity key, served unauthenticated.
 *
 * The manifest enumerates every store the operator runs under a
 * registered `RetentionShape`. Today's manifest declares what's
 * actually enforced (currently empty — phase 4b-3 + phase 5 register
 * the operational ledgers and the conversation/tool-audit stores) and
 * names the gaps in `honest_gaps` so users see what's coming. Same
 * staged-honesty pattern as the operator-transparency stage 1.5 ship:
 * the endpoint exists, the convention is set, future phases fill it.
 *
 * Honesty rule: a store appears in `stores` only when the operator
 * actually enforces the declared shape. Declaring `append_only_horizon`
 * with `horizon_advance_period_days: 30` while never advancing the
 * horizon is a violation. Phase 4b-3 will populate operational ledgers
 * here; phase 5 will populate conversation + tool-audit stores.
 */

import type { Hono } from "hono";
import { canonicalJson, sign, bytesToHex } from "@motebit/encryption";
import type { RetentionManifest, SensitivityLevelString } from "@motebit/protocol";
import type { RelayIdentity } from "./federation.js";

/** Cryptosuite — sibling to motebit-transparency.json (hex variant). */
const SIGNATURE_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/** Default for un-classified pre-deploy records — decision 6b in the doctrine. */
const PRE_CLASSIFICATION_DEFAULT_SENSITIVITY: SensitivityLevelString = "personal";

/**
 * Source of truth for the retention manifest's content. Edit here; the
 * signed JSON regenerates at next startup. Add a store only when the
 * operator actually enforces the declared shape — false claims fail the
 * doctrine even when they're cosmetic.
 *
 * `honest_gaps` entries carry one of three discriminator prefixes per
 * the phase 6a follow-up split:
 *   - `pending:` — stores this operator WILL run once enforcement
 *     lands (operational ledgers, phase 4b-3).
 *   - `out_of_deployment:` — stores this operator's deployment doesn't
 *     host regardless of phase. relay.motebit.com handles federation /
 *     settlement / agent-registry; conversation_messages + tool_audit
 *     are runtime-side (user device), NOT relay-hosted, so they will
 *     never enter THIS manifest. Each motebit's runtime publishes its
 *     own retention manifest covering its conversation + tool-audit
 *     stores per phase 5-ship.
 *   - `different_mechanism:` — stores governed by a sibling doctrine
 *     (presence TTLs under operator-transparency).
 *
 * The original phase-6a manifest conflated these — pending and
 * out-of-deployment were both written as "phase X will fill this in,"
 * which falsely implied the relay would eventually own conversation
 * retention. Splitting the discriminator makes the deployment boundary
 * legible to verifiers.
 */
export const RETENTION_MANIFEST_CONTENT: Pick<
  RetentionManifest,
  "stores" | "pre_classification_default_sensitivity" | "honest_gaps"
> = {
  stores: [
    // Empty by phase 6a. Phase 4b-3 will append `append_only_horizon`
    // entries for the operational ledgers (relay_execution_ledgers,
    // relay_settlements, relay_credential_anchor_batches,
    // relay_revocation_events, relay_disputes) once the federation
    // co-witness handshake exists and the relay starts advancing
    // horizons. The empty list is the truthful state; it grows
    // additively. The conversation + tool-audit stores never appear
    // here — they live runtime-side and surface in per-motebit
    // retention manifests, not in this operator-level one.
  ],
  pre_classification_default_sensitivity: PRE_CLASSIFICATION_DEFAULT_SENSITIVITY,
  honest_gaps: [
    "pending: operational ledgers (relay_execution_ledgers, relay_settlements, " +
      "relay_credential_anchor_batches, relay_revocation_events, relay_disputes) " +
      "will register under `append_only_horizon` when phase 4b-3 lands the " +
      "federation co-witness handshake and the relay starts advancing horizons. " +
      "Today these stores are append-only with no truncation primitive wired in.",
    "out_of_deployment: conversation_messages + tool_audit are runtime-side " +
      "(per-motebit, on the user's device) and NOT hosted by relay.motebit.com. " +
      "Phase 5-ship registers them under `consolidation_flush` in the runtime's " +
      "consolidation cycle — covered by each motebit's own retention manifest, " +
      "not this operator-level one. They will never appear in this `stores` list.",
    "different_mechanism: presence data (agent_registry, relay_identity, " +
      "pairing_sessions) is TTL-based (declared in " +
      "/.well-known/motebit-transparency.json) and is not retention-cert-shaped — " +
      "TTL expiry is a different mechanism than the signed deletion certificates " +
      "this manifest enumerates. Presence retention is governed by the " +
      "operator-transparency manifest, not this one.",
    "pending: onchain anchor of this manifest is not yet in place; only cached " +
      "copies of the JSON survive operator deletion. Sibling concern to the " +
      "operator-transparency manifest's onchain anchor (also pending).",
  ],
} as const;

/**
 * Build the canonical signed manifest. Signature covers
 * `canonicalJson(manifest minus signature)` per phase 1's decision 5
 * single-signature pattern (this manifest is operator-signed only;
 * deletion certs use the multi-signature pattern).
 */
export async function buildSignedManifest(
  relayIdentity: RelayIdentity,
  issuedAt: number = Date.now(),
): Promise<RetentionManifest> {
  const body = {
    spec: "motebit/retention-manifest@1" as const,
    operator_id: relayIdentity.relayMotebitId,
    issued_at: issuedAt,
    stores: RETENTION_MANIFEST_CONTENT.stores,
    pre_classification_default_sensitivity:
      RETENTION_MANIFEST_CONTENT.pre_classification_default_sensitivity,
    honest_gaps: RETENTION_MANIFEST_CONTENT.honest_gaps,
    suite: SIGNATURE_SUITE,
  };

  const canonical = canonicalJson(body);
  const canonicalBytes = new TextEncoder().encode(canonical);
  const sigBytes = await sign(canonicalBytes, relayIdentity.privateKey);
  const signatureHex = bytesToHex(sigBytes);

  return {
    ...body,
    signature: signatureHex,
  };
}

export interface RetentionManifestRouteDeps {
  app: Hono;
  relayIdentity: RelayIdentity;
}

/**
 * Register the public retention manifest endpoint at
 * `/.well-known/motebit-retention.json`. Built once at startup; static
 * between deploys (any change to `RETENTION_MANIFEST_CONTENT` requires
 * a deploy and the manifest re-signs at startup).
 */
export async function registerRetentionManifestRoutes(
  deps: RetentionManifestRouteDeps,
): Promise<void> {
  const { app, relayIdentity } = deps;
  const manifest = await buildSignedManifest(relayIdentity);

  /** @internal */
  app.get("/.well-known/motebit-retention.json", (_c) => {
    return new Response(canonicalJson(manifest), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  });
}

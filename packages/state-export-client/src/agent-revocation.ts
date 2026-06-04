/**
 * Portable verifier for agent-revocation records + the public revocations feed.
 *
 * The operator's de-list power is made sovereign-verifiable
 * (`docs/doctrine/agents-as-first-person-trust-graph.md` §8): every revoke /
 * reinstate is a signed `AgentRevocationRecord`, and the relay serves the full
 * append-only history at `GET /api/v1/agents/revocations` as a signed
 * `AgentRevocationFeed`. This module lets a third party verify both offline
 * against the relay's pinned key — the SAME key the transparency declaration
 * commits (`verifyTransparencyDeclaration`), so a verifier that has already
 * bootstrapped a `TransparencyAnchor` can audit the operator's moderation
 * history with no further trust.
 *
 * Fail-closed, typed reasons, no thrown exceptions for verification failures —
 * same contract as `verifyTransparencyDeclaration`. No new crypto: hash +
 * suite-dispatch verify come from `@motebit/crypto` (rule 1).
 *
 * Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §8,
 * `docs/doctrine/self-attesting-system.md`, `spec/agent-revocation-v1.md`.
 */

import { canonicalJson, hexToBytes, sha256, bytesToHex, verifyBySuite } from "@motebit/crypto";
import type { AgentRevocationRecord, AgentRevocationFeed } from "@motebit/protocol";

export type { AgentRevocationRecord, AgentRevocationFeed } from "@motebit/protocol";

export type AgentRevocationFailureReason =
  | "malformed_record"
  | "hash_mismatch"
  | "malformed_public_key"
  | "malformed_signature"
  | "signature_invalid"
  | "unsupported_suite"
  | "producer_key_mismatch";

export type AgentRevocationVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AgentRevocationFailureReason; readonly detail?: string };

export type AgentRevocationFeedVerifyResult =
  | { readonly ok: true; readonly count: number }
  | {
      readonly ok: false;
      readonly reason: AgentRevocationFailureReason | "record_invalid";
      readonly detail?: string;
    };

/** Reconstruct the exact signed payload — `note` participates only when present (JCS). */
function recordPayload(record: AgentRevocationRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    spec: record.spec,
    motebit_id: record.motebit_id,
    revoked: record.revoked,
    reason: record.reason,
    actor: record.actor,
    effective_at: record.effective_at,
    relay_id: record.relay_id,
    relay_public_key: record.relay_public_key,
  };
  if (record.note !== undefined) base.note = record.note;
  return base;
}

/**
 * Verify a single signed `AgentRevocationRecord`. Recomputes the hash over the
 * signed payload, checks the signature against the embedded `relay_public_key`
 * under the declared suite, and — when `expectedRelayPublicKeyHex` is supplied
 * (the pinned anchor key) — enforces the producer-key pin so a key swap raises
 * `producer_key_mismatch` rather than silently verifying a new producer.
 */
export async function verifyAgentRevocationRecord(
  record: AgentRevocationRecord,
  expectedRelayPublicKeyHex?: string,
): Promise<AgentRevocationVerifyResult> {
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.spec !== "string" ||
    typeof record.motebit_id !== "string" ||
    typeof record.revoked !== "boolean" ||
    typeof record.reason !== "string" ||
    typeof record.actor !== "string" ||
    (record.note !== undefined && typeof record.note !== "string") ||
    typeof record.effective_at !== "number" ||
    typeof record.relay_id !== "string" ||
    typeof record.relay_public_key !== "string" ||
    typeof record.hash !== "string" ||
    typeof record.suite !== "string" ||
    typeof record.signature !== "string"
  ) {
    return { ok: false, reason: "malformed_record" };
  }

  if (
    expectedRelayPublicKeyHex !== undefined &&
    record.relay_public_key.toLowerCase() !== expectedRelayPublicKeyHex.toLowerCase()
  ) {
    return { ok: false, reason: "producer_key_mismatch" };
  }

  const canonical = new TextEncoder().encode(canonicalJson(recordPayload(record)));
  const computedHash = bytesToHex(await sha256(canonical));
  if (computedHash !== record.hash) {
    return { ok: false, reason: "hash_mismatch" };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(record.relay_public_key)) {
    return { ok: false, reason: "malformed_public_key" };
  }
  if (!/^[0-9a-fA-F]+$/.test(record.signature)) {
    return { ok: false, reason: "malformed_signature" };
  }

  let valid: boolean;
  try {
    valid = await verifyBySuite(
      record.suite,
      canonical,
      hexToBytes(record.signature),
      hexToBytes(record.relay_public_key),
    );
  } catch {
    return { ok: false, reason: "unsupported_suite" };
  }
  return valid ? { ok: true } : { ok: false, reason: "signature_invalid" };
}

/**
 * Verify the signed `AgentRevocationFeed` envelope AND every record inside it.
 * The feed signature covers `{spec, relay_id, relay_public_key, generated_at,
 * records}`; each record is also independently signed. Both layers must verify
 * against the same relay key (optionally pinned to `expectedRelayPublicKeyHex`).
 */
export async function verifyAgentRevocationFeed(
  feed: AgentRevocationFeed,
  expectedRelayPublicKeyHex?: string,
): Promise<AgentRevocationFeedVerifyResult> {
  if (
    typeof feed !== "object" ||
    feed === null ||
    typeof feed.spec !== "string" ||
    typeof feed.relay_id !== "string" ||
    typeof feed.relay_public_key !== "string" ||
    typeof feed.generated_at !== "number" ||
    !Array.isArray(feed.records) ||
    typeof feed.suite !== "string" ||
    typeof feed.signature !== "string"
  ) {
    return { ok: false, reason: "malformed_record" };
  }

  if (
    expectedRelayPublicKeyHex !== undefined &&
    feed.relay_public_key.toLowerCase() !== expectedRelayPublicKeyHex.toLowerCase()
  ) {
    return { ok: false, reason: "producer_key_mismatch" };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(feed.relay_public_key)) {
    return { ok: false, reason: "malformed_public_key" };
  }
  if (!/^[0-9a-fA-F]+$/.test(feed.signature)) {
    return { ok: false, reason: "malformed_signature" };
  }

  const payload = {
    spec: feed.spec,
    relay_id: feed.relay_id,
    relay_public_key: feed.relay_public_key,
    generated_at: feed.generated_at,
    records: feed.records,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  let valid: boolean;
  try {
    valid = await verifyBySuite(
      feed.suite,
      canonical,
      hexToBytes(feed.signature),
      hexToBytes(feed.relay_public_key),
    );
  } catch {
    return { ok: false, reason: "unsupported_suite" };
  }
  if (!valid) {
    return { ok: false, reason: "signature_invalid" };
  }

  // Every record must also verify against the same (pinned) key. Re-annotate
  // after the `Array.isArray` guard above, which narrows the element type to
  // `any` — the typed reference restores `AgentRevocationRecord`.
  const records: readonly AgentRevocationRecord[] = feed.records;
  for (const record of records) {
    const r = await verifyAgentRevocationRecord(record, feed.relay_public_key);
    if (!r.ok) {
      return { ok: false, reason: "record_invalid", detail: `${record.motebit_id}: ${r.reason}` };
    }
  }

  return { ok: true, count: feed.records.length };
}

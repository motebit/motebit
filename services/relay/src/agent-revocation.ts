/**
 * Agent-revocation producer — the relay side of the operator de-list power.
 *
 * The protocol defines the wire types (`@motebit/protocol/agent-revocation`);
 * this module is the producer: it signs `AgentRevocationRecord`s with the
 * relay identity (the same key the transparency declaration commits), writes
 * them to the append-only `relay_agent_revocations` table, and builds the
 * signed feed served at `GET /api/v1/agents/revocations`.
 *
 * Signing mirrors `buildSignedDeclaration` in `transparency.ts` exactly —
 * JCS canonicalization over the signed payload, SHA-256 hash, Ed25519
 * signature, post-sign fields appended. A verifier that already pins the
 * relay key for the transparency declaration verifies revocations with no
 * new machinery.
 *
 * Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md`,
 * `docs/doctrine/operator-transparency.md`, `services/relay/CLAUDE.md` rule 6
 * (relay is a convenience layer, not a trust root — a de-list is a relay-only
 * discoverability assertion, and it is made independently verifiable).
 */

import { canonicalJson, sign, bytesToHex, sha256 } from "@motebit/encryption";
import type { DatabaseDriver } from "@motebit/persistence";
import {
  AGENT_REVOCATION_SPEC_ID,
  AGENT_REVOCATION_SUITE,
  type AgentRevocationRecord,
  type AgentRevocationReason,
  type AgentRevocationActor,
  type AgentRevocationFeed,
} from "@motebit/protocol";
import type { RelayIdentity } from "./federation.js";

/** Inputs for a single revoke/reinstate state change. */
export interface RevocationInput {
  /** The agent whose discoverability is changing. */
  readonly motebitId: string;
  /** `true` = de-list from Discover, `false` = reinstate. */
  readonly revoked: boolean;
  /** Categorized reason (`reinstated` for an un-revoke). */
  readonly reason: AgentRevocationReason;
  /** Who performed it. */
  readonly actor: AgentRevocationActor;
  /** Optional free-text operator note. */
  readonly note?: string;
  /** Effective timestamp (defaults to now). */
  readonly effectiveAt?: number;
}

/**
 * Build a signed `AgentRevocationRecord`. Hash + signature cover the
 * `AgentRevocationSignedPayload` projection; `hash`, `suite`, `signature`
 * are appended after. `note` participates in the canonical bytes only when
 * present (JCS includes a key only when its value is defined).
 */
export async function buildSignedRevocationRecord(
  relayIdentity: RelayIdentity,
  input: RevocationInput,
  now: number = Date.now(),
): Promise<AgentRevocationRecord> {
  const payload = {
    spec: AGENT_REVOCATION_SPEC_ID,
    motebit_id: input.motebitId,
    revoked: input.revoked,
    reason: input.reason,
    actor: input.actor,
    ...(input.note !== undefined ? { note: input.note } : {}),
    effective_at: input.effectiveAt ?? now,
    relay_id: relayIdentity.relayMotebitId,
    relay_public_key: bytesToHex(relayIdentity.publicKey),
  };

  const canonicalBytes = new TextEncoder().encode(canonicalJson(payload));
  const hashHex = bytesToHex(await sha256(canonicalBytes));
  const signatureHex = bytesToHex(await sign(canonicalBytes, relayIdentity.privateKey));

  return {
    ...payload,
    hash: hashHex,
    suite: AGENT_REVOCATION_SUITE,
    signature: signatureHex,
  };
}

/**
 * Append a signed record to `relay_agent_revocations`. Append-only — a
 * revoke and a later reinstate are two rows, never an update. `record_json`
 * stores the byte-identical canonical record so the feed serves exactly what
 * was signed (same discipline as `relay_receipts.receipt_json`).
 */
export function insertRevocationRecord(db: DatabaseDriver, record: AgentRevocationRecord): void {
  db.prepare(
    `INSERT INTO relay_agent_revocations
       (motebit_id, revoked, reason, actor, note, effective_at,
        relay_id, relay_public_key, hash, suite, signature, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.motebit_id,
    record.revoked ? 1 : 0,
    record.reason,
    record.actor,
    record.note ?? null,
    record.effective_at,
    record.relay_id,
    record.relay_public_key,
    record.hash,
    record.suite,
    record.signature,
    canonicalJson(record),
  );
}

/**
 * Read every revocation record, oldest-first — the complete moderation
 * history. Returns the verbatim signed records (parsed from `record_json`),
 * so each is independently verifiable against the pinned relay key.
 */
export function listRevocationRecords(db: DatabaseDriver): AgentRevocationRecord[] {
  const rows = db
    .prepare(`SELECT record_json FROM relay_agent_revocations ORDER BY effective_at ASC, id ASC`)
    .all() as Array<{ record_json: string }>;
  return rows.map((r) => JSON.parse(r.record_json) as AgentRevocationRecord);
}

/**
 * Build the signed feed envelope. The relay signs the list digest so a
 * consumer can fetch the entire moderation history in one verifiable
 * response (in addition to each record being independently signed).
 * Signature covers `{spec, relay_id, relay_public_key, generated_at, records}`.
 */
export async function buildSignedRevocationFeed(
  relayIdentity: RelayIdentity,
  records: readonly AgentRevocationRecord[],
  now: number = Date.now(),
): Promise<AgentRevocationFeed> {
  const payload = {
    spec: AGENT_REVOCATION_SPEC_ID,
    relay_id: relayIdentity.relayMotebitId,
    relay_public_key: bytesToHex(relayIdentity.publicKey),
    generated_at: now,
    records,
  };

  const canonicalBytes = new TextEncoder().encode(canonicalJson(payload));
  const signatureHex = bytesToHex(await sign(canonicalBytes, relayIdentity.privateKey));

  return {
    ...payload,
    suite: AGENT_REVOCATION_SUITE,
    signature: signatureHex,
  };
}

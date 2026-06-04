/**
 * Agent-revocation — the operator's de-list power, made sovereign-verifiable.
 *
 * A permissionless relay accumulates junk: spam listings, abandoned test
 * agents, abusive capabilities. The only automatic remedy is the 90-day
 * no-heartbeat TTL — too slow for live abuse. The operator therefore needs
 * a hygiene tool: remove an agent from Discover.
 *
 * But an operator who can silently disappear an agent is exactly the trust
 * root the relay is forbidden from being (`services/relay/CLAUDE.md` rule 6:
 * "the relay is a convenience layer, not a trust root"). The move that keeps
 * this on-thesis is the same one motebit makes everywhere else — declared
 * posture → *proven* posture: every revocation is a **signed, reasoned,
 * publicly-fetchable statement**, not a silent DB flip.
 *
 * What revocation is and is not:
 *   - It is a **de-list**, not a **de-identify**. It sets the relay's
 *     `agent_registry.revoked` flag, which Discover filters
 *     (`task-routing.ts` `revokedFilter`). The agent's identity, key,
 *     succession chain, and receipts stay served by the
 *     identity-transparency endpoint — it remains hireable directly by id.
 *   - It is **post-hoc hygiene**, not **editorial curation**. Discovery
 *     stays permissionless (no allowlist, no pre-approval); the operator
 *     *removes* junk/abuse, it never *picks* winners.
 *   - It is **reversible**. An `unrevoke` is itself a signed record; the
 *     append-only feed is the operator's complete, auditable moderation
 *     history. A third party verifies each record against the relay's
 *     pinned public key — the same key the transparency declaration commits.
 *
 * This module exports the wire types only. The producer (signed-record
 * construction, the `agent_revocations` store, the revoke/unrevoke routes,
 * the `GET /api/v1/agents/revocations` feed) lives in `services/relay`.
 *
 * Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md`,
 * `docs/doctrine/operator-transparency.md`,
 * `docs/doctrine/self-attesting-system.md`.
 *
 * Permissive floor (Apache-2.0), type-only, zero runtime deps.
 */

// === Agent Revocation Reason (registered registry) ===

/**
 * The closed vocabulary of *why* an operator de-listed an agent (or
 * reinstated one). Carried on every `AgentRevocationRecord`, so the public
 * revocations feed is legible — a verifier reading the feed learns not just
 * *that* the operator removed an agent but *under what category*, which is
 * what converts "operator power" into "operator accountability."
 *
 * Registered registry per
 * [`docs/doctrine/registry-pattern-canonical.md`](../../../docs/doctrine/registry-pattern-canonical.md)
 * — the ninth instance after `SuiteId`, `TokenAudience`,
 * `ContentArtifactType`, `TaskShape`, `SensitivityLevel`, `EventType`,
 * `SettlementMode`, and `MerkleTreeVersion`. The four criteria are met:
 * interop law (a verifier reading the signed feed must agree on the reason
 * vocabulary), multi-consumer (relay producer, verifier, Discover UI),
 * wire-format presence (`AgentRevocationRecord.reason`), anticipated drift
 * (the categories will grow — `trademark`, `sanctions`, `court_order` — and
 * silently widening them would break feed consumers without the lock).
 *
 * `reinstated` is the canonical reason on an `unrevoke` (an
 * `AgentRevocationRecord` with `revoked: false`): the record still needs a
 * categorized reason so the append-only feed reads cleanly as a sequence of
 * state changes.
 */
export type AgentRevocationReason =
  | "operator_test_cleanup"
  | "spam"
  | "abuse"
  | "malware"
  | "policy_violation"
  | "dmca"
  | "reinstated";

/**
 * Canonical iteration order over `AgentRevocationReason`, frozen. Single
 * source of truth for "every revocation reason" — exhaustive switches, the
 * relay's reason validation, and the coverage gate
 * (`check-agent-revocation-reason-canonical`) all enumerate through this.
 *
 * Same shape as `ALL_SUITE_IDS`, `ALL_SETTLEMENT_MODES`, `ALL_EVENT_TYPES`.
 * Adding a reason is intentional protocol-level work: new union entry + new
 * entry here + gate reference update.
 */
export const ALL_AGENT_REVOCATION_REASONS: readonly AgentRevocationReason[] = Object.freeze([
  "operator_test_cleanup",
  "spam",
  "abuse",
  "malware",
  "policy_violation",
  "dmca",
  "reinstated",
] as AgentRevocationReason[]);

/**
 * Type guard — narrows `unknown` to `AgentRevocationReason`. The relay calls
 * this on the operator-supplied `reason` before signing a record so an
 * unrecognized reason fails closed rather than landing an un-typed value in
 * the signed, externally-verified feed.
 *
 * Same shape as `isSuiteId`, `isSettlementMode`, `isEventType`.
 */
export function isAgentRevocationReason(value: unknown): value is AgentRevocationReason {
  return (
    typeof value === "string" && (ALL_AGENT_REVOCATION_REASONS as readonly string[]).includes(value)
  );
}

// === Agent Revocation Record (signed envelope) ===

/**
 * The pinned cryptosuite for revocation records. JCS canonicalization
 * (RFC 8785) + Ed25519 + hex signature — the same family as the transparency
 * declaration, identity-file, and content-artifact manifests, so a verifier
 * that already pins the relay key for the transparency declaration verifies
 * revocations with no new machinery. See `SUITE_REGISTRY` in `./crypto-suite.ts`.
 */
export const AGENT_REVOCATION_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/**
 * Current spec identifier for the revocation wire format. Bumps require a
 * new wire-format spec doc; verifiers MUST reject records with an
 * unrecognized `spec`.
 */
export const AGENT_REVOCATION_SPEC_ID = "motebit-agent-revocation/draft-2026-06-04" as const;

/**
 * Who performed the state change. `operator` = the relay operator using the
 * hygiene tool (master-token authed). `self` = the agent deregistering
 * itself with its own key. The distinction is part of the record's
 * accountability surface: a verifier can separate operator moderation from
 * voluntary self-removal.
 */
export type AgentRevocationActor = "operator" | "self";

/**
 * A single, signed agent-revocation state change — one entry in the relay's
 * append-only revocations feed.
 *
 * Wire format (foundation law). Field names, types, and the canonical-JSON
 * ordering of the signed payload are protocol law. Each record is an
 * immutable event: a `revoke` (`revoked: true`) or an `unrevoke`
 * (`revoked: false`). Current state for a `motebit_id` is the latest record;
 * the full feed is the operator's auditable moderation history.
 *
 * Hash derivation: `sha256(utf8(canonicalJson(payload)))` where `payload` is
 * the `AgentRevocationSignedPayload` projection — the post-sign fields
 * (`hash`, `suite`, `signature`) are NOT part of the canonical bytes. Two
 * implementations hashing the same payload MUST produce the same hex.
 */
export interface AgentRevocationRecord {
  /** Spec identifier — e.g. `"motebit-agent-revocation/draft-2026-06-04"`. */
  readonly spec: string;
  /** The agent whose discoverability changed. Same MotebitId space as agent identities. */
  readonly motebit_id: string;
  /** Resulting state: `true` = de-listed from Discover, `false` = reinstated. */
  readonly revoked: boolean;
  /** Categorized reason. `reinstated` accompanies `revoked: false`. */
  readonly reason: AgentRevocationReason;
  /** Who performed the change. */
  readonly actor: AgentRevocationActor;
  /** Optional free-text operator note (human context; not a substitute for `reason`). */
  readonly note?: string;
  /** Epoch milliseconds when the change took effect. */
  readonly effective_at: number;
  /** Relay's identity — same MotebitId space as agent identities. */
  readonly relay_id: string;
  /** Hex-encoded Ed25519 public key of the relay (32 bytes / 64 chars) — the trust anchor. */
  readonly relay_public_key: string;
  /** Hex-encoded SHA-256 of the canonical-JSON of the signed payload. */
  readonly hash: string;
  /** Cryptosuite identifier — `motebit-jcs-ed25519-hex-v1` today. */
  readonly suite: "motebit-jcs-ed25519-hex-v1";
  /** Hex-encoded Ed25519 signature over the canonical-JSON of the signed payload. */
  readonly signature: string;
}

/**
 * The signed payload — exactly what `hash` and `signature` cover. Exposed so
 * producers construct + canonicalize the precise bytes the verifier checks.
 * The post-sign fields (`hash`, `suite`, `signature`) are appended AFTER
 * signing and are NOT part of this payload. `note` is included when present
 * (optional fields participate in JCS only when defined).
 */
export type AgentRevocationSignedPayload = Pick<
  AgentRevocationRecord,
  | "spec"
  | "motebit_id"
  | "revoked"
  | "reason"
  | "actor"
  | "note"
  | "effective_at"
  | "relay_id"
  | "relay_public_key"
>;

/**
 * The signed feed envelope served at `GET /api/v1/agents/revocations`. The
 * relay signs the list digest so a consumer can fetch the operator's entire
 * moderation history in one verifiable response (in addition to each record
 * being independently signed). Same suite + relay key as the records.
 */
export interface AgentRevocationFeed {
  /** Spec identifier — matches the records' `spec`. */
  readonly spec: string;
  /** The relay's identity. */
  readonly relay_id: string;
  /** Hex-encoded Ed25519 public key of the relay. */
  readonly relay_public_key: string;
  /** Epoch milliseconds when the feed snapshot was minted. */
  readonly generated_at: number;
  /** Every revocation state change, oldest-first. */
  readonly records: readonly AgentRevocationRecord[];
  /** Cryptosuite identifier. */
  readonly suite: "motebit-jcs-ed25519-hex-v1";
  /** Ed25519 signature over the canonical-JSON of `{spec, relay_id, relay_public_key, generated_at, records}`. */
  readonly signature: string;
}

/**
 * Type guard — narrows `unknown` to `AgentRevocationRecord`. Structural shape
 * only; does NOT verify the signature. Verifiers call this before parsing,
 * then proceed through the verification algorithm (strip post-sign fields,
 * canonicalize, Ed25519-verify against the pinned relay key).
 */
export function isAgentRevocationRecord(value: unknown): value is AgentRevocationRecord {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.spec === "string" &&
    typeof o.motebit_id === "string" &&
    typeof o.revoked === "boolean" &&
    isAgentRevocationReason(o.reason) &&
    (o.actor === "operator" || o.actor === "self") &&
    (o.note === undefined || typeof o.note === "string") &&
    typeof o.effective_at === "number" &&
    typeof o.relay_id === "string" &&
    typeof o.relay_public_key === "string" &&
    typeof o.hash === "string" &&
    typeof o.suite === "string" &&
    typeof o.signature === "string"
  );
}

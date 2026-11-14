/**
 * Standing Delegation + Delegation Revocation — wire schemas (standing-delegation@1.0).
 *
 * A `StandingDelegation` grant authorizes its holder to mint short-lived
 * per-tick `DelegationToken`s within a fixed scope ceiling and cadence, for a
 * long-but-finite, revocable lifetime. A `DelegationRevocation` terminates a
 * grant. Both are signed and offline-verifiable like a delegation token: an
 * external (non-motebit) verifier validates a standing monitor's authorization
 * root, every per-tick token, and a revocation with only these JSON Schemas and
 * any Ed25519 library — no relay contact.
 *
 * StandingDelegation verifiers MUST:
 *   1. Check `suite` == "motebit-jcs-ed25519-b64-v1"
 *   2. Check `not_before == null || now >= not_before`, and `now <= expires_at`
 *   3. Check the grant is not revoked (a signed DelegationRevocation for `grant_id`)
 *   4. Canonicalize the body (everything except `signature`) via JCS, verify
 *      the Ed25519 signature against `delegator_public_key`
 *
 * A per-tick token is a valid tick of a grant iff (in addition to verifying as
 * a DelegationToken): `grant_id` matches, the grant verifies, the parties match,
 * `scope` narrows within the grant's ceiling, and the token's TTL ≤
 * `max_token_ttl_ms`. Cadence is a mint/relay-side rate limit, not a single-
 * token verification rule.
 *
 * See `spec/standing-delegation-v1.md`.
 */

import { z } from "zod";

import type {
  StandingDelegation,
  DelegationRevocation,
  DelegationRevocationHead,
  DelegationRevocationInclusionReceipt,
  SubjectBindingV1,
  SpendCeilingV1,
} from "@motebit/protocol";

import { assembleJsonSchemaFor, toDraft7 } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id`s for the standing-delegation v1 wire formats. External tools pin to these. */
export const STANDING_DELEGATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/standing-delegation-v1.json";
export const DELEGATION_REVOCATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/delegation-revocation-v1.json";
export const SUBJECT_BINDING_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/subject-binding-v1.json";
export const SPEND_CEILING_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/spend-ceiling-v1.json";
export const DELEGATION_REVOCATION_HEAD_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/delegation-revocation-head-v1.json";
export const DELEGATION_REVOCATION_INCLUSION_RECEIPT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/delegation-revocation-receipt-v1.json";

const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * JCS interop ceiling on every SpendCeilingV1 numeric (agency review,
 * 2026-07-05): RFC 8785 serializes numbers per ECMAScript, so an integer
 * above 2^53−1 does not survive canonicalization faithfully — a larger
 * delegator-chosen limit could produce different signed bytes across
 * implementations. Pinning `maximum` costs nothing (a $9-billion ceiling
 * is not a bound anyone meets honestly) and buys byte-stable signatures.
 */
const MAX_SAFE_JCS_INT = 9_007_199_254_740_991;

/**
 * §3.3 wire-format shape law, enforced in BOTH validators (agency review):
 * every per-window limit "Requires `window_ms`". The zod side enforces it
 * here (superRefine); the committed JSON Schema enforces it via draft-07
 * `dependencies` injected by the emitters below — the two validators must
 * never disagree about what the wire format forbids. Deliberately NOT
 * enforced: rule 3's at-least-one-total-bound — that is enforcement law
 * (a bare ceiling is well-formed-but-authorizes-nothing), not shape law.
 */
const PER_WINDOW_FIELDS = [
  "cumulative_limit_micro",
  "per_counterparty_limit_micro",
  "max_action_count",
] as const;

const SPEND_CEILING_WINDOW_DEPENDENCIES: Record<string, string[]> = Object.fromEntries(
  PER_WINDOW_FIELDS.map((f) => [f, ["window_ms"]]),
);

/** Inject the window `dependencies` at a ceiling-shaped schema node,
 *  failing loud if the emitter's structure drifted from expectation.
 *  Exported for the shape-law test suite (the throw arms are the
 *  structure-drift alarm and must stay covered). */
export function injectWindowDependencies(node: unknown, where: string): void {
  if (
    node == null ||
    typeof node !== "object" ||
    (node as Record<string, unknown>)["properties"] == null
  ) {
    throw new Error(
      `spend-ceiling dependencies injection: no ceiling-shaped node at ${where} — the zod-to-json-schema output shape changed, fix the emitter in packages/wire-schemas/src/standing-delegation.ts`,
    );
  }
  (node as Record<string, unknown>)["dependencies"] = SPEND_CEILING_WINDOW_DEPENDENCIES;
}

/**
 * Generic subject-scope binding (standing-delegation@1.1). Digest-binds a
 * detached, vertically-typed scope artifact so the delegator's signature reaches
 * the EXACT resolved subjects. Unsigned by construction — authority is the
 * enclosing grant's signature over `digest`. NOT a `suite` (signature scheme);
 * `digest_method` is a HASH method.
 */
export const SubjectBindingV1Schema = z
  .object({
    schema: z
      .literal("motebit.subject-binding.v1")
      .describe("This binding's own type tag (in-body domain separation)."),
    artifact_schema: z
      .string()
      .min(1)
      .describe(
        "Declared type of the detached artifact this digest addresses (e.g. `motebit.monitor-scope.v1`). The verifier MUST check the presented artifact's `schema` equals this, fail-closed.",
      ),
    digest_method: z
      .literal("jcs-sha256-hex")
      .describe(
        "How `digest` was computed: `hex(SHA-256(canonicalJson(artifact)))`. A new hash is a new literal here, never a silent change. NOT a signature `suite`.",
      ),
    digest: z
      .string()
      .regex(HEX_SHA256_PATTERN)
      .describe(
        "`hex(SHA-256(canonicalJson(detached artifact)))`, 64 lowercase. Recompute from the artifact as received so JSON whitespace can't break the match.",
      ),
  })
  .strict();

/**
 * The delegator's signed autonomous-spend ceiling (standing-delegation@1.2).
 * Rides in the grant's signed body — the HOW-MUCH as a cryptographic
 * commitment. Limits are integer micro-units, USD-denominated (1 USD =
 * 1,000,000; pinned by spec prose — a new asset model is a new `schema`
 * literal). Absent from a grant ⇒ NO autonomous money (`ceiling_absent`,
 * fail-closed). Semantic sufficiency (at least one total bound; `window_ms`
 * with per-window limits) is the blast-radius evaluator's law, not a shape
 * constraint — the schema constrains each field, the enforcer denies
 * insufficient combinations.
 */
export const SpendCeilingV1Schema = z
  .object({
    schema: z
      .literal("motebit.spend-ceiling.v1")
      .describe("This ceiling's own type tag (in-body domain separation)."),
    cumulative_limit_micro: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SAFE_JCS_INT)
      .optional()
      .describe(
        "Max cumulative spend (integer micro-USD, ≤ 2^53−1 for JCS number fidelity) within one rolling window. Requires `window_ms`. A SET value of 0 denies all positive spend on this dimension.",
      ),
    per_counterparty_limit_micro: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SAFE_JCS_INT)
      .optional()
      .describe(
        "Max spend (integer micro-USD, ≤ 2^53−1) to any single canonical counterparty within one window. Requires `window_ms`. Counterparty canonicalization is consumer-local runtime law (spec §3.3).",
      ),
    max_action_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SAFE_JCS_INT)
      .optional()
      .describe("Max number of money actions within one window (≤ 2^53−1). Requires `window_ms`."),
    lifetime_limit_micro: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SAFE_JCS_INT)
      .optional()
      .describe(
        "Max cumulative spend (integer micro-USD, ≤ 2^53−1) over the grant's ENTIRE life — never reset by a window roll. The offline-meaningful total bound (paired with the grant's `expires_at`).",
      ),
    window_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_SAFE_JCS_INT)
      .optional()
      .describe(
        "Rolling window length in ms (≤ 2^53−1). Required (> 0) when any per-window limit is set.",
      ),
  })
  .strict()
  .superRefine((ceiling, ctx) => {
    if (ceiling.window_ms !== undefined) return;
    for (const field of PER_WINDOW_FIELDS) {
      if (ceiling[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} requires window_ms (spec/standing-delegation-v1.md §3.3 wire format)`,
        });
      }
    }
  });

export const StandingDelegationSchema = z
  .object({
    grant_id: z
      .string()
      .min(1)
      .describe(
        "UUIDv7 — the stable handle a DelegationRevocation targets. Per-tick tokens minted under this grant carry it as `grant_id`.",
      ),
    delegator_id: z
      .string()
      .min(1)
      .describe("Delegator's motebit identity — the entity granting standing authority."),
    delegator_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegator's Ed25519 public key, hex-encoded (64 lowercase). Verifies `signature`. Embedded so verification needs no relay lookup.",
      ),
    delegate_id: z
      .string()
      .min(1)
      .describe("Delegate's motebit identity — the entity authorized to mint per-tick tokens."),
    delegate_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegate's Ed25519 public key, hex-encoded (64 lowercase). Per-tick tokens must name this same delegate.",
      ),
    scope: z
      .string()
      .min(1)
      .describe(
        "Comma-separated capability CEILING, or `*`. Each minted per-tick token's scope must narrow within this. Same grammar as DelegationToken.scope (market-v1 §12.3).",
      ),
    subject: z
      .string()
      .describe(
        "Human-meaningful binding (e.g. `research:thesis=acme-q3`). Opaque to verification; carried for receipt-linkage and operator legibility.",
      ),
    subject_binding: SubjectBindingV1Schema.optional().describe(
      "Optional (standing-delegation@1.1). Digest-binds the resolved subject-scope artifact this grant's authority reaches; part of the signed body, so the delegator's signature covers the resolved scope. Absent ⇒ a @1.0 grant with no signed resolved scope (higher-assurance consumers MUST fail closed). NOT the capability `scope`.",
    ),
    spend_ceiling: SpendCeilingV1Schema.optional().describe(
      "Optional (standing-delegation@1.2). The delegator's signed autonomous-spend ceiling — the HOW-MUCH this grant authorizes, as a cryptographic commitment (part of the signed body). Absent ⇒ the grant authorizes NO autonomous money (enforcers deny `ceiling_absent`, fail-closed) — a @1.0/@1.1 grant verifies unchanged and simply cannot move money.",
    ),
    cadence_ms: z
      .number()
      .describe(
        "Authorized minimum firing interval, milliseconds. A per-tick rate limit enforced at mint/relay time — NOT a single-token verification rule.",
      ),
    issued_at: z.number().describe("Unix timestamp in milliseconds when the grant was issued."),
    not_before: z
      .number()
      .nullable()
      .describe("Optional activation delay (Unix ms). Null ⇒ active from `issued_at`."),
    expires_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds after which the grant is invalid. Long-but-finite and renewable — NOT open-ended; the delegate renews by re-signing. See standing-delegation-v1 §6 D1.",
      ),
    max_token_ttl_ms: z
      .number()
      .describe(
        "Ceiling on each minted token's `(expires_at - issued_at)`. Keeps per-tick tokens short-lived even though the grant lives long.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1`: JCS (RFC 8785), Ed25519, base64url signature, hex public keys.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(body)` (this object minus `signature`). Verify with `delegator_public_key`.",
      ),
  })
  .strict();

export const DelegationRevocationSchema = z
  .object({
    grant_id: z.string().min(1).describe("The StandingDelegation.grant_id being revoked."),
    delegator_id: z
      .string()
      .min(1)
      .describe("Delegator's motebit identity. MUST equal the grant's delegator."),
    delegator_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegator's Ed25519 public key, hex-encoded (64 lowercase). Verifies `signature`. To bind a grant, MUST equal that grant's `delegator_public_key`.",
      ),
    revoked_at: z.number().describe("Unix timestamp in milliseconds when the grant was revoked."),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1`: JCS (RFC 8785), Ed25519, base64url signature, hex public keys.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(body)` (this object minus `signature`). Verify with `delegator_public_key`.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Signed revocation evidence (standing-delegation@1.3, spec §5.2–§5.3)
// ---------------------------------------------------------------------------

const RELAY_SUITE = z
  .literal("motebit-jcs-ed25519-b64-v1")
  .describe(
    "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1`: JCS (RFC 8785), Ed25519, base64url signature, hex public keys.",
  );
const RELAY_SIGNATURE = z
  .string()
  .min(1)
  .describe(
    "Base64url-encoded Ed25519 signature over `canonicalJson(body)` (this object minus `signature`), by `relay_public_key`. Verify against the relay key the consumer PINS — the embedded key alone proves nothing.",
  );
const RELAY_PUBLIC_KEY = z
  .string()
  .regex(HEX_PUBLIC_KEY_PATTERN)
  .describe(
    "The relay's Ed25519 public key, hex-encoded (64 lowercase). Consumers compare it to the key they pin.",
  );
const SAFE_SEQ = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const SAFE_NON_NEGATIVE = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const DelegationRevocationHeadEntrySchema = z
  .object({
    seq: SAFE_SEQ.describe(
      "The relay's receipt sequence number for this record (positive integer). Entries are strictly ascending by `seq`.",
    ),
    received_at: SAFE_NON_NEGATIVE.describe(
      "Unix ms, the relay's receipt clock — never the signer-asserted `revoked_at`.",
    ),
    record: DelegationRevocationSchema.describe(
      "The DelegationRevocation exactly as the delegator signed it. Authoritative over a grant only through the §5.1 binding check (grant_id + delegator key + signature).",
    ),
  })
  .strict();

export const DelegationRevocationHeadSchema = z
  .object({
    spec: z
      .literal("motebit/delegation-revocation-head@1.0")
      .describe(
        "Artifact discriminator (domain separation from every other relay-signed artifact).",
      ),
    relay_id: z.string().min(1).describe("The relay's motebit identity."),
    relay_public_key: RELAY_PUBLIC_KEY,
    delegator_id: z
      .string()
      .min(1)
      .describe(
        "The delegator whose revocations this head covers. Every entry's `record.delegator_id` MUST equal it.",
      ),
    challenge: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "The consumer-chosen challenge, echoed verbatim. A head without the consumer's challenge answers no request of theirs.",
      ),
    as_of: SAFE_NON_NEGATIVE.describe(
      "Unix ms at which the relay assembled the head. Consumers MUST refuse a head older than their freshness window plus clock skew, or newer than clock skew.",
    ),
    seq_high_water: SAFE_NON_NEGATIVE.describe(
      "The relay's highest assigned receipt sequence number at `as_of`. Every entry's `seq` MUST be ≤ it. Consumers MUST refuse a head below one they already accepted from the same relay key (rollback).",
    ),
    count: SAFE_NON_NEGATIVE.describe("Number of entries. MUST equal `entries.length`."),
    entries: z
      .array(DelegationRevocationHeadEntrySchema)
      .describe(
        "Every revocation the relay holds for `delegator_id` with `seq <= seq_high_water`, strictly ascending by `seq`.",
      ),
    records_digest: z
      .string()
      .regex(HEX_SHA256_PATTERN)
      .describe(
        "hex(SHA-256(canonicalJson(entries))), 64 lowercase. Excludes `challenge` and `as_of`, so two heads at the same `seq_high_water` are comparable by digest (equivocation evidence).",
      ),
    suite: RELAY_SUITE,
    signature: RELAY_SIGNATURE,
  })
  .strict();

export const DelegationRevocationInclusionReceiptSchema = z
  .object({
    spec: z
      .literal("motebit/delegation-revocation-inclusion-receipt@1.0")
      .describe(
        "Artifact discriminator (domain separation from every other relay-signed artifact).",
      ),
    relay_id: z.string().min(1).describe("The relay's motebit identity."),
    relay_public_key: RELAY_PUBLIC_KEY,
    grant_id: z.string().min(1).describe("The recorded revocation's `grant_id`."),
    delegator_id: z.string().min(1).describe("The recorded revocation's `delegator_id`."),
    revocation_signature: z
      .string()
      .min(1)
      .describe(
        "The recorded DelegationRevocation's `signature`, verbatim — the record's identity (the relay is idempotent on it).",
      ),
    seq: SAFE_SEQ.describe(
      "The receipt sequence number the relay assigned to the record. A later head from the same relay key with `seq_high_water >= seq` MUST carry the record at this seq; one that does not proves the relay contradicted itself.",
    ),
    received_at: SAFE_NON_NEGATIVE.describe("Unix ms, the relay's receipt clock."),
    suite: RELAY_SUITE,
    signature: RELAY_SIGNATURE,
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half (bare `true`; see CLAUDE.md)
// ---------------------------------------------------------------------------

type InferredStanding = z.infer<typeof StandingDelegationSchema>;
type InferredRevocation = z.infer<typeof DelegationRevocationSchema>;
type InferredSubjectBinding = z.infer<typeof SubjectBindingV1Schema>;
type InferredSpendCeiling = z.infer<typeof SpendCeilingV1Schema>;
type InferredRevocationHead = z.infer<typeof DelegationRevocationHeadSchema>;
type InferredInclusionReceipt = z.infer<typeof DelegationRevocationInclusionReceiptSchema>;

type _RevocationHeadForward = ParityForward<DelegationRevocationHead, InferredRevocationHead>;
type _RevocationHeadReverse = ParityReverse<DelegationRevocationHead, InferredRevocationHead>;

export const _DELEGATION_REVOCATION_HEAD_TYPE_PARITY: {
  forward: _RevocationHeadForward;
  reverse: _RevocationHeadReverse;
} = {
  forward: true,
  reverse: true,
};

type _InclusionReceiptForward = ParityForward<
  DelegationRevocationInclusionReceipt,
  InferredInclusionReceipt
>;
type _InclusionReceiptReverse = ParityReverse<
  DelegationRevocationInclusionReceipt,
  InferredInclusionReceipt
>;

export const _DELEGATION_REVOCATION_INCLUSION_RECEIPT_TYPE_PARITY: {
  forward: _InclusionReceiptForward;
  reverse: _InclusionReceiptReverse;
} = {
  forward: true,
  reverse: true,
};

type _SpendCeilingForward = ParityForward<SpendCeilingV1, InferredSpendCeiling>;
type _SpendCeilingReverse = ParityReverse<SpendCeilingV1, InferredSpendCeiling>;

export const _SPEND_CEILING_TYPE_PARITY: {
  forward: _SpendCeilingForward;
  reverse: _SpendCeilingReverse;
} = {
  forward: true,
  reverse: true,
};

type _SubjectBindingForward = ParityForward<SubjectBindingV1, InferredSubjectBinding>;
type _SubjectBindingReverse = ParityReverse<SubjectBindingV1, InferredSubjectBinding>;

export const _SUBJECT_BINDING_TYPE_PARITY: {
  forward: _SubjectBindingForward;
  reverse: _SubjectBindingReverse;
} = {
  forward: true,
  reverse: true,
};

type _StandingForward = ParityForward<StandingDelegation, InferredStanding>;
type _StandingReverse = ParityReverse<StandingDelegation, InferredStanding>;
type _RevocationForward = ParityForward<DelegationRevocation, InferredRevocation>;
type _RevocationReverse = ParityReverse<DelegationRevocation, InferredRevocation>;

export const _STANDING_DELEGATION_TYPE_PARITY: {
  forward: _StandingForward;
  reverse: _StandingReverse;
} = {
  forward: true,
  reverse: true,
};

export const _DELEGATION_REVOCATION_TYPE_PARITY: {
  forward: _RevocationForward;
  reverse: _RevocationReverse;
} = {
  forward: true,
  reverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitters
// ---------------------------------------------------------------------------

export function buildStandingDelegationJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(StandingDelegationSchema);
  const assembled = assembleJsonSchemaFor(raw, {
    $id: STANDING_DELEGATION_SCHEMA_ID,
    title: "StandingDelegation (v1)",
    description:
      "Signed, revocable standing grant authorizing minting short-lived per-tick DelegationTokens within a fixed scope ceiling and cadence. Canonicalization: JCS (RFC 8785). Signature: Ed25519 over canonicalJson(body minus signature), base64url. See spec/standing-delegation-v1.md.",
  });
  // The embedded spend_ceiling copies carry the same §3.3 window
  // dependencies as the standalone schema — the grant schema must refuse
  // what the wire format forbids, same as spend-ceiling-v1.json.
  // zod 4's native z.toJSONSchema inlines fully — there is no `definitions`
  // bag to also inject into (unlike the old zod-to-json-schema $refStrategy).
  const props = assembled["properties"] as Record<string, unknown> | undefined;
  injectWindowDependencies(
    props?.["spend_ceiling"],
    "standing-delegation-v1.json properties.spend_ceiling",
  );
  return assembled;
}

export function buildSubjectBindingV1JsonSchema(): Record<string, unknown> {
  const raw = toDraft7(SubjectBindingV1Schema);
  return assembleJsonSchemaFor(raw, {
    $id: SUBJECT_BINDING_SCHEMA_ID,
    title: "SubjectBindingV1 (v1)",
    description:
      "Generic subject-scope binding (standing-delegation@1.1). Digest-binds a detached, vertically-typed scope artifact so a StandingDelegation's delegator signature reaches the EXACT resolved subjects. Unsigned — authority is the enclosing grant's signature over `digest`. `digest_method` is a HASH method (jcs-sha256-hex), NOT a signature suite. See spec/standing-delegation-v1.md §3.2.",
  });
}

export function buildSpendCeilingV1JsonSchema(): Record<string, unknown> {
  const raw = toDraft7(SpendCeilingV1Schema);
  const assembled = assembleJsonSchemaFor(raw, {
    $id: SPEND_CEILING_SCHEMA_ID,
    title: "SpendCeilingV1 (v1)",
    description:
      "The delegator's signed autonomous-spend ceiling (standing-delegation@1.2) — the HOW-MUCH a StandingDelegation authorizes, carried in the grant's signed body as a cryptographic commitment. Integer micro-units, USD-denominated (1 USD = 1,000,000), each ≤ 2^53−1 for JCS number fidelity. Per-window limits require `window_ms` (enforced via `dependencies`). Absent from a grant ⇒ no autonomous money (fail-closed `ceiling_absent`). See spec/standing-delegation-v1.md §3.3.",
  });
  // Native inlines fully — the root IS the ceiling object; no definitions bag.
  injectWindowDependencies(assembled, "spend-ceiling-v1.json root");
  return assembled;
}

export function buildDelegationRevocationJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(DelegationRevocationSchema);
  return assembleJsonSchemaFor(raw, {
    $id: DELEGATION_REVOCATION_SCHEMA_ID,
    title: "DelegationRevocation (v1)",
    description:
      "Signed, offline-verifiable revocation of a StandingDelegation. Only the grant's delegator may sign one. The canonical source of truth for grant revocation. See spec/standing-delegation-v1.md.",
  });
}

export function buildDelegationRevocationHeadJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(DelegationRevocationHeadSchema);
  return assembleJsonSchemaFor(raw, {
    $id: DELEGATION_REVOCATION_HEAD_SCHEMA_ID,
    title: "DelegationRevocationHead (v1)",
    description:
      "The relay's signed snapshot of every DelegationRevocation it holds for one delegator up to `seq_high_water`, answering one consumer challenge (standing-delegation@1.3). The only source of 'absent as of `as_of`'; never confers authority. Guarantees integrity, freshness and relay accountability — NOT completeness against omission, NOT non-equivocation. Canonicalization: JCS (RFC 8785). Signature: Ed25519 over canonicalJson(body minus signature), base64url. See spec/standing-delegation-v1.md §5.2.",
  });
}

export function buildDelegationRevocationInclusionReceiptJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(DelegationRevocationInclusionReceiptSchema);
  return assembleJsonSchemaFor(raw, {
    $id: DELEGATION_REVOCATION_INCLUSION_RECEIPT_SCHEMA_ID,
    title: "DelegationRevocationInclusionReceipt (v1)",
    description:
      "The relay's signed statement that it recorded one DelegationRevocation at `seq` (standing-delegation@1.3). With a later head from the same relay key covering `seq` but lacking the record, proves relay self-contradiction (omission) — never independent acceptance (same signer). Canonicalization: JCS (RFC 8785). Signature: Ed25519 over canonicalJson(body minus signature), base64url. See spec/standing-delegation-v1.md §5.3.",
  });
}

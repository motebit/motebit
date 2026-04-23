/**
 * Consolidation receipt + anchor wire schemas — proactive-interior work
 * as self-attesting, chain-anchorable evidence.
 *
 * Two artifacts in this cluster:
 *
 *   1. `ConsolidationReceipt` — a motebit's signed structural record of
 *      a single consolidation cycle (counts of memories merged,
 *      promoted, pruned; phase list; timestamps). Self-verifiable from
 *      the receipt bytes + the motebit's public key alone. The privacy
 *      boundary is the type: no field carries memory content,
 *      embeddings, or sensitive identifiers. Evolution that would leak
 *      content is a protocol break.
 *
 *   2. `ConsolidationAnchor` — a Merkle-batched commitment over N signed
 *      receipts, optionally published as a Solana memo. Not separately
 *      signed — cryptographic load is (a) the signatures on the
 *      receipts it groups, and (b) the Solana tx signature when
 *      `tx_hash` is populated.
 *
 * Cryptosuite for the receipt: `motebit-jcs-ed25519-b64-v1` — JCS
 * canonicalization, Ed25519 primitive, base64url signature encoding,
 * hex public-key encoding. Matches execution-receipts + balance-waivers.
 *
 * Third-party verification reference: `verifyConsolidationAnchor` in
 * `@motebit/encryption`. Any implementation that can do JSON-Schema
 * validation + Ed25519 + SHA-256 can build an interoperable verifier
 * from these schemas + the spec.
 *
 * See spec/consolidation-receipt-v1.md.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ConsolidationAnchor, ConsolidationReceipt } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const CONSOLIDATION_RECEIPT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/consolidation-receipt-v1.json";

export const CONSOLIDATION_ANCHOR_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/consolidation-anchor-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factories (description-preserving — factories not constants)
// ---------------------------------------------------------------------------

const phaseField = () =>
  z
    .enum(["orient", "gather", "consolidate", "prune"])
    .describe(
      "One of the four consolidation-cycle phases. Closed union: adding a phase is a protocol-coordinated change (new enum value + new wire version).",
    );

const suiteField = () =>
  z
    .literal("motebit-jcs-ed25519-b64-v1")
    .describe(
      "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for consolidation receipts: JCS canonicalization (RFC 8785), Ed25519 primitive, base64url signature encoding, hex public-key encoding. Verifiers reject missing or unknown values fail-closed.",
    );

// ---------------------------------------------------------------------------
// ConsolidationReceipt — signed per-cycle structural record
// ---------------------------------------------------------------------------

export const ConsolidationReceiptSchema = z
  .object({
    receipt_id: z
      .string()
      .min(1)
      .describe(
        "UUIDv4 — the receipt's own identity. Distinct from `cycle_id`: a cycle may (in future versions) produce multiple receipts, and receipts outlive their cycle in the audit log.",
      ),
    motebit_id: z
      .string()
      .min(1)
      .describe("Signer's MotebitId. Also the Solana address when anchored (Ed25519 coincidence)."),
    public_key: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Hex-encoded Ed25519 public key of the signer. Embedded for portable verification — third parties verify without a registry lookup. Optional for backward-compat; new receipts SHOULD include it.",
      ),
    cycle_id: z
      .string()
      .min(1)
      .describe(
        "Matches the `cycle_id` carried by the `consolidation_cycle_run` event the runtime emits at cycle completion. Verifiers cross-reference to correlate receipts with audit events.",
      ),
    started_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the cycle's first phase began. Signed — a verifier cannot backdate a receipt without breaking the signature.",
      ),
    finished_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the cycle's last phase completed or yielded. `finished_at >= started_at` is a semantic invariant verifiers MAY check.",
      ),
    phases_run: z
      .array(phaseField())
      .describe(
        "Ordered list of phases that ran to completion (or yielded with partial work). Lets verifiers scope a receipt to specific work (e.g., a prune-only cycle vs. a full orient → gather → consolidate → prune).",
      ),
    phases_yielded: z
      .array(phaseField())
      .describe(
        "Subset of `phases_run` — phases whose AbortSignal fired mid-execution (budget exhausted or parent signal aborted). Lets verifiers distinguish fully-completed cycles from budget-clipped ones.",
      ),
    summary: z
      .object({
        orient_nodes: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Count of nodes touched during the orient phase. Structural count only — never a node identifier or content.",
          ),
        gather_clusters: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Count of episodic-memory clusters identified during gather."),
        gather_notable: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Count of memories ranked notable for reflection during gather."),
        consolidate_merged: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Count of cluster-merges produced during consolidate (each merge tombstones N ≥ 2 episodic memories and forms one semantic memory).",
          ),
        pruned_decay: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Count of memories tombstoned during prune due to decayed-confidence threshold.",
          ),
        pruned_notability: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Count of memories tombstoned during prune due to low-notability threshold (isolated, low-confidence, low-relevance).",
          ),
        pruned_retention: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Count of memories tombstoned during prune due to sensitivity-level retention policy (privacy-layer enforced).",
          ),
      })
      .strict()
      .describe(
        "Structural counts. Closed field set — the privacy boundary is the type. A v2 receipt adding a field that could carry memory content, embeddings, or sensitive identifiers is a protocol break; interoperable evolution is additive-counts-only.",
      ),
    suite: suiteField(),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature. Signed body is `canonicalJson(receipt_without_signature)`. Verifiers reconstruct canonical bytes from all fields except `signature`, encode to UTF-8, run Ed25519.verify against `public_key` (or a looked-up key).",
      ),
  })
  // Forward-compat: unknown fields MUST be ignored so v1 verifiers don't
  // break when a v2 emitter adds fields. This matches the pattern in
  // memory-events and agent-settlement-anchor.
  .passthrough();

type _ReceiptForward =
  ConsolidationReceipt extends z.infer<typeof ConsolidationReceiptSchema> ? true : never;
type _ReceiptReverse =
  z.infer<typeof ConsolidationReceiptSchema> extends ConsolidationReceipt ? true : never;

export const _CONSOLIDATION_RECEIPT_TYPE_PARITY: {
  forward: _ReceiptForward;
  reverse: _ReceiptReverse;
} = {
  forward: true as _ReceiptForward,
  reverse: true as _ReceiptReverse,
};

export function buildConsolidationReceiptJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ConsolidationReceiptSchema, {
    name: "ConsolidationReceipt",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ConsolidationReceipt", raw, {
    $id: CONSOLIDATION_RECEIPT_SCHEMA_ID,
    title: "ConsolidationReceipt (v1)",
    description:
      "Signed structural proof of a single consolidation cycle's output. The motebit's Ed25519 identity key commits to counts of memories merged / promoted / pruned, the cycle's phase list, and timestamps. Self-verifiable from the receipt bytes + the signer's public key alone — no relay, no billing relationship. The privacy boundary is the type: no field carries memory content. See spec/consolidation-receipt-v1.md §3.",
  });
}

// ---------------------------------------------------------------------------
// ConsolidationAnchor — Merkle-batched commitment over receipts
// ---------------------------------------------------------------------------

export const ConsolidationAnchorSchema = z
  .object({
    batch_id: z
      .string()
      .min(1)
      .describe("UUIDv4 — the anchor's own identity. Stable across event-log replays."),
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "The motebit whose receipts are batched. Also the signer of the Solana transaction when `tx_hash` is populated (identity key IS the Solana address by Ed25519 coincidence).",
      ),
    merkle_root: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded SHA-256 Merkle root over the receipts' canonical-body leaf hashes. Stable for a given ordered set of receipts. When `tx_hash` is populated, this value is also recorded in the Solana memo (`motebit:anchor:v1:{merkle_root}:{leaf_count}`).",
      ),
    receipt_ids: z
      .array(z.string().min(1))
      .describe(
        "Receipt IDs included in this anchor, in the order their leaf hashes were inserted into the Merkle tree. Verifiers rebuilding the tree MUST preserve this order — the runtime sorts by (finished_at ASC, receipt_id ASC) before leaf construction (spec §4.2).",
      ),
    leaf_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of receipts in this anchor (= `receipt_ids.length`). Duplicated so JSON Schema validators that don't correlate arrays still catch size anomalies, and so memo-parser fast paths don't need to count.",
      ),
    anchored_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the anchor record was produced. Not signed by the anchor itself (the anchor carries no batch-level signature) — verifiers that need timestamp attestation use the Solana tx at `tx_hash`.",
      ),
    tx_hash: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Solana signature (base58) of the transaction that published the Merkle root as a memo. Absent when the anchor was constructed offline (local-only). Present when a `ChainAnchorSubmitter` submitted successfully. The tx signer's pubkey equals `motebit_id`'s identity key.",
      ),
    network: z
      .string()
      .min(1)
      .optional()
      .describe(
        "CAIP-2 network identifier the anchor was submitted to (e.g., `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for Solana mainnet). Paired with `tx_hash` — absent when `tx_hash` is absent.",
      ),
  })
  // Forward-compat for future fields (e.g., a chain-agnostic `anchor`
  // nested object if we grow beyond Solana memos).
  .passthrough();

type _AnchorForward =
  ConsolidationAnchor extends z.infer<typeof ConsolidationAnchorSchema> ? true : never;
type _AnchorReverse =
  z.infer<typeof ConsolidationAnchorSchema> extends ConsolidationAnchor ? true : never;

export const _CONSOLIDATION_ANCHOR_TYPE_PARITY: {
  forward: _AnchorForward;
  reverse: _AnchorReverse;
} = {
  forward: true as _AnchorForward,
  reverse: true as _AnchorReverse,
};

export function buildConsolidationAnchorJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ConsolidationAnchorSchema, {
    name: "ConsolidationAnchor",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ConsolidationAnchor", raw, {
    $id: CONSOLIDATION_ANCHOR_SCHEMA_ID,
    title: "ConsolidationAnchor (v1)",
    description:
      "Merkle-batched commitment over signed ConsolidationReceipts. Optionally published onchain as a Solana memo — `motebit:anchor:v1:{merkle_root}:{leaf_count}` — signed by the motebit's identity key (which IS the Solana address). Not separately signed: cryptographic load is carried by (a) the signatures on the receipts it groups and (b) the Solana transaction signature when `tx_hash` is populated. See spec/consolidation-receipt-v1.md §4.",
  });
}

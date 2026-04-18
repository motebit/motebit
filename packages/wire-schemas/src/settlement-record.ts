/**
 * SettlementRecord — wire schema.
 *
 * Per-task settlement bookkeeping. When a relay settles an allocation,
 * it emits one of these recording how much went to the executor, how
 * much the platform took, the fee rate applied, and (when on-chain)
 * the x402 transaction details.
 *
 * This is the "got paid" artifact in the marketplace participation
 * loop. After the executor returns an ExecutionReceipt and the relay
 * confirms it, settlement happens — and the SettlementRecord is the
 * proof a worker uses to:
 *   - Reconcile their earnings against expected fees
 *   - Audit platform-fee transparency (`platform_fee_rate` is recorded
 *     per-settlement, not assumed from the relay's current default)
 *   - Trace on-chain payments via `x402_tx_hash` / `x402_network`
 *   - Confirm the relay didn't silently change fees mid-flight
 *
 * `receipt_hash` and `ledger_hash` bind the settlement to specific
 * upstream artifacts: the receipt that earned the payment and the
 * ledger entry that committed it. External implementers can verify
 * these hashes match their local copies, closing the bookkeeping loop
 * without trusting the relay's word.
 *
 * See spec/settlement-v1.md for the full specification.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SettlementRecord } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the settlement-record v1 wire format. */
export const SETTLEMENT_RECORD_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/settlement-record-v1.json";

const SettlementStatusSchema = z
  .enum(["completed", "partial", "refunded"])
  .describe(
    "Terminal state of the settlement. `completed` = full payment to executor. `partial` = some funds disbursed, remainder held (e.g. dispute window). `refunded` = settled funds returned to delegator (dispute resolved against executor or task voided).",
  );

export const SettlementRecordSchema = z
  .object({
    settlement_id: z
      .string()
      .min(1)
      .describe(
        "Stable settlement identifier (UUID). Unique per relay; lets external systems correlate this record with relay logs and on-chain events.",
      ),
    allocation_id: z
      .string()
      .min(1)
      .describe(
        "Identifier of the BudgetAllocation this settlement closes. The allocation locked funds when the task was submitted; this record finalizes them.",
      ),
    receipt_hash: z
      .string()
      .min(1)
      .describe(
        "SHA-256 hex digest of the canonical-JSON ExecutionReceipt that earned this settlement. Lets external workers verify the relay paid them for the receipt they actually emitted.",
      ),
    ledger_hash: z
      .string()
      .nullable()
      .describe(
        "Optional SHA-256 hex digest of the relay's accounting ledger entry committing this settlement. Null when the relay does not maintain an external-facing ledger; present when the relay publishes one for transparency.",
      ),
    amount_settled: z
      .number()
      .describe(
        "Amount paid to the executing agent in micro-units (1 USD = 1,000,000). After platform-fee deduction. Money math is integer micro-units throughout the protocol — no floating-point drift.",
      ),
    platform_fee: z
      .number()
      .describe(
        "Platform fee extracted by the relay in micro-units. Sums with `amount_settled` to the gross billed amount. Recorded so workers can independently verify the relay didn't take more than declared.",
      ),
    platform_fee_rate: z
      .number()
      .describe(
        "Fee rate applied to this settlement (e.g. `0.05` = 5%). Recorded per-settlement for auditability — a relay that changes its default fee mid-flight cannot retroactively rewrite past settlements without breaking this field's signed/hashed binding.",
      ),
    x402_tx_hash: z
      .string()
      .optional()
      .describe(
        "x402 payment transaction hash, when the settlement was paid on-chain. Absent for relay-custody settlements (off-chain ledger only). When present, lets workers verify the on-chain transfer matched the recorded `amount_settled`.",
      ),
    x402_network: z
      .string()
      .optional()
      .describe(
        "x402 network used for the payment, as a CAIP-2 chain identifier (e.g. `eip155:8453` for Base). Required-when `x402_tx_hash` is present so workers know which chain to query.",
      ),
    status: SettlementStatusSchema,
    settled_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the settlement was committed."),
  })
  // Unsigned envelope today — forward-compat per "unknown fields MUST be
  // ignored" (delegation-v1 §3.1, applied across unsigned envelopes).
  // NOTE (audit follow-up): the upstream TypeScript type lacks a
  // signature/suite, so a relay can retroactively rewrite settlement
  // history undetectably. That's a protocol-level gap (not a wire-schema
  // gap) and tracked separately — when @motebit/protocol adds signing
  // to SettlementRecord, this schema flips back to .strict().
  .passthrough();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredSettlement = z.infer<typeof SettlementRecordSchema>;

// SettlementRecord uses branded SettlementId + AllocationId; relax to
// strings for structural parity (the wire is just a string, brands are
// TS-only guards).
type BrandedToString<T> = {
  [K in keyof T]: T[K] extends string & { readonly __brand: unknown } ? string : T[K];
};

type _ForwardCheck = BrandedToString<SettlementRecord> extends InferredSettlement ? true : never;
type _ReverseCheck = InferredSettlement extends BrandedToString<SettlementRecord> ? true : never;

export const _SETTLEMENT_RECORD_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildSettlementRecordJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SettlementRecordSchema, {
    name: "SettlementRecord",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SettlementRecord", raw, {
    $id: SETTLEMENT_RECORD_SCHEMA_ID,
    title: "SettlementRecord (v1)",
    description:
      "Per-task settlement bookkeeping artifact. Records amount paid to the executor, platform fee taken, fee rate applied, and (when on-chain) x402 transaction details. Lets workers reconcile earnings and audit fee transparency. See spec/settlement-v1.md.",
  });
}

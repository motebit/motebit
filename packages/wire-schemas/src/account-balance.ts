/**
 * AccountBalanceResult — wire schema.
 *
 * The relay's response shape for `GET /api/v1/agents/{motebitId}/balance`
 * — the market-v1 §2 virtual-account state projected across the HTTP
 * boundary. This is the one boundary where micro-units convert to
 * decimal dollars (§2.3): every monetary field is decimal USD, and only
 * the producer converts.
 *
 * Money-shape rules embedded in the type:
 *   - All fields required — the reference relay emits the complete
 *     shape on both the account-exists and no-account-yet branches, so
 *     absence is never meaningful on this envelope.
 *   - `transactions[].type` is a free string, NOT an enum: §2.2's
 *     transaction vocabulary evolves additively, and a reader that
 *     hard-fails on an unknown type breaks forward compatibility.
 *   - `sweep_threshold` / `settlement_address` / `reference_id` /
 *     `description` are `T | null`, never absent — null carries the
 *     "unset" signal explicitly.
 *
 * See spec/market-v1.md §2.6 / §2.7 for the full specification.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AccountBalanceResult, AccountBalanceTransaction } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id` for the account-balance-result v1 wire format. */
export const ACCOUNT_BALANCE_RESULT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/account-balance-result-v1.json";

export const AccountBalanceTransactionSchema = z
  .object({
    transaction_id: z.string().min(1).describe("Unique transaction identifier."),
    motebit_id: z.string().min(1).describe("Account owner's MotebitId."),
    type: z
      .string()
      .min(1)
      .describe(
        "One of the market-v1 §2.2 transaction types (deposit, withdrawal, allocation_hold, allocation_release, settlement_debit, settlement_credit, fee, waiver). Readers MUST tolerate unknown values — the vocabulary evolves additively.",
      ),
    amount: z.number().describe("Signed decimal USD. Credits positive, debits negative."),
    balance_after: z.number().describe("Decimal USD balance after this transaction was applied."),
    reference_id: z
      .string()
      .nullable()
      .describe("External correlation id (deposit tx hash, allocation id, …); null when none."),
    description: z.string().nullable().describe("Human-readable annotation; null when none."),
    created_at: z.number().describe("Epoch milliseconds."),
  })
  // Unsigned envelope — forward-compat per "unknown fields MUST be ignored"
  // (delegation-v1 §3.1, applied across unsigned envelopes).
  .passthrough();

export const AccountBalanceResultSchema = z
  .object({
    motebit_id: z.string().min(1).describe("Account owner's MotebitId."),
    balance: z.number().describe("Available balance, decimal USD."),
    currency: z.string().min(1).describe('ISO 4217 or token symbol. Default "USD".'),
    pending_withdrawals: z
      .number()
      .describe("Decimal USD locked in not-yet-fired withdrawal requests."),
    pending_allocations: z
      .number()
      .describe("Decimal USD locked in active budget allocations (market-v1 §4)."),
    dispute_window_hold: z
      .number()
      .describe("Decimal USD held back by the dispute window (settlement-v1)."),
    available_for_withdrawal: z
      .number()
      .describe("Decimal USD the relay would actually release on requestWithdrawal now."),
    sweep_threshold: z
      .number()
      .nullable()
      .describe("Operator sweep threshold in decimal USD; null when unset."),
    settlement_address: z
      .string()
      .nullable()
      .describe("Agent's declared settlement address; null when undeclared."),
    transactions: z
      .array(AccountBalanceTransactionSchema)
      .describe("Most recent transactions, newest first; the reference relay caps at 50."),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredTransaction = z.infer<typeof AccountBalanceTransactionSchema>;
type _TxForwardCheck = ParityForward<AccountBalanceTransaction, InferredTransaction>;
type _TxReverseCheck = ParityReverse<AccountBalanceTransaction, InferredTransaction>;

export const _ACCOUNT_BALANCE_TRANSACTION_TYPE_PARITY: {
  forward: _TxForwardCheck;
  reverse: _TxReverseCheck;
} = {
  forward: true,
  reverse: true,
};

type InferredResult = z.infer<typeof AccountBalanceResultSchema>;
type _ForwardCheck = ParityForward<AccountBalanceResult, InferredResult>;
type _ReverseCheck = ParityReverse<AccountBalanceResult, InferredResult>;

export const _ACCOUNT_BALANCE_RESULT_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true,
  reverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildAccountBalanceResultJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AccountBalanceResultSchema, {
    name: "AccountBalanceResult",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AccountBalanceResult", raw, {
    $id: ACCOUNT_BALANCE_RESULT_SCHEMA_ID,
    title: "AccountBalanceResult (v1)",
    description:
      "Relay's response shape for GET /api/v1/agents/{motebitId}/balance — the market-v1 §2 virtual-account state in decimal USD, with the §2.7 transaction audit rows. See spec/market-v1.md §2.6.",
  });
}

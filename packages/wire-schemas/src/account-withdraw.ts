/**
 * Account withdrawal wire schemas — request and response of
 * `POST /api/v1/agents/{motebitId}/withdraw` (market-v1 §2.8/§2.9).
 *
 * The money-out boundary: `AccountWithdrawRequest` is client-produced,
 * `AccountWithdrawResult` is the relay's response (validated by
 * `@motebit/relay-client`). Amounts are decimal USD — the §2.3
 * conversion happens only at the producer.
 *
 * Shape rules embedded in the schemas:
 *   - `status` is a free string, NOT an enum: the withdrawal lifecycle
 *     vocabulary can gain states additively, and a reader that hard-
 *     fails on an unknown status breaks forward compatibility.
 *   - settled-only fields (`payout_reference`, `completed_at`,
 *     `failure_reason`, `relay_signature`, `relay_public_key`) are
 *     `T | null`, never absent — null carries the "not yet" signal.
 *   - `idempotent` is optional on the result: present only on a replay.
 *
 * See spec/market-v1.md §2.8 / §2.9 for the threat model + full tables.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  AccountWithdrawRequest,
  AccountWithdrawResult,
  AccountWithdrawalRecord,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id` for the account-withdraw-request v1 wire format. */
export const ACCOUNT_WITHDRAW_REQUEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/account-withdraw-request-v1.json";

/** Stable `$id` for the account-withdraw-result v1 wire format. */
export const ACCOUNT_WITHDRAW_RESULT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/account-withdraw-result-v1.json";

export const AccountWithdrawRequestSchema = z
  .object({
    amount: z.number().positive().describe("Positive decimal USD to withdraw."),
    destination: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Solana base58 (Path 0) or EVM 0x-hex (Path 1) payout address; omitted ⇒ manual/pending.",
      ),
    idempotency_key: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional body-level idempotency key; when absent the required Idempotency-Key header is used.",
      ),
  })
  .passthrough();

export const AccountWithdrawalRecordSchema = z
  .object({
    withdrawal_id: z.string().min(1).describe("Unique withdrawal identifier."),
    motebit_id: z.string().min(1).describe("Account owner's MotebitId."),
    amount: z.number().describe("Decimal USD."),
    currency: z.string().min(1).describe("ISO 4217 or token symbol."),
    destination: z
      .string()
      .min(1)
      .describe('Payout address, external ref, or "pending" for manual resolution.'),
    status: z
      .string()
      .min(1)
      .describe(
        "Withdrawal lifecycle state (pending | processing | completed | failed | cancelled). Readers MUST tolerate unknown values — the vocabulary evolves additively.",
      ),
    payout_reference: z
      .string()
      .nullable()
      .describe("External payout id (tx hash, transfer id); null until settled."),
    requested_at: z.number().describe("Epoch milliseconds of the request."),
    completed_at: z
      .number()
      .nullable()
      .describe("Epoch milliseconds of settlement; null while unsettled."),
    failure_reason: z.string().nullable().describe("Populated when status is failed; else null."),
    relay_signature: z
      .string()
      .nullable()
      .describe(
        "Ed25519 signature over the completed withdrawal for offline verify; null until settled.",
      ),
    relay_public_key: z
      .string()
      .nullable()
      .describe("Hex relay public key for independent verification; null until settled."),
  })
  .passthrough();

export const AccountWithdrawResultSchema = z
  .object({
    motebit_id: z.string().min(1).describe("Account owner's MotebitId."),
    withdrawal: AccountWithdrawalRecordSchema.describe("The withdrawal lifecycle record."),
    idempotent: z
      .boolean()
      .optional()
      .describe("Present and true when the idempotency key matched a prior request."),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredRequest = z.infer<typeof AccountWithdrawRequestSchema>;
type _ReqForwardCheck = ParityForward<AccountWithdrawRequest, InferredRequest>;
type _ReqReverseCheck = ParityReverse<AccountWithdrawRequest, InferredRequest>;

export const _ACCOUNT_WITHDRAW_REQUEST_TYPE_PARITY: {
  forward: _ReqForwardCheck;
  reverse: _ReqReverseCheck;
} = {
  forward: true,
  reverse: true,
};

type InferredRecord = z.infer<typeof AccountWithdrawalRecordSchema>;
type _RecForwardCheck = ParityForward<AccountWithdrawalRecord, InferredRecord>;
type _RecReverseCheck = ParityReverse<AccountWithdrawalRecord, InferredRecord>;

export const _ACCOUNT_WITHDRAWAL_RECORD_TYPE_PARITY: {
  forward: _RecForwardCheck;
  reverse: _RecReverseCheck;
} = {
  forward: true,
  reverse: true,
};

type InferredResult = z.infer<typeof AccountWithdrawResultSchema>;
type _ForwardCheck = ParityForward<AccountWithdrawResult, InferredResult>;
type _ReverseCheck = ParityReverse<AccountWithdrawResult, InferredResult>;

export const _ACCOUNT_WITHDRAW_RESULT_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true,
  reverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitters
// ---------------------------------------------------------------------------

export function buildAccountWithdrawRequestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AccountWithdrawRequestSchema, {
    name: "AccountWithdrawRequest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AccountWithdrawRequest", raw, {
    $id: ACCOUNT_WITHDRAW_REQUEST_SCHEMA_ID,
    title: "AccountWithdrawRequest (v1)",
    description:
      "Request body for POST /api/v1/agents/{motebitId}/withdraw — the money-out debit. Idempotency-Key header required; amount positive decimal USD. See spec/market-v1.md §2.8.",
  });
}

export function buildAccountWithdrawResultJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AccountWithdrawResultSchema, {
    name: "AccountWithdrawResult",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AccountWithdrawResult", raw, {
    $id: ACCOUNT_WITHDRAW_RESULT_SCHEMA_ID,
    title: "AccountWithdrawResult (v1)",
    description:
      "Response of POST /api/v1/agents/{motebitId}/withdraw — the withdrawal lifecycle record in decimal USD. Non-terminal status is the fail-safe; finality is observed via status + payout_reference. See spec/market-v1.md §2.9.",
  });
}

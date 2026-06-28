/**
 * Settlement invoice — wire schemas (settlement-invoice@1.0).
 *
 * The settlement-layer members of the receipt family: a verifiable bill a customer
 * re-derives offline. A `CostAttestation` is an issuer-signed declaration of the
 * cost of ONE execution (integer nano-USD against a named rate table), referencing
 * an `ExecutionReceipt` by id + digest. An `Invoice` is an issuer-signed demand for
 * payment whose passthrough is bounded by the summed `CostAttestation` costs. Both
 * are offline-verifiable like any motebit artifact — an external verifier validates
 * a bill with only these JSON Schemas and an Ed25519 library, no relay contact.
 *
 * motebit owns the FORMAT; the issuer runs the rails. There is no charge/balance/
 * ledger primitive. See `spec/settlement-invoice-v1.md`.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CostAttestationV1, InvoiceV1 } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id`s for the settlement-invoice v1 wire formats. External tools pin to these. */
export const COST_ATTESTATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/cost-attestation-v1.json";
export const INVOICE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/invoice-v1.json";

const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A content-addressed reference to a signed artifact (the shared `DigestRef` shape). */
const DigestRefSchema = z
  .object({
    algorithm: z
      .literal("sha-256")
      .describe("Hash algorithm — the role, never baked into a field name."),
    value: z
      .string()
      .regex(HEX_SHA256_PATTERN)
      .describe("Lowercase hex SHA-256 of the JCS canonicalization of the full signed artifact."),
  })
  .strict();

export const CostAttestationV1Schema = z
  .object({
    schema: z
      .literal("motebit.cost-attestation.v1")
      .describe("This artifact's type tag (in-body domain separation)."),
    attestation_id: z.string().min(1).describe("UUIDv7. A supersession is a NEW id (spec §3.3)."),
    receipt_id: z
      .string()
      .min(1)
      .describe("The ExecutionReceipt.task_id this prices (human/index handle)."),
    receipt_digest: DigestRefSchema.describe(
      "`executionReceiptDigest(receipt)` over the full signed ExecutionReceipt — binds the cost to the exact receipt.",
    ),
    cost_nanos: z
      .number()
      .int()
      .positive()
      .describe("The cost, in integer nano-USD (1 USD = 1e9 nano). Positive."),
    rate_table_id: z
      .string()
      .min(1)
      .describe("The versioned rate table the cost was computed under (e.g. `agency-rates-v1`)."),
    covers: z
      .string()
      .describe(
        "Issuer-owned label for what the cost accounts for (rate-table basis). Opaque to motebit.",
      ),
    issuer_id: z.string().min(1).describe("The issuer's motebit_id / did."),
    issuer_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .optional()
      .describe(
        "Issuer Ed25519 public key, hex (64 lowercase). OPTIONAL; verify against the REGISTERED key.",
      ),
    attested_at: z
      .number()
      .describe(
        "ms epoch. MUST be >= the receipt's `completed_at` — a cost can't be attested before the work finished.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe("Cryptosuite: JCS (RFC 8785), Ed25519, base64url signature, hex public keys."),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url Ed25519 over `canonicalJson(body minus signature)`. Verify with the registered issuer key.",
      ),
  })
  .strict();

const InvoiceLineItemSchema = z
  .object({
    receipt_id: z.string().min(1).describe("The billed ExecutionReceipt.task_id."),
    receipt_digest: DigestRefSchema.describe(
      "`executionReceiptDigest(receipt)` — binds the line to the exact receipt.",
    ),
    cost_nanos: z
      .number()
      .int()
      .nonnegative()
      .describe("The passthrough cost for this line, nano-USD. Non-negative."),
    cost_attestation_digest: DigestRefSchema.describe(
      "`costAttestationDigest(att)` — binds the line to the CostAttestation that priced it.",
    ),
  })
  .strict();

export const InvoiceV1Schema = z
  .object({
    schema: z.literal("motebit.invoice.v1").describe("This artifact's type tag."),
    invoice_id: z.string().min(1).describe("UUIDv7. The bill's idempotency anchor."),
    issuer_id: z.string().min(1).describe("The issuer's motebit_id / did."),
    issuer_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .optional()
      .describe("Issuer Ed25519 public key, hex. OPTIONAL; verify against the registered key."),
    customer_ref: z.string().describe("Opaque issuer-owned addressing token. NOT PII."),
    currency: z.literal("USD").describe("Bill currency. Amounts are minor units (cents) of this."),
    period_start: z.number().describe("ms epoch, inclusive."),
    period_end: z.number().describe("ms epoch, exclusive."),
    line_items: z
      .array(InvoiceLineItemSchema)
      .describe("One per billed receipt; each binds to a receipt + its cost attestation."),
    flat_fee_minor: z
      .number()
      .int()
      .nonnegative()
      .describe("The per-outcome flat fee, minor units (cents)."),
    passthrough_cost_minor: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Passthrough compute, minor units. Bounded by `<= floor(Σ cost_nanos / 1e7)` (spec §4.2.3).",
      ),
    total_minor: z
      .number()
      .int()
      .nonnegative()
      .describe("`flat_fee_minor + passthrough_cost_minor`. The verifier recomputes."),
    rate_table_id: z.string().min(1).describe("The rate table the passthrough was costed under."),
    issued_at: z.number().describe("ms epoch."),
    suite: z.literal("motebit-jcs-ed25519-b64-v1").describe("Cryptosuite identifier."),
    signature: z
      .string()
      .min(1)
      .describe("Base64url Ed25519 over `canonicalJson(body minus signature)`."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity (live — `tsc` fails on protocol↔schema drift; never cast the literal)
// ---------------------------------------------------------------------------

type InferredCostAttestation = z.infer<typeof CostAttestationV1Schema>;
type InferredInvoice = z.infer<typeof InvoiceV1Schema>;

type _CostAttestationForward = ParityForward<CostAttestationV1, InferredCostAttestation>;
type _CostAttestationReverse = ParityReverse<CostAttestationV1, InferredCostAttestation>;
type _InvoiceForward = ParityForward<InvoiceV1, InferredInvoice>;
type _InvoiceReverse = ParityReverse<InvoiceV1, InferredInvoice>;

export const _COST_ATTESTATION_TYPE_PARITY: {
  forward: _CostAttestationForward;
  reverse: _CostAttestationReverse;
} = {
  forward: true,
  reverse: true,
};

export const _INVOICE_TYPE_PARITY: {
  forward: _InvoiceForward;
  reverse: _InvoiceReverse;
} = {
  forward: true,
  reverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitters
// ---------------------------------------------------------------------------

export function buildCostAttestationJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(CostAttestationV1Schema, {
    name: "CostAttestationV1",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("CostAttestationV1", raw, {
    $id: COST_ATTESTATION_SCHEMA_ID,
    title: "CostAttestationV1 (v1)",
    description:
      "An issuer-signed declaration of the cost of one execution, in integer nano-USD against a named rate table, referencing an ExecutionReceipt by id + digest. Separate from the receipt by design (cost is a declaration, not the receipt's proof); supersedable via new attestation_id. Canonicalization: JCS (RFC 8785). Signature: Ed25519 over canonicalJson(body minus signature), base64url. See spec/settlement-invoice-v1.md §3.",
  });
}

export function buildInvoiceJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(InvoiceV1Schema, {
    name: "InvoiceV1",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("InvoiceV1", raw, {
    $id: INVOICE_SCHEMA_ID,
    title: "InvoiceV1 (v1)",
    description:
      "An issuer-signed demand for payment: a flat fee plus passthrough compute bounded by the summed CostAttestation costs (passthrough_cost_minor <= floor(Σ cost_nanos / 1e7)), re-derivable and refusable offline. Amounts in minor units (cents); cost references carry nano-USD. Idempotency is the issuer's stateful ledger, never the artifact. See spec/settlement-invoice-v1.md §4.",
  });
}

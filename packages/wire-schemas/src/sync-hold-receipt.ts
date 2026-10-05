/**
 * SyncHoldReceipt wire schema — the relay's signed record of which sync
 * events it holds (spec/sync-hold-receipt-v1.md).
 *
 * Receipt-family (subject = signer): the relay signs a record of its own act
 * of holding. The zod source here is BSL; the generated JSON Schema is
 * committed Apache-2.0 under `spec/schemas/` (wire-schemas CLAUDE.md).
 *
 * Strictness discipline: every object is `.strict()` — an unknown field is a
 * different wire format, not an extension point. The suite is pinned as a
 * literal (Rule 6).
 */

import { z } from "zod";

import type { SyncHeldEvent, SyncHoldPage, SyncHoldReceipt } from "@motebit/protocol";

import { assembleJsonSchemaFor, toDraft7 } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

export const SYNC_HOLD_RECEIPT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/sync-hold-receipt-v1.json";

/** One event the relay holds, as it holds it. */
export const SyncHeldEventSchema = z
  .object({
    event_id: z.string().min(1).describe("The held event's id."),
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe(
        "Lowercase hex SHA-256 of the JCS-canonical entry exactly as the relay serves it from storage (without `seq`).",
      ),
    redacted: z.boolean().describe("True when the held entry is in redacted form."),
    seq: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The event's relay ingest sequence. Present on pull-page receipts only."),
  })
  .strict();

/** The seq-cursor range a pull-page receipt covers. */
export const SyncHoldPageSchema = z
  .object({
    after_seq: z.number().int().nonnegative().describe("The cursor the request asked from."),
    next_seq: z
      .number()
      .int()
      .nonnegative()
      .describe("The largest seq in the page, or `after_seq` when empty."),
    has_more: z.boolean().describe("Whether more events follow `next_seq`."),
    latest_seq: z
      .number()
      .int()
      .nonnegative()
      .describe("The largest seq the relay has ever assigned the identity."),
  })
  .strict();

export const SyncHoldReceiptSchema = z
  .object({
    spec: z
      .literal("motebit/sync-hold-receipt@1.0")
      .describe("Wire-format version discriminator (domain separation)."),
    relay_motebit_id: z
      .string()
      .min(1)
      .describe("The relay's motebit id — the holder and the signer (subject = signer)."),
    relay_public_key: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("The relay's Ed25519 public key, lowercase hex."),
    motebit_id: z.string().min(1).describe("The identity whose events are held."),
    nonce: z
      .string()
      .min(1)
      .describe(
        "The client-supplied request nonce, echoed exactly. Always present: a receipt is issued only to a request carrying a usable nonce.",
      ),
    issued_at: z.number().int().nonnegative().describe("Signing time, epoch milliseconds."),
    events: z
      .array(SyncHeldEventSchema)
      .describe("The events the relay holds among those the request concerned, in request order."),
    page: SyncHoldPageSchema.optional().describe(
      "Present on pull-page receipts only: the seq range the page covers.",
    ),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe("Cryptosuite (pinned literal — new suites arrive as new receipt versions)."),
    signature: z
      .string()
      .min(1)
      .describe("Ed25519 over the JCS-canonical receipt minus this field, base64url."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — zod inference must match the @motebit/protocol declaration
// ---------------------------------------------------------------------------

type InferredReceipt = z.infer<typeof SyncHoldReceiptSchema>;
type InferredEvent = z.infer<typeof SyncHeldEventSchema>;
type InferredPage = z.infer<typeof SyncHoldPageSchema>;

type _ForwardCheck = ParityForward<SyncHoldReceipt, InferredReceipt>;
type _ReverseCheck = ParityReverse<SyncHoldReceipt, InferredReceipt>;
type _EventForward = ParityForward<SyncHeldEvent, InferredEvent>;
type _EventReverse = ParityReverse<SyncHeldEvent, InferredEvent>;
type _PageForward = ParityForward<SyncHoldPage, InferredPage>;
type _PageReverse = ParityReverse<SyncHoldPage, InferredPage>;

// If the zod schema diverges from the TypeScript declaration these aliases
// resolve to `never` and `tsc --noEmit` fails at this line.
export const _SYNC_HOLD_RECEIPT_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
  eventForward: _EventForward;
  eventReverse: _EventReverse;
  pageForward: _PageForward;
  pageReverse: _PageReverse;
} = {
  forward: true,
  reverse: true,
  eventForward: true,
  eventReverse: true,
  pageForward: true,
  pageReverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

/**
 * Build the JSON Schema (draft-07) object for SyncHoldReceipt. Pure — called
 * from the build-schemas script and from the drift test.
 */
export function buildSyncHoldReceiptJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(SyncHoldReceiptSchema);
  return assembleJsonSchemaFor(raw, {
    $id: SYNC_HOLD_RECEIPT_SCHEMA_ID,
    title: "SyncHoldReceipt (v1)",
    description:
      "Signed sync hold receipt (subject = signer — receipt-family): the relay's own record of which event ids it stores for an identity, with a digest of the held bytes and a redaction flag per event, the client's request nonce echoed, and — on a pull page — the seq range the page covers. Verified by verifySyncHoldReceipt in @motebit/crypto against the caller's pinned relay key. Spec: spec/sync-hold-receipt-v1.md.",
  });
}

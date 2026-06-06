/**
 * Verify a pasted/standalone `ExecutionReceipt` document and project it into an
 * honest, display-ready view model — the brain behind a public receipt verifier
 * (e.g. receipt.computer): paste a receipt, learn what it actually proves.
 *
 * The model's whole point is to keep two facts separate, the way the rest of the
 * stack now does (crypto `keySource`, render-engine `bindingStatusFor`):
 *
 *   - INTEGRITY — "the bytes were signed by *some* key and nothing was tampered."
 *     Always checkable offline from the receipt alone.
 *   - BINDING   — "that key belongs to the claimed `motebit_id`." Established only
 *     when the verifying key came from a trusted external source, never from the
 *     receipt's own embedded `public_key`.
 *
 * Verified against the receipt's embedded key alone (offline, no options), a
 * successful check is `integrity-only`: it never claims identity binding. Supply
 * `options.identity` to reach `"pinned"` (the signing key is time-valid in the
 * motebit's own succession chain), and additionally `options.anchor` to reach
 * `"anchored"` (that binding is in the relay's transparency log AND the log root
 * is independently confirmed on-chain). Callers branch on `binding`, not
 * `integrity`, before rendering "from <motebit>".
 *
 * Browser-safe; composes `@motebit/crypto` verifiers + an injectable on-chain
 * lookup — no new crypto here.
 *
 * Doctrine: `docs/doctrine/self-attesting-system.md`, `docs/doctrine/operator-transparency.md`.
 */

import type { ExecutionReceipt } from "@motebit/protocol";
import {
  verifyReceipt,
  verifyKeyBindingAtTime,
  verifyIdentityBindingAnchored,
  verifySovereignBinding,
  type IdentityLogInclusionProof,
  type MotebitIdentityFile,
} from "@motebit/crypto";
import { lookupIdentityLogAnchor, type IdentityAnchorLookupOptions } from "./identity-anchor.js";
import { lookupKeyRevocation, type KeyRevocationLookupOptions } from "./key-revocation.js";

/**
 * Identity-binding status — a ladder of increasing trust-minimization, per
 * `docs/doctrine/identity-binding-verification.md`. `"unverified"` (signature
 * failed) < `"integrity-only"` (signed, but checked against the receipt's own
 * embedded key — not bound) < `"pinned"` (the signing key is time-valid for an
 * identity file the caller supplied; sovereign chain verified, no operator
 * anchor) < `"anchored"` (the motebit's key is committed in the relay's
 * identity-transparency log AND that log root is independently confirmed on-chain
 * — operator non-equivocation) < `"sovereign"` (the `motebit_id` IS the commitment
 * to the genesis key, verified offline from the identity file alone — no operator,
 * no anchor, no chain; the strongest root).
 *
 * `"revoked"` is off the ladder — a poison verdict. The signature may be valid,
 * but the signing key was revoked on-chain at/before the receipt's timestamp, so
 * the producer claim must NOT be trusted. It overrides every other status.
 */
export type ReceiptBindingStatus =
  | "revoked"
  | "sovereign"
  | "anchored"
  | "pinned"
  | "integrity-only"
  | "unverified";

export type ReceiptDocumentFailureReason =
  | "malformed_json"
  | "not_a_receipt"
  | "missing_public_key"
  | "signature_invalid"
  | "delegation_failed"
  | "unknown";

/** Honest, recursive view model for a verified (or rejected) receipt document. */
export interface ReceiptDocumentVerification {
  /**
   * True iff the signature verified (and every delegation verified) — INTEGRITY.
   * A `true` here does NOT mean the key belongs to `motebitId`; read `binding`.
   */
  readonly integrity: boolean;
  /**
   * Identity-binding status (the ladder). `"anchored"` when the binding is in the
   * relay's transparency log AND that root is confirmed on-chain; `"pinned"` when
   * the signing key is time-valid for a caller-supplied identity file;
   * `"integrity-only"` when only the signature is verified against the receipt's
   * own embedded key; `"unverified"` when the signature did not verify. Surfaces
   * MUST NOT render "from <motebit>" below `"pinned"`.
   */
  readonly binding: ReceiptBindingStatus;
  /** The Solana tx that anchored the log root, when `binding === "anchored"`. */
  readonly anchorTxHash?: string;
  /** When `binding === "revoked"`: the on-chain revocation timestamp (ms). */
  readonly revokedAt?: number;
  /** `did:key:z…` derived from the signing key when integrity holds. */
  readonly signerDid?: string;
  /** The producing `motebit_id` as carried in the receipt body — a claim, not proof. */
  readonly motebitId?: string;
  readonly taskId?: string;
  /** Per-delegation results, recursive — mirrors the delegation chain. */
  readonly delegations?: ReceiptDocumentVerification[];
  /** Typed failure reason when `integrity` is false. */
  readonly reason?: ReceiptDocumentFailureReason;
  /** Free-form detail (e.g. underlying error message). */
  readonly detail?: string;
}

/**
 * Minimal structural guard for user-pasted input. We verify at the boundary
 * (untrusted text) before handing to crypto — a non-receipt object must surface
 * as a typed `not_a_receipt`, never an opaque downstream throw.
 */
function isExecutionReceiptShape(value: unknown): value is ExecutionReceipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["motebit_id"] === "string" &&
    typeof r["task_id"] === "string" &&
    typeof r["signature"] === "string" &&
    typeof r["suite"] === "string"
  );
}

type CryptoReceiptResult = Awaited<ReturnType<typeof verifyReceipt>>;

function toView(result: CryptoReceiptResult): ReceiptDocumentVerification {
  const errs = result.errors ?? [];
  const base: {
    integrity: boolean;
    binding: ReceiptBindingStatus;
    signerDid?: string;
    motebitId?: string;
    taskId?: string;
    delegations?: ReceiptDocumentVerification[];
    reason?: ReceiptDocumentFailureReason;
    detail?: string;
  } = {
    integrity: result.valid,
    // `verifyReceipt` checks the signature against the receipt's own embedded
    // key, so on its own a valid check is integrity-only. `verifyReceiptDocument`
    // upgrades the root to `"pinned"` when a matching identity file is supplied.
    binding: result.valid ? "integrity-only" : "unverified",
  };
  if (result.signer !== undefined) base.signerDid = result.signer;
  if (result.receipt) {
    base.motebitId = String(result.receipt.motebit_id);
    base.taskId = result.receipt.task_id;
  }
  if (result.delegations && result.delegations.length > 0) {
    base.delegations = result.delegations.map(toView);
  }
  if (!result.valid) {
    if (errs.some((e) => e.message.includes("No embedded public_key"))) {
      base.reason = "missing_public_key";
    } else if (errs.some((e) => e.path === "delegation_receipts")) {
      base.reason = "delegation_failed";
    } else if (errs.length > 0) {
      base.reason = "signature_invalid";
    } else {
      base.reason = "unknown";
    }
    const detail = errs[0]?.message;
    if (detail !== undefined) base.detail = detail;
  }
  return base;
}

/**
 * Material for the `anchored` rung: the relay's identity-transparency inclusion
 * proof plus the out-of-band pinned relay Solana address to cross-check it
 * against. Both come from the relay's `/identity/:motebitId` bundle EXCEPT
 * `relayAnchorAddress`, which MUST be pinned independently (not taken from the
 * bundle) — that's the trust root that makes the on-chain check non-circular.
 */
export interface ReceiptAnchorOptions {
  /** The relay bundle's `anchored.proof` — its `anchoredRoot` is checked on-chain. */
  readonly proof: IdentityLogInclusionProof;
  /** Pinned relay Solana address (out-of-band trust root). */
  readonly relayAnchorAddress: string;
  /** Solana RPC / fetch injection for the on-chain lookup. */
  readonly lookup?: IdentityAnchorLookupOptions;
}

export interface VerifyReceiptDocumentOptions {
  /**
   * The producing motebit's identity file (its self-signed succession material).
   * When supplied, and the receipt's signing key is time-valid for it (and the
   * `motebit_id` matches), the result's root upgrades to `binding: "pinned"` —
   * verified against material the caller supplied. The `anchored` / `sovereign`
   * rungs layer operator non-equivocation on top; see
   * `docs/doctrine/identity-binding-verification.md`.
   */
  readonly identity?: MotebitIdentityFile;
  /**
   * Anchor material. Requires `identity` too — `anchored` is `pinned` PLUS an
   * on-chain-confirmed transparency-log inclusion. When the inclusion proof and
   * the on-chain root cross-check both pass, the root upgrades to
   * `binding: "anchored"`; otherwise it degrades honestly to `pinned` /
   * `integrity-only`.
   */
  readonly anchor?: ReceiptAnchorOptions;
  /**
   * On-chain revocation check. The signing key is scanned for a revocation memo
   * at the relay's pinned address (read from the neutral chain, NOT the relay's
   * word — the relay could hide a revocation that protects it). If the key was
   * revoked at/before the receipt's `completed_at`, `binding` is `"revoked"`,
   * overriding every other rung. Requires no `identity` — a revoked key poisons
   * even the integrity-only claim.
   */
  readonly revocation?: {
    readonly relayAnchorAddress: string;
    readonly lookup?: KeyRevocationLookupOptions;
  };
}

/**
 * Promote the root to `"pinned"` iff the supplied identity file is for this
 * receipt's motebit and its succession chain makes the signing key valid at the
 * receipt's `completed_at`. Returns `null` (no promotion) otherwise. The chain is
 * verified inside `verifyKeyBindingAtTime`; this is the sovereign-root half of
 * binding (no operator anchor).
 */
async function pinnedBinding(
  receipt: ExecutionReceipt,
  identity: MotebitIdentityFile,
): Promise<"pinned" | null> {
  if (typeof receipt.public_key !== "string") return null;
  if (String(identity.motebit_id) !== String(receipt.motebit_id)) return null;
  const r = await verifyKeyBindingAtTime(identity, receipt.public_key, receipt.completed_at);
  return r.bound ? "pinned" : null;
}

/**
 * Promote to `"sovereign"` iff the signing key binds AND the identity's
 * `motebit_id` is the sovereign commitment to its genesis key. This is the
 * strongest rung and the only fully-offline one — `verifyKeyBindingAtTime`
 * computes both the key's window and the id↔genesis commitment from the identity
 * file alone, so no anchor, no relay, no chain is consulted. Returns `null`
 * (no promotion) when the motebit wasn't minted sovereignly.
 */
async function sovereignBinding(
  receipt: ExecutionReceipt,
  identity: MotebitIdentityFile,
): Promise<"sovereign" | null> {
  if (typeof receipt.public_key !== "string") return null;
  if (String(identity.motebit_id) !== String(receipt.motebit_id)) return null;
  const r = await verifyKeyBindingAtTime(identity, receipt.public_key, receipt.completed_at);
  return r.bound === true && r.sovereign === true ? "sovereign" : null;
}

/**
 * Promote to `"anchored"` iff (a) the signing key is sovereign-bound to the
 * supplied identity at `completed_at` AND included under `anchor.proof`'s root
 * (`verifyIdentityBindingAnchored`), AND (b) that root is independently confirmed
 * on-chain at the pinned relay address (`lookupIdentityLogAnchor`). The second
 * check is what makes it `anchored` rather than `pinned` — without it a relay
 * could assert any root. Returns the anchoring `txHash` for provenance, or `null`
 * (no promotion) on any failure.
 */
async function anchoredBinding(
  receipt: ExecutionReceipt,
  identity: MotebitIdentityFile,
  anchor: ReceiptAnchorOptions,
): Promise<{ txHash: string } | null> {
  if (typeof receipt.public_key !== "string") return null;
  if (String(identity.motebit_id) !== String(receipt.motebit_id)) return null;
  const bound = await verifyIdentityBindingAnchored(
    identity,
    receipt.public_key,
    receipt.completed_at,
    anchor.proof,
  );
  if (!bound.bound) return null;
  const onchain = await lookupIdentityLogAnchor(
    anchor.relayAnchorAddress,
    anchor.proof.anchoredRoot,
    anchor.lookup,
  );
  return onchain.ok ? { txHash: onchain.txHash } : null;
}

/**
 * Verify a pasted receipt document (JSON text) entirely offline. Returns a typed
 * view model; never throws on bad input or a crypto failure — only `JSON.parse`
 * and shape errors map to `malformed_json` / `not_a_receipt`. Pass
 * `options.identity` to attempt the `"pinned"` binding rung.
 */
export async function verifyReceiptDocument(
  jsonText: string,
  options?: VerifyReceiptDocumentOptions,
): Promise<ReceiptDocumentVerification> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      integrity: false,
      binding: "unverified",
      reason: "malformed_json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!isExecutionReceiptShape(parsed)) {
    return {
      integrity: false,
      binding: "unverified",
      reason: "not_a_receipt",
      detail: "input is not an ExecutionReceipt (missing motebit_id / task_id / signature / suite)",
    };
  }
  const view = toView(await verifyReceipt(parsed));
  if (view.integrity) {
    // Revocation is a poison verdict — check it first, independent of `identity`.
    // A key revoked on-chain at/before completed_at must not bind, no matter what
    // the succession chain says.
    if (options?.revocation && typeof parsed.public_key === "string") {
      const rev = await lookupKeyRevocation(
        options.revocation.relayAnchorAddress,
        parsed.public_key,
        options.revocation.lookup,
      );
      if (rev.status === "revoked" && rev.revokedAt <= parsed.completed_at) {
        return { ...view, binding: "revoked", revokedAt: rev.revokedAt };
      }
    }
    // Receipt-alone sovereign — the strongest root, fully offline, needs NO
    // identity file or relay: the `motebit_id` is itself the commitment to the
    // receipt's signing key. Matches @motebit/verifier's offline `sovereign`
    // rung (same `verifySovereignBinding` primitive), so the two surfaces agree
    // on the rung, not just on integrity (locked by check-receipt-conformance).
    // Checked after revocation (a revoked key must not bind) and before the
    // identity/anchor ladder (sovereign is the top rung — supplying anchor
    // material must never downgrade it). Rotated-key receipts fail this and fall
    // through to the identity-file succession path below.
    if (typeof parsed.public_key === "string") {
      const receiptAloneSovereign = await verifySovereignBinding(
        String(parsed.motebit_id),
        parsed.public_key,
      );
      if (receiptAloneSovereign) return { ...view, binding: "sovereign" };
    }
    if (options?.identity) {
      // Sovereign is the strongest root AND fully offline — check it first; a
      // sovereign motebit needs no operator anchor at all.
      const sovereign = await sovereignBinding(parsed, options.identity);
      if (sovereign) return { ...view, binding: sovereign };
      if (options.anchor) {
        const anchored = await anchoredBinding(parsed, options.identity, options.anchor);
        if (anchored) return { ...view, binding: "anchored", anchorTxHash: anchored.txHash };
      }
      const pinned = await pinnedBinding(parsed, options.identity);
      if (pinned) return { ...view, binding: pinned };
    }
  }
  return view;
}

/**
 * Display logic for a verified receipt — maps the display verdict (`assess.ts`:
 * the verifier's view, downgraded to what the page's evidence supports) to the
 * words and tone the page shows. Kept pure and separate from `render.ts` (DOM)
 * so the one thing that MUST stay honest — never claiming more than the
 * evidence — is unit-tested.
 */

import type { ReceiptDocumentFailureReason } from "@motebit/state-export-client";
import { PROXY_LABEL, sourceLabel, type DisplayVerdict } from "./assess.js";
import { chainReason, NONCANONICAL_REASON } from "./served-chain.js";
import { formReason } from "./canonical.js";

/** Drives the result card's color treatment. */
export type ResultTone = "bound" | "integrity" | "failed";

export interface ResultLabels {
  readonly tone: ResultTone;
  /** Short, all-caps "grade" for the verdict badge (the rung reached). */
  readonly grade: string;
  readonly headline: string;
  readonly detail: string;
}

const FAILURE_DETAIL: Record<ReceiptDocumentFailureReason, string> = {
  malformed_json: "That isn't valid JSON. Paste the full receipt object.",
  not_a_receipt:
    "Valid JSON, but not an execution receipt (missing motebit_id / task_id / signature / suite).",
  missing_public_key: "No embedded public key — this receipt can't be verified offline.",
  signature_invalid: "The signature does not match the receipt body — it was altered or forged.",
  delegation_failed: "A delegated receipt in the chain failed verification.",
  unknown: "Verification failed.",
};

/** Every card that speaks of a time says whose claim that time is. */
export const CLAIMED_TIME =
  "completed_at is the signer's own claim, so when the receipt was issued is not proven";

const sentence = (s: string): string => `${s[0]!.toUpperCase()}${s.slice(1)}`;

/**
 * A memo's date as its poster wrote it, or undefined when it is outside the
 * range a Date can show (it is still reported, just not dated).
 */
export function memoDate(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

/** One sentence per identity-bearing field not in canonical form (rule 7), or null. */
export function formSentences(v: DisplayVerdict): string | null {
  if (v.noncanonical === undefined || v.noncanonical.length === 0) return null;
  return v.noncanonical.map((f) => `${sentence(formReason(f))}.`).join(" ");
}

/** How the id commits to the key, in words true for its form. */
export function commitmentPhrase(v: DisplayVerdict): string {
  return v.idForm === "did:key"
    ? "the motebit_id encodes this signing key (a did:key)"
    : "the motebit_id is derived from this signing key (a self-certifying commitment)";
}

export function resultLabels(v: DisplayVerdict): ResultLabels {
  // A reported revocation is the loudest verdict, and it fails closed — but it
  // is REPORTED, not proven: the lookup matches the memo's text and never checks
  // who signed the transaction, so anyone can post one. It is reported at ANY
  // date: the receipt's completed_at is the signer's claim, so a memo dated
  // after it clears nothing.
  if (v.binding === "revoked") {
    const date = memoDate(v.revokedAt);
    const dated = date !== undefined ? `, dated ${date} by its poster,` : "";
    return {
      tone: "failed",
      grade: "REVOCATION REPORTED",
      headline: "REVOCATION REPORTED (unauthenticated) — do not rely on this receipt",
      detail: `The signature matches, but a memo naming this signing key as revoked${dated} was found at the relay's anchor address, read ${sourceLabel(v.chainSource)}. The memo is unauthenticated — this page does not check who posted it, and anyone can — so it does not prove the key was revoked. Its date is not weighed against this receipt's: ${CLAIMED_TIME}, and a receipt dated before the memo may have been signed after it. Until the revocation is checked, do not rely on this receipt's identity claim, even though the bytes are intact.`,
    };
  }
  if (!v.integrity) {
    // A key or signature not in canonical form may be an honest re-spelling of
    // a genuine one: say what is wrong with it, never "forged".
    const unreadable = (v.noncanonical ?? []).filter(
      (f) => f === "public_key" || f === "signature",
    );
    const why = unreadable.map((f) =>
      f === "public_key"
        ? "The embedded signing key (public_key) is not in canonical form (exactly 64 lowercase hex characters)."
        : "The signature is not in canonical form (unpadded base64url of 64 bytes, the encoding its suite specifies).",
    );
    return {
      tone: "failed",
      grade: "INVALID",
      headline: "Verification failed",
      detail:
        why.length > 0
          ? `The signature does not verify as written. ${why.join(" ")} This page checks a receipt only as written, so nothing here is verified — which is not evidence of tampering either way.`
          : (FAILURE_DETAIL[v.reason ?? "unknown"] ?? FAILURE_DETAIL.unknown),
    };
  }
  if (v.binding === "key-commitment") {
    // The motebit_id is the self-certifying commitment to this very key (its
    // genesis key). Lower assurance than any bound rung: that arithmetic says
    // nothing about whether the key was still the motebit's when the receipt was issued.
    const succession =
      v.chainCheck !== undefined
        ? `A succession check ran against the identity chain the relay served and did not bind this key at the time this receipt claims: ${chainReason(v.chainCheck)}.`
        : "Rotation and revocation not established — no succession check ran, so this page did not check whether that key had been rotated away or revoked.";
    return {
      tone: "integrity",
      grade: "KEY COMMITMENT",
      headline: "Signature verified — current authorization not established",
      detail: `The signature is valid and the receipt is untampered. ${sentence(commitmentPhrase(v))}: identity commitment matches the motebit's original key. ${succession} This receipt's ${CLAIMED_TIME}. A key minted a second ago commits the same way; this is not trust.`,
    };
  }
  if (v.binding === "anchored") {
    return {
      tone: "bound",
      grade: "ANCHORED",
      headline: "Signature verified — key anchored at the claimed time",
      detail: `The signature is valid, the signing key fits the time window of this motebit's succession chain at the time this receipt claims, and that chain is committed in the operator's transparency log, whose root was found at the relay's pinned address through a Solana RPC the operator does not run. This receipt's ${CLAIMED_TIME}. This does not prove when the receipt was issued, or that the key was uncompromised.`,
    };
  }
  if (v.binding === "pinned") {
    const root =
      v.chainRoot === "id-commitment"
        ? ", whose genesis key is the one this motebit_id commits to (checked offline)"
        : v.chainRoot === "relay-record"
          ? " (this motebit_id commits to no key, so the chain's root is the relay's record)"
          : "";
    const proxy = v.anchorViaProxy
      ? ` The relay also reports an on-chain anchor for this chain, read ${PROXY_LABEL}, so the anchored rung is not claimed.`
      : "";
    // PINNED is conditional, and the condition is ON THE CARD: the key fits the
    // served chain's window at the CLAIMED time — nothing about issuance time,
    // chain completeness, or key compromise.
    return {
      tone: "bound",
      grade: "PINNED",
      headline: "Signature verified — key pinned at the claimed time",
      detail: `The signature is valid, and the signing key fits the time window of the succession chain the relay served${root} at the time this receipt claims — ${CLAIMED_TIME}. This does not prove when the receipt was issued, that the relay served the complete history (a later rotation the relay did not serve would not show here), or that the key was uncompromised. The chain is not shown to be committed in the operator's transparency log (the anchored rung).${proxy}`,
    };
  }
  // integrity-only: the honest default. Signature is valid, but it was checked
  // against the receipt's OWN embedded key — that proves the bytes weren't
  // tampered, NOT that the key belongs to this motebit.
  const anchor =
    formSentences(v) ??
    (v.idForm === "noncanonical"
      ? `${sentence(NONCANONICAL_REASON)}.`
      : v.chainCheck !== undefined
        ? `The identity chain the relay served does not bind this key: ${chainReason(v.chainCheck)}.`
        : "No trust anchor was provided.");
  return {
    tone: "integrity",
    grade: "INTEGRITY ONLY",
    headline: "Signature verified — identity not anchored",
    detail: `The signature is valid and the receipt is untampered, but it was checked against the receipt's own embedded key. That proves integrity, not that the key belongs to this motebit. ${anchor}`,
  };
}

/**
 * The PROOF ladder — one row per rung (integrity / identity binding / revocation),
 * each passed (✓), not established or not checked (—, always with the reason), or
 * failed (✗). Mapped from the DISPLAY verdict (`assess.ts`): the verifier's view
 * model (`@motebit/state-export-client`'s `ReceiptDocumentVerification`)
 * downgraded to what the page's evidence supports — no sovereign, binding from
 * the page's own guardian-free check of the served chain, no anchored or
 * revocation ✓ on proxy-only or truncated chain reads, a revocation memo shown
 * as reported (unauthenticated), never as proven — plus the
 * one fact the page itself owns: whether it asked the relay for binding material.
 * No rung is ever implied — a rung the page did not establish says so and why.
 */

import { PROXY_LABEL, sourceLabel, type DisplayVerdict } from "./assess.js";
import { chainReason, NONCANONICAL_REASON } from "./served-chain.js";
import { formReason } from "./canonical.js";
import { memoDate } from "./labels.js";

export type RungState = "passed" | "skipped" | "failed";
export type RungKey = "integrity" | "binding" | "revocation";

export interface Rung {
  readonly key: RungKey;
  readonly name: string;
  readonly state: RungState;
  /** For the binding rung when passed: which level. */
  readonly level?: "pinned" | "anchored";
  readonly summary: string;
}

/**
 * What the page did about relay context (the `pinned` / `anchored` / revocation
 * material). `offline`: not attempted, with the reason (sample, minted, …).
 * `unavailable`: attempted, the relay returned nothing usable (fail-closed).
 * `resolved`: the material was fetched and passed to the verifier.
 * `nested`: a delegated receipt — the verifier checks nested receipts for
 * integrity only.
 */
export type RelayContext =
  | { readonly kind: "offline"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "resolved" }
  | { readonly kind: "nested" };

const NESTED_REASON = "not checked: nested receipts are verified for integrity only";

function integrityRung(v: DisplayVerdict): Rung {
  return v.integrity
    ? {
        key: "integrity",
        name: "Integrity",
        state: "passed",
        summary: "the signature matches these exact bytes, under the key embedded in the receipt",
      }
    : {
        key: "integrity",
        name: "Integrity",
        state: "failed",
        summary: v.detail
          ? `the signature does not match — ${v.detail}`
          : "the signature does not match",
      };
}

function bindingRung(v: DisplayVerdict, ctx: RelayContext): Rung {
  const base = { key: "binding" as const, name: "Identity binding" };
  switch (v.binding) {
    case "key-commitment":
      return {
        ...base,
        state: "skipped",
        summary:
          v.chainCheck !== undefined
            ? `not bound — the motebit_id commits to this key (its original key), but the identity chain the relay served does not bind it at the time this receipt claims: ${chainReason(v.chainCheck)}`
            : `not established as current — identity commitment matches the motebit's original key; rotation and revocation not established (${v.idForm === "did:key" ? "the motebit_id encodes this key" : "the motebit_id is derived from this key"}, checked offline; no succession check ran)`,
      };
    case "anchored":
      return {
        ...base,
        state: "passed",
        level: "anchored",
        summary: v.anchorTxHash
          ? `anchored — the key fits the time window at the time this receipt claims in the relay's identity log, whose root was found on-chain through an independent RPC (tx ${v.anchorTxHash}); when the receipt was issued is not proven`
          : "anchored — the key fits the time window at the time this receipt claims in the relay's identity log, whose root was found on-chain through an independent RPC; when the receipt was issued is not proven",
      };
    case "pinned": {
      const root =
        v.chainRoot === "id-commitment"
          ? ", which roots at the key this motebit_id commits to"
          : v.chainRoot === "relay-record"
            ? " (the id commits to no key; the root is the relay's record)"
            : "";
      return {
        ...base,
        state: "passed",
        level: "pinned",
        summary: v.anchorViaProxy
          ? `pinned — the key fits the time window at the time this receipt claims (completed_at, the signer's own claim) in this motebit's identity chain, as served by the relay${root}; when the receipt was issued is not proven; the relay's on-chain anchor was read ${PROXY_LABEL}`
          : `pinned — the key fits the time window at the time this receipt claims (completed_at, the signer's own claim) in this motebit's identity chain, as served by the relay${root}; when the receipt was issued is not proven`,
      };
    }
    case "revoked":
      // Not established, so "—", never ✗: the memo is unauthenticated, so the
      // page has not shown the binding fails either.
      return {
        ...base,
        state: "skipped",
        summary: "not established — a revocation memo (unauthenticated) was reported for this key",
      };
    case "unverified":
      return { ...base, state: "skipped", summary: "not checked: integrity failed" };
    default: {
      // integrity-only: the offline commitment check ran and did not match; the
      // relay rungs depend on context.
      if (ctx.kind === "nested") return { ...base, state: "skipped", summary: NESTED_REASON };
      if (v.noncanonical !== undefined && v.noncanonical.length > 0) {
        return {
          ...base,
          state: "skipped",
          summary: `not established — ${v.noncanonical.map(formReason).join("; ")}`,
        };
      }
      if (v.idForm === "noncanonical") {
        return { ...base, state: "skipped", summary: `not established — ${NONCANONICAL_REASON}` };
      }
      const why =
        ctx.kind === "offline"
          ? ctx.reason
          : ctx.kind === "unavailable"
            ? ctx.reason
            : v.chainCheck !== undefined
              ? `the identity chain the relay served does not bind this key — ${chainReason(v.chainCheck)}`
              : "the relay's identity chain does not bind this key";
      return {
        ...base,
        state: "skipped",
        summary: `not established — the motebit_id is not a commitment to this key; pinned/anchored: ${why}`,
      };
    }
  }
}

function revocationRung(v: DisplayVerdict, ctx: RelayContext): Rung {
  const base = { key: "revocation" as const, name: "Revocation" };
  if (v.binding === "revoked" || v.revocation === "revoked") {
    // Any date: completed_at is the signer's claim, so the memo's date relative
    // to it clears nothing.
    const date = memoDate(v.revokedAt);
    const when =
      date !== undefined
        ? `a memo naming this key, dated ${date} by its poster`
        : "a memo naming this key (with no date this page can show)";
    return {
      ...base,
      state: "failed",
      summary: `REVOCATION REPORTED (unauthenticated) — ${when}, reported whatever this receipt's claimed time; who posted it was not checked — read ${sourceLabel(v.chainSource)}`,
    };
  }
  if (!v.integrity) return { ...base, state: "skipped", summary: "not checked: integrity failed" };
  switch (v.revocation) {
    case "not_revoked":
      return {
        ...base,
        state: "passed",
        // Its real scope (N2): one address, the one the relay's transparency
        // declaration names (fetched on this visit) — not the whole chain.
        summary:
          "no revocation memo naming the signing key at the anchor address the relay declares (its transparency declaration, fetched on this visit) — a complete scan of that one address through an independent RPC; memos anywhere else were not looked for",
      };
    case "not_established":
      return {
        ...base,
        state: "skipped",
        summary: `not established: ${v.revocationNote ?? "the on-chain lookup did not complete"}`,
      };
    default:
      if (ctx.kind === "nested") return { ...base, state: "skipped", summary: NESTED_REASON };
      if (ctx.kind === "resolved") return { ...base, state: "skipped", summary: "not checked" };
      return { ...base, state: "skipped", summary: `not checked: ${ctx.reason}` };
  }
}

export function proofLadder(v: DisplayVerdict, ctx: RelayContext): Rung[] {
  return [integrityRung(v), bindingRung(v, ctx), revocationRung(v, ctx)];
}

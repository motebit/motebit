/**
 * The display verdict — what the page is allowed to CLAIM, given the verifier's
 * view model AND what the page knows about the evidence behind it. Every render
 * path (labels, ladder, honesty, render) consumes `DisplayVerdict`, never the raw
 * `ReceiptDocumentVerification`, so a claim stronger than its evidence is not a
 * value the renderers can be handed.
 *
 * Identity binding is decided from the page's OWN evidence (`BindingEvidence`),
 * not from the verifier's `binding: "sovereign"` — that one value covers both
 * the receipt-alone commitment and the time-windowed succession path, and the
 * page binds a served chain only through its own canonical-form and
 * root checks (`served-chain.ts`):
 *
 *   1. The relay-served chain binds the signing key at the receipt's CLAIMED
 *      time (checked by the page with no guardian link honoured, for an
 *      exactly canonical id only) → `pinned`, or
 *      `anchored` when the verifier also reached anchored on independent
 *      evidence. Never SOVEREIGN: the time window is only as complete as the
 *      chain the relay chose to serve.
 *   2. No served chain binds it, but the motebit_id is the self-certifying
 *      commitment to the signing key → `key-commitment`: integrity holds and
 *      the id commits to this key, but whether the key was still the motebit's
 *      when the receipt was issued is not established (or the served chain says
 *      it was not at the time the receipt claims).
 *   3. Otherwise → `integrity-only`, whatever the verifier reached.
 *
 * And from the chain evidence (cold review F-1 / F-2):
 *
 *   4. `anchored` stands only when the on-chain root was read through an RPC
 *      the operator does not run. Read via Motebit's RPC proxy, it is shown as
 *      `pinned` with the anchor labelled "via Motebit's RPC proxy (not
 *      independently confirmed)".
 *   5. Revocation is ✓ only when the scan came from an independent RPC AND is
 *      provably complete (fewer signatures returned than the page limit). A
 *      failed, truncated, or proxy-only scan is `not_established`.
 *
 *   6. ANY revocation memo found for the signing key is shown, whatever the
 *      source and whatever its date relative to the receipt's `completed_at`.
 *      That time is the signer's own claim: a thief holding a retired key can
 *      date a receipt before the memo, so "the memo came after signing" is not
 *      evidence of anything. The verifier's `revoked_after_signing` is
 *      therefore displayed exactly like `revoked`; there is no display value
 *      for "revoked, but later".
 *
 * A found revocation memo fails closed, but as REPORTED and unauthenticated:
 * the lookup matches the memo text and never checks who signed the
 * transaction, so anyone can post one. "Found" means found by EITHER the
 * verifier's lookup or the page's own scan (`memo-scan.ts`), which is keyed on
 * the DECODED key and reports a memo that names the key with no usable date.
 *
 *   7. Every identity-bearing field the signer writes — motebit_id,
 *      public_key, signature, suite — must be in exact canonical form
 *      (`canonical.ts`). Any field that is not earns no binding (INTEGRITY
 *      ONLY) and no revocation verdict above "not established": a re-spelled
 *      key decodes to the same bytes, so the signature verifies, while
 *      anything keyed on its text sees another key (round 4, K1). A memo found
 *      for the decoded key is still reported.
 *   8. A revocation ✓ needs the page's own scan to have run on the decoded key
 *      and found nothing, as well as the verifier's. Its scope is one address:
 *      the anchor address the relay declares — not the whole chain.
 *
 * Every time the page speaks of is the receipt's CLAIMED time. Issuance time is
 * never proven here, and the copy says so.
 */

import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import type { IdForm, ServedChainCheck } from "./served-chain.js";
import { formReason, type FormField } from "./canonical.js";
import type { MemoScanResult } from "./memo-scan.js";

/** Who answered the Solana JSON-RPC reads behind the anchor/revocation rungs. */
export type ChainSource = "operator-proxy" | "independent";

/** The exact provenance label for anything read through the operator's proxy. */
export const PROXY_LABEL = "via Motebit's RPC proxy (not independently confirmed)";

/** Where a chain read (e.g. a revocation memo) came from, as the copy states it. */
export function sourceLabel(source: ChainSource | undefined): string {
  if (source === "operator-proxy") return PROXY_LABEL;
  if (source === "independent") return "through an RPC the operator does not run";
  return "from an unrecorded source";
}

/**
 * Classify an RPC URL. Hosts the operator runs (motebit.com, receipt.computer
 * and their subdomains) are the operator proxy; an unparseable URL is treated
 * as the proxy too (fail-closed — it never earns the independent label).
 */
export function classifyRpc(url: string): ChainSource {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "operator-proxy";
  }
  const operator = ["motebit.com", "receipt.computer"];
  return operator.some((d) => host === d || host.endsWith(`.${d}`))
    ? "operator-proxy"
    : "independent";
}

/** One `getSignaturesForAddress` call as the page observed it. */
export interface ScanObservation {
  /** The `limit` the request asked for (undefined when it could not be read). */
  readonly limit?: number;
  /** How many signatures came back (undefined on any failure). */
  readonly returned?: number;
  readonly ok: boolean;
}

/**
 * Wrap `fetch` so every `getSignaturesForAddress` response is recorded — the
 * verifier does not report whether its scan saw every signature, so the page
 * measures it. The wrapped fetch returns the original response untouched.
 */
export function observeSignatureScans(base: typeof globalThis.fetch): {
  readonly fetch: typeof globalThis.fetch;
  readonly scans: ScanObservation[];
} {
  const scans: ScanObservation[] = [];
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    let limit: number | undefined;
    let isScan = false;
    try {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as {
        method?: unknown;
        params?: unknown;
      } | null;
      if (body?.method === "getSignaturesForAddress") {
        isScan = true;
        const opts = Array.isArray(body.params) ? (body.params[1] as { limit?: unknown }) : null;
        if (typeof opts?.limit === "number") limit = opts.limit;
      }
    } catch {
      /* not a JSON-RPC body */
    }
    let res: Response;
    try {
      res = await base(input, init);
    } catch (err) {
      if (isScan) scans.push({ ok: false, ...(limit !== undefined ? { limit } : {}) });
      throw err;
    }
    if (isScan) {
      let returned: number | undefined;
      try {
        const parsed = (await res.clone().json()) as { result?: unknown; error?: unknown };
        if (parsed.error === undefined && Array.isArray(parsed.result))
          returned = parsed.result.length;
      } catch {
        /* unreadable — not complete */
      }
      scans.push({
        ok: res.ok && returned !== undefined,
        ...(limit !== undefined ? { limit } : {}),
        ...(returned !== undefined ? { returned } : {}),
      });
    }
    return res;
  };
  return { fetch: wrapped, scans };
}

/**
 * True iff there was at least one scan, every scan succeeded, and every scan
 * returned strictly fewer signatures than it asked for — i.e. it reached the
 * end of the address's history instead of stopping at the page limit.
 */
export function scansComplete(scans: readonly ScanObservation[]): boolean {
  return (
    scans.length > 0 &&
    scans.every(
      (s) => s.ok && s.limit !== undefined && s.returned !== undefined && s.returned < s.limit,
    )
  );
}

/** What the page knows about the chain evidence behind one verification. */
export interface ChainEvidence {
  readonly source: ChainSource;
  /** The revocation scan provably saw every signature at the relay address. */
  readonly revocationScanComplete: boolean;
  /**
   * The page's own memo scan, keyed on the DECODED signing key (`memo-scan.ts`).
   * Absent ⇒ it did not run, and revocation is not established.
   */
  readonly memoScan?: MemoScanResult;
}

/** What the page itself established about the key ↔ motebit_id relation. */
export interface BindingEvidence {
  /** The motebit_id is the self-certifying commitment to the receipt's signing key. */
  readonly keyCommitsToId: boolean;
  /** The page's check of the relay-served chain; absent ⇒ no chain was served or checked. */
  readonly servedChain?: ServedChainCheck;
  /** How the motebit_id is written (`classifyId`); drives the copy, never the binding. */
  readonly idForm?: IdForm;
  /** Identity-bearing fields not in exact canonical form (`noncanonicalFields`); any ⇒ no binding. */
  readonly noncanonical?: readonly FormField[];
}

/** Nested receipts and failed integrity: nothing about the key is established. */
export const NO_BINDING_EVIDENCE: BindingEvidence = { keyCommitsToId: false };

/** The binding the page may show. There is no "sovereign" here by design. */
export type DisplayBinding =
  "revoked" | "key-commitment" | "anchored" | "pinned" | "integrity-only" | "unverified";

/**
 * No "revoked after signing": a memo's date is never compared with the
 * signer-claimed `completed_at` to clear a key (rule 6).
 */
export type DisplayRevocation = "not_revoked" | "revoked" | "not_established";

export interface DisplayVerdict {
  readonly integrity: boolean;
  readonly binding: DisplayBinding;
  readonly anchorTxHash?: string;
  readonly revokedAt?: number;
  /** Absent ⇒ revocation was not attempted (offline / nested). */
  readonly revocation?: DisplayRevocation;
  /** Why revocation is `not_established` (failure, truncation, proxy). */
  readonly revocationNote?: string;
  /** Who answered the chain reads, when any were made. */
  readonly chainSource?: ChainSource;
  /** The verifier reached `anchored`, but only through the operator proxy. */
  readonly anchorViaProxy?: boolean;
  /** `pinned`/`anchored`: whether the served chain roots at the key the id commits to. */
  readonly chainRoot?: "id-commitment" | "relay-record";
  /** The page's served-chain outcome when it did not bind (the reason, for the copy). */
  readonly chainCheck?: Exclude<ServedChainCheck["kind"], "bound">;
  /** How the motebit_id is written, when the page classified it. */
  readonly idForm?: IdForm;
  /** Identity-bearing fields not in canonical form (rule 7); absent ⇒ all canonical or unchecked. */
  readonly noncanonical?: readonly FormField[];
  readonly signerDid?: string;
  readonly motebitId?: string;
  readonly taskId?: string;
  readonly delegations?: DisplayVerdict[];
  readonly reason?: ReceiptDocumentVerification["reason"];
  readonly detail?: string;
}

function revocationNotEstablished(
  v: ReceiptDocumentVerification,
  evidence: ChainEvidence | undefined,
): string | null {
  if (v.revocation === "unknown") {
    return `the on-chain lookup failed${v.revocationDetail ? ` (${v.revocationDetail})` : ""}`;
  }
  if (v.revocation !== "not_revoked") return null;
  if (evidence === undefined) return "the source of the on-chain lookup is unknown";
  if (evidence.memoScan?.status === "unknown") {
    return `the on-chain lookup failed (${evidence.memoScan.detail})`;
  }
  if (evidence.source === "operator-proxy") {
    return `the on-chain lookup was read ${PROXY_LABEL}`;
  }
  if (!evidence.revocationScanComplete) {
    return "the scan stopped at the 200-signature page limit, so an older revocation may not have been seen";
  }
  if (evidence.memoScan?.status !== "none") {
    return "this page's own scan for the signing key did not run";
  }
  return null;
}

/** The earliest of two optional dates. */
function earliest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Map the verifier's view + the page's evidence to the claim the page may show. */
export function assessVerdict(
  v: ReceiptDocumentVerification,
  evidence: ChainEvidence | undefined,
  keyEvidence: BindingEvidence,
): DisplayVerdict {
  let shown: DisplayBinding;
  let anchorViaProxy = false;
  const chain = keyEvidence.servedChain;
  const verifierBound =
    v.binding === "sovereign" || v.binding === "pinned" || v.binding === "anchored";
  // Rule 6: a memo found at any date is reported — never cleared by the claimed time.
  // Found by the verifier's lookup OR by the page's own decoded-key scan.
  const scanFound = v.integrity && evidence?.memoScan?.status === "found";
  const memoFound =
    v.revocation === "revoked" ||
    v.revocation === "revoked_after_signing" ||
    v.binding === "revoked" ||
    scanFound;
  // Rule 7: a field not in canonical form binds nothing.
  const noncanonical = keyEvidence.noncanonical ?? [];
  if (v.binding === "unverified") {
    shown = "unverified";
  } else if (memoFound) {
    shown = "revoked";
  } else if (noncanonical.length > 0) {
    shown = "integrity-only";
  } else if (chain?.kind === "bound" && verifierBound) {
    // The page's guardian-free check binds the key at the receipt's CLAIMED time.
    if (v.binding === "anchored" && evidence?.source === "independent") {
      shown = "anchored";
    } else {
      shown = "pinned";
      anchorViaProxy = v.binding === "anchored";
    }
  } else if (keyEvidence.keyCommitsToId && v.binding === "sovereign") {
    shown = "key-commitment";
  } else {
    shown = "integrity-only";
  }
  const out: { -readonly [K in keyof DisplayVerdict]: DisplayVerdict[K] } = {
    integrity: v.integrity,
    binding: shown,
  };
  if ((shown === "pinned" || shown === "anchored") && chain?.kind === "bound") {
    out.chainRoot = chain.root;
  }
  if (chain !== undefined && chain.kind !== "bound" && v.integrity) out.chainCheck = chain.kind;
  if (shown === "anchored" && v.anchorTxHash !== undefined) out.anchorTxHash = v.anchorTxHash;
  if (anchorViaProxy) out.anchorViaProxy = true;
  const revokedAt = earliest(
    v.revokedAt,
    scanFound && evidence?.memoScan?.status === "found" ? evidence.memoScan.revokedAt : undefined,
  );
  if (revokedAt !== undefined) out.revokedAt = revokedAt;
  if (keyEvidence.idForm !== undefined && v.integrity) out.idForm = keyEvidence.idForm;
  if (noncanonical.length > 0) out.noncanonical = noncanonical;
  if (memoFound) {
    out.revocation = "revoked";
  } else if (noncanonical.length > 0 && v.integrity) {
    // Rule 7: no revocation verdict for a key the page cannot name canonically.
    out.revocation = "not_established";
    out.revocationNote = formReason(noncanonical[0]!);
  } else if (v.revocation !== undefined) {
    const why = revocationNotEstablished(v, evidence);
    if (why !== null) {
      out.revocation = "not_established";
      out.revocationNote = why;
    } else {
      out.revocation = v.revocation === "not_revoked" ? "not_revoked" : "not_established";
    }
  }
  if (evidence !== undefined && (v.revocation !== undefined || v.binding === "anchored")) {
    out.chainSource = evidence.source;
  }
  if (v.signerDid !== undefined) out.signerDid = v.signerDid;
  if (v.motebitId !== undefined) out.motebitId = v.motebitId;
  if (v.taskId !== undefined) out.taskId = v.taskId;
  if (v.reason !== undefined) out.reason = v.reason;
  if (v.detail !== undefined) out.detail = v.detail;
  if (v.delegations !== undefined)
    out.delegations = v.delegations.map((d) => assessVerdict(d, undefined, NO_BINDING_EVIDENCE));
  return out;
}

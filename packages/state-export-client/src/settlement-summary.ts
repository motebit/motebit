/**
 * Verified fetch for a motebit's per-peer settlement summary — the money
 * side of the first-person trust graph
 * (`docs/doctrine/agents-as-first-person-trust-graph.md` §6).
 *
 * The relay assembles the summary from its signed `relay_settlements`
 * ledger and emits it as a `settlement-summary` content artifact at
 * `/api/v1/agents/:motebitId/settlements`. This wrapper centralizes that
 * path (so each surface doesn't hardcode it), types the body, and — as
 * defense in depth — fails closed if the verified manifest carries a
 * different `artifact_type` than the endpoint promises.
 *
 * Same browser-safe, no-implicit-network contract as the rest of the
 * package (rule 2): the caller injects `fetch` and passes its bearer
 * token + transparency anchor through `options`.
 */
import type { SettlementSummaryExport } from "@motebit/protocol";
import {
  verifiedStateExportFetch,
  type VerifiedFetchOptions,
  type VerifiedStateExportResponse,
} from "./verified-fetch.js";

export type {
  SettlementSummaryExport,
  SettlementSummaryPeer,
  SettlementSummaryUnattributed,
} from "@motebit/protocol";

/**
 * Canonical relay path for a motebit's per-peer settlement summary. The
 * single source of this URL shape — surfaces build their request through
 * it rather than re-spelling the path.
 */
export function settlementSummaryUrl(baseUrl: string, motebitId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/v1/agents/${encodeURIComponent(motebitId)}/settlements`;
}

/**
 * Fetch + verify a motebit's settlement summary. Returns the parsed body
 * (`null` on any verification failure — never render unverified money
 * history) alongside the structured verification result.
 *
 * Fail-closed extension over the generic verifier: even when the bytes
 * verify, a manifest whose `artifact_type` is not `settlement-summary` is
 * rejected with `unexpected_artifact_type` — signed, but signed for the
 * wrong export.
 */
export async function verifiedSettlementSummaryFetch(
  baseUrl: string,
  motebitId: string,
  options: VerifiedFetchOptions = {},
): Promise<VerifiedStateExportResponse<SettlementSummaryExport>> {
  const res = await verifiedStateExportFetch<SettlementSummaryExport>(
    settlementSummaryUrl(baseUrl, motebitId),
    options,
  );
  if (res.verification.valid && res.verification.artifactType !== "settlement-summary") {
    return {
      body: null,
      bodyBytes: res.bodyBytes,
      verification: {
        valid: false,
        reason: "unexpected_artifact_type",
        detail: `expected settlement-summary, got ${res.verification.artifactType}`,
      },
    };
  }
  return res;
}

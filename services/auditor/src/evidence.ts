/**
 * Evidence plumbing for the Auditor — pinned-relay fetching and
 * raw-bytes-to-provenance digestion.
 *
 * SSRF posture is structural (archetype-arc review F8): `createRelayFetcher`
 * closes over ONE configured relay base URL and only ever appends
 * relay-owned paths to it; the target's motebit_id is format-validated
 * before path interpolation and no target-controlled URL (listing
 * endpoint_url etc.) is ever fetched.
 *
 * Digests use node:crypto sha-256 over the RAW response bytes — the same
 * raw-byte discipline as evidence-provenance-v1's default guardrail. Spans
 * are verbatim substrings of those bytes, so every EvidenceRef this service
 * emits is re-checkable by `verifyEvidenceProvenance` with no projection
 * resolver (raw-byte path, re-verifiable by construction).
 */

import { createHash } from "node:crypto";
import type { DigestRef, EvidenceProvenance, EvidenceRef } from "@motebit/sdk";

/** UUID-shaped (motebit ids are UUIDv7 strings). Mirrors the relay's asMotebitId posture. */
const MOTEBIT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isWellFormedMotebitId(value: string): boolean {
  return MOTEBIT_ID_PATTERN.test(value);
}

export interface FetchedEvidence {
  status: number;
  bytes: Uint8Array;
  text: string;
}

export type RelayFetcher = (relayPath: string) => Promise<FetchedEvidence>;

/**
 * Build the ONLY fetcher the audit engine receives. `relayBaseUrl` is the
 * single allowed origin; `relayPath` must be an absolute path (leading
 * slash), so a caller cannot smuggle a foreign origin.
 */
export function createRelayFetcher(
  relayBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): RelayFetcher {
  const base = relayBaseUrl.replace(/\/+$/, "");
  return async (relayPath: string): Promise<FetchedEvidence> => {
    if (!relayPath.startsWith("/")) {
      throw new Error(`relay fetch path must be absolute, got: ${relayPath}`);
    }
    const res = await fetchImpl(`${base}${relayPath}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, bytes: buf, text: new TextDecoder().decode(buf) };
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestRef(bytes: Uint8Array): DigestRef {
  return { algorithm: "sha-256", value: sha256Hex(bytes) };
}

/**
 * Build a re-checkable EvidenceRef over raw fetched bytes. `span` must be a
 * verbatim substring of the raw text (the load-bearing excerpt — a key, an
 * amount, a revocation entry); when it isn't found the ref is emitted
 * WITHOUT provenance rather than with a fabricated span.
 */
export function evidenceRefFor(kind: string, bytes: Uint8Array, span?: string): EvidenceRef {
  const digest = digestRef(bytes);
  const text = new TextDecoder().decode(bytes);
  let provenance: EvidenceProvenance | undefined;
  if (span != null && span.length > 0 && text.includes(span)) {
    const start = text.indexOf(span);
    provenance = {
      digest,
      span,
      locator: { start, end: start + span.length },
    };
  }
  return {
    kind,
    ref: `sha256:${digest.value}`,
    ...(provenance ? { provenance } : {}),
  };
}

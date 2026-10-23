/**
 * The page's own revocation-memo scan — the reporter behind "ANY revocation memo
 * found for the signing key is shown" (assess.ts rule 6).
 *
 * The verifier's lookup (`@motebit/state-export-client`'s `lookupKeyRevocation`)
 * is the definitive-looking one, and two of its choices hide memos from a page
 * whose job is to report them:
 *
 *   1. Its needle is built from the receipt's `public_key` TEXT. A signer who
 *      re-spells the key (an appended character, whitespace, a sign, upper
 *      case — all decode to the same bytes) gets a needle no memo matches.
 *      This scan is keyed on the canonical hex of the DECODED key
 *      (`canonicalKeyHexOfDid`), so it finds the key's memos whatever the
 *      spelling.
 *   2. It drops a memo that names the key without a decimal, finite timestamp
 *      (`…:<key>:`, `…:<key>:revoked`, a 400-digit date that overflows). Such a
 *      memo still names the key; this scan reports it, dated or not.
 *
 * Like the verifier's lookup, it never checks who posted a memo (anyone can),
 * so a find is REPORTED, never proven. A memo on a failed transaction is
 * reported too: reporting more is the fail-closed direction. It reads one
 * address — the anchor address the relay declares — and nothing else.
 */

const REVOCATION_MEMO_PREFIX = "motebit:revocation:v1:";

export type MemoScanResult =
  /** At least one memo names the key. `revokedAt`: the earliest usable date, if any memo has one. */
  | { readonly status: "found"; readonly revokedAt?: number }
  /** The scan returned and no memo names the key (completeness is measured by the caller). */
  | { readonly status: "none" }
  /** The RPC failed — nothing established. */
  | { readonly status: "unknown"; readonly detail: string };

export interface MemoScanOptions {
  readonly rpcUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** Signatures requested; the caller measures completeness against it. Default 200. */
  readonly limit?: number;
}

/** Scan `address` for any revocation memo naming `keyHex` (canonical lowercase hex). Never throws. */
export async function scanRevocationMemos(
  address: string,
  keyHex: string,
  options: MemoScanOptions,
): Promise<MemoScanResult> {
  const needle = `${REVOCATION_MEMO_PREFIX}${keyHex.toLowerCase()}`;
  let sigs: unknown;
  try {
    const res = await options.fetch(options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [address, { limit: options.limit ?? 200 }],
      }),
    });
    if (!res.ok) return { status: "unknown", detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } };
    if (body.error !== undefined) {
      const m = body.error.message;
      return { status: "unknown", detail: typeof m === "string" ? m : "RPC error" };
    }
    sigs = body.result;
  } catch (err) {
    return { status: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!Array.isArray(sigs)) return { status: "unknown", detail: "malformed RPC result" };

  let found = false;
  let earliest: number | undefined;
  for (const s of sigs) {
    const memo = (s as { memo?: unknown } | null)?.memo;
    if (typeof memo !== "string") continue;
    const text = memo.toLowerCase();
    let from = 0;
    for (let idx = text.indexOf(needle); idx !== -1; idx = text.indexOf(needle, from)) {
      found = true;
      from = idx + needle.length;
      // A usable date: ":" then decimal digits that make a safe integer.
      const ts = /^:(\d+)/.exec(text.slice(from));
      const at = ts ? Number(ts[1]) : NaN;
      if (Number.isSafeInteger(at) && (earliest === undefined || at < earliest)) earliest = at;
    }
  }
  if (!found) return { status: "none" };
  return earliest === undefined ? { status: "found" } : { status: "found", revokedAt: earliest };
}

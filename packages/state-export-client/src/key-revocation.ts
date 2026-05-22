/**
 * On-chain key-revocation lookup — the binding-time consumer of the relay's
 * revocation memos.
 *
 * When a key is rotated away or an agent is revoked, the relay anchors a
 * `motebit:revocation:v1:{keyHex}:{timestamp}` memo on Solana
 * (`SolanaMemoSubmitter.submitRevocation`). This module reads those memos so a
 * verifier can refuse to bind a receipt signed by a key that was revoked at or
 * before the receipt's timestamp.
 *
 * The trust asymmetry vs. the anchored rung is the whole point: a relay can't
 * forge an anchored root, but it COULD hide a revocation that protects it (a key
 * it secretly controls). So revocation must be read from the neutral chain at the
 * relay's pinned address — never taken from the relay's own `/identity` response.
 * `revoked_at` is whatever timestamp the memo carries; if the operator backdates
 * it to the true compromise moment, this consumer honors that automatically.
 *
 * No SDK dep — Solana JSON-RPC over fetch keeps the package browser-safe. Mirrors
 * `identity-anchor.ts` / `onchain-anchor.ts`.
 */

const REVOCATION_MEMO_PREFIX = "motebit:revocation:v1:";

export interface KeyRevocationLookupOptions {
  readonly rpcUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Max signatures to scan at the relay address. Default 200. */
  readonly maxSignatures?: number;
}

export type KeyRevocationResult =
  /** A revocation memo for this key was found on-chain. `revokedAt` is its timestamp (ms). */
  | { readonly status: "revoked"; readonly revokedAt: number; readonly txHash: string }
  /** Scan completed; no revocation memo for this key at the address. */
  | { readonly status: "not_revoked" }
  /** Could not determine (RPC/transport failure) — NOT proof of safety. */
  | { readonly status: "unknown"; readonly detail: string };

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  blockTime: number | null;
}

/**
 * Look up whether `signingKeyHex` has an on-chain revocation memo at the relay's
 * pinned address. Returns the EARLIEST revocation timestamp found (the most
 * protective — a key revoked at T cannot be trusted for anything dated ≥ T).
 * Never throws; transport/RPC failures surface as `status: "unknown"`.
 */
export async function lookupKeyRevocation(
  relayAnchorAddress: string,
  signingKeyHex: string,
  options: KeyRevocationLookupOptions = {},
): Promise<KeyRevocationResult> {
  const rpcUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const limit = options.maxSignatures ?? 200;
  const needle = `${REVOCATION_MEMO_PREFIX}${signingKeyHex.toLowerCase()}:`;

  let signatures: SignatureInfo[];
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [relayAnchorAddress, { limit }],
      }),
    });
    if (!res.ok) return { status: "unknown", detail: `HTTP ${res.status}` };
    const body = (await res.json()) as RpcResponse<SignatureInfo[]>;
    if (body.error !== undefined) return { status: "unknown", detail: body.error.message };
    signatures = body.result ?? [];
  } catch (err) {
    return { status: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }

  let earliest: { revokedAt: number; txHash: string } | null = null;
  for (const sig of signatures) {
    if (sig.err !== null) continue;
    if (sig.memo == null) continue;
    const idx = sig.memo.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const after = sig.memo.slice(idx + needle.length);
    const tsMatch = after.match(/^(\d+)/);
    if (tsMatch == null) continue;
    const revokedAt = Number(tsMatch[1]);
    if (!Number.isFinite(revokedAt)) continue;
    if (earliest == null || revokedAt < earliest.revokedAt) {
      earliest = { revokedAt, txHash: sig.signature };
    }
  }

  return earliest
    ? { status: "revoked", revokedAt: earliest.revokedAt, txHash: earliest.txHash }
    : { status: "not_revoked" };
}

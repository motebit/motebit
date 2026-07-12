/**
 * Onchain cross-check for the operator-transparency declaration.
 *
 * Trust-on-first-use (TOFU) bootstrap is the weakest link in the
 * offline-after-bootstrap verification story — the first fetch of
 * `/.well-known/motebit-transparency.json` trusts HTTPS + DNS + CAs.
 * A DNS hijack, malicious ISP, or compromised CA can substitute a
 * different declaration with the attacker's key embedded (the
 * self-signature still verifies — against the attacker's key).
 *
 * Closure: anchor the declaration's hash to Solana via the Memo
 * program at deploy/declare time. A verifier with the relay's pinned
 * Solana address (out-of-band trust root, like Apple's App Attest root
 * cert) cross-checks `sha256(declaration)` against memos at that
 * address. Mismatch — or no memo at all — surfaces a typed reason.
 *
 * No SDK dep. Solana JSON-RPC is plain HTTP-JSON; this module uses
 * `fetch` directly to keep `@motebit/state-export-client` browser-safe
 * and dep-thin (no `@solana/web3.js` pulled into web bundles).
 *
 * Doctrine: `docs/doctrine/operator-transparency.md` § Stage 2 onchain
 * anchor; `docs/doctrine/nist-alignment.md` §8 "savant gap closure".
 */

import type { SignedTransparencyDeclaration } from "./transparency-anchor.js";

/** Canonical memo prefix the relay emits for transparency anchors. */
const TRANSPARENCY_MEMO_PREFIX = "motebit:transparency:v1:";

export interface OnchainAnchorLookupOptions {
  /**
   * Solana JSON-RPC endpoint URL. Defaults to mainnet-beta — production
   * verifiers SHOULD pin a known-good RPC (Helius / Triton / self-hosted)
   * to avoid the same kind of supply-chain risk the anchor exists to
   * close. Tests pass a fixture URL backed by a mock fetch.
   */
  readonly rpcUrl?: string;
  /**
   * Inject the fetch implementation. Defaults to global `fetch`. Tests
   * pass a mock; integrators with custom transport pass a wrapper.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Max signatures to scan at the anchor address. Memos are append-only;
   * the latest one is the current declaration anchor. Older signatures
   * are historical declarations the operator has cycled through.
   * Default 50 — covers typical operator cadence (declarations change
   * on doctrine update or key rotation, not frequently).
   */
  readonly maxSignatures?: number;
}

/** Verification outcome with a structured failure reason for audit logging. */
export type OnchainAnchorResult =
  | {
      readonly ok: true;
      readonly txHash: string;
      readonly anchoredHashHex: string;
      readonly anchorAddress: string;
    }
  | {
      readonly ok: false;
      readonly reason: OnchainAnchorFailureReason;
      readonly detail?: string;
    };

export type OnchainAnchorFailureReason =
  "rpc_failed" | "no_anchor_found" | "anchor_hash_mismatch" | "malformed_memo";

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
 * Look up the latest onchain anchor for a transparency declaration.
 * Returns a typed result — never throws on verification failure; HTTP
 * errors surface as `rpc_failed`.
 *
 * Algorithm:
 *
 *   1. `getSignaturesForAddress(anchorAddress)` returns recent signatures
 *      with their memo field populated (the JSON-RPC returns the memo
 *      inline because the Memo program emits the data in the tx log).
 *   2. Filter to signatures whose memo starts with the canonical
 *      `motebit:transparency:v1:` prefix.
 *   3. Pick the most recent (signatures are returned newest-first).
 *   4. Parse the hash out of the memo (`motebit:transparency:v1:<hash>`).
 *   5. Compare against `expectedHashHex`. Equality → anchored; mismatch
 *      → tampering; no match in scan → never anchored.
 *
 * The pinned `anchorAddress` is the trust root. It MUST be obtained
 * out-of-band (published in the motebit canonical config, the docs site,
 * or a known motebit-org keyring) — passing the value from the
 * declaration itself would be circular trust.
 */
export async function lookupTransparencyAnchor(
  anchorAddress: string,
  expectedHashHex: string,
  options: OnchainAnchorLookupOptions = {},
): Promise<OnchainAnchorResult> {
  const rpcUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const limit = options.maxSignatures ?? 50;

  let signatures: SignatureInfo[];
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [anchorAddress, { limit }],
      }),
    });
    if (!res.ok) {
      return { ok: false, reason: "rpc_failed", detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as RpcResponse<SignatureInfo[]>;
    if (body.error !== undefined) {
      return { ok: false, reason: "rpc_failed", detail: body.error.message };
    }
    signatures = body.result ?? [];
  } catch (err) {
    return {
      ok: false,
      reason: "rpc_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Newest-first per Solana RPC convention. Find the first valid
  // transparency anchor memo. The memo field appears in the signature
  // result when the tx includes the Memo program — solana-rpc parses
  // and surfaces the data inline.
  for (const sig of signatures) {
    if (sig.err !== null) continue; // skip failed txs
    if (sig.memo == null) continue;

    // Solana RPC formats memo as `[<size> (len <bytes>)] <utf-8>`. The
    // leading bracket-prefix is metadata; the actual memo bytes follow.
    // Match the canonical prefix anywhere in the formatted string —
    // robust to format variation across RPC versions.
    const idx = sig.memo.indexOf(TRANSPARENCY_MEMO_PREFIX);
    if (idx === -1) continue;

    const after = sig.memo.slice(idx + TRANSPARENCY_MEMO_PREFIX.length);
    // The hash continues until the first non-hex character (end of string,
    // closing bracket from RPC formatting, whitespace, etc.).
    const hashMatch = after.match(/^([0-9a-fA-F]{64})/);
    if (hashMatch == null) {
      return {
        ok: false,
        reason: "malformed_memo",
        detail: `memo prefix matched but hash slot is not 64 hex chars: "${after.slice(0, 80)}"`,
      };
    }
    const anchoredHashHex = hashMatch[1]!.toLowerCase();

    if (anchoredHashHex !== expectedHashHex.toLowerCase()) {
      return {
        ok: false,
        reason: "anchor_hash_mismatch",
        detail: `expected ${expectedHashHex.toLowerCase()}, got ${anchoredHashHex}`,
      };
    }

    return {
      ok: true,
      txHash: sig.signature,
      anchoredHashHex,
      anchorAddress,
    };
  }

  return {
    ok: false,
    reason: "no_anchor_found",
    detail: `scanned ${signatures.length} signature(s) at ${anchorAddress}, none matched ${TRANSPARENCY_MEMO_PREFIX}<hash>`,
  };
}

/**
 * Convenience: cross-check a transparency declaration against an
 * onchain anchor. Combines hash extraction from the declaration with
 * `lookupTransparencyAnchor`. Returns the same typed result.
 *
 * The verifier expected to call this AFTER `verifyTransparencyDeclaration`
 * has confirmed the self-signature — anchor verification adds a second
 * trust channel on top of the self-signature check; it doesn't replace
 * the self-signature.
 */
export async function verifyDeclarationOnchainAnchor(
  declaration: SignedTransparencyDeclaration,
  anchorAddress: string,
  options: OnchainAnchorLookupOptions = {},
): Promise<OnchainAnchorResult> {
  return lookupTransparencyAnchor(anchorAddress, declaration.hash, options);
}

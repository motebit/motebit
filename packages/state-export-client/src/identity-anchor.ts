/**
 * On-chain cross-check for the identity-transparency log root.
 *
 * The relay's `/identity` bundle carries a Merkle inclusion proof against an
 * `anchoredRoot` it claims to have posted on-chain. `@motebit/crypto`'s
 * `verifyIdentityBindingAnchored` proves the leaf is included under that root —
 * but nothing stops a relay from fabricating a root it never anchored. This
 * module closes that gap the same way `lookupTransparencyAnchor` closes the TOFU
 * gap on the transparency declaration: scan the relay's pinned Solana address for
 * a memo that actually carries that exact root.
 *
 * The relay anchors identity-log roots through the generic `ChainAnchorSubmitter`
 * memo (`motebit:anchor:v1:{root}:{leafCount}`), shared with settlement and
 * credential anchoring. Matching by the EXACT root value is sound across that
 * shared stream: identity-binding leaves hash `{type:"motebit-identity-binding",
 * …}`, so a root over them is domain-separated from any settlement/credential
 * root and cannot collide. We don't need a dedicated memo prefix — only the root.
 *
 * The pinned `relayAnchorAddress` is the trust root: it MUST come from out-of-band
 * (canonical config / docs site / a known motebit-org keyring), NEVER from the
 * bundle itself — passing the relay's self-asserted address would be circular
 * trust, the same caveat the transparency anchor carries.
 *
 * No SDK dep — Solana JSON-RPC is plain HTTP-JSON over `fetch`, keeping the
 * package browser-safe and dep-thin. Mirrors `onchain-anchor.ts`.
 */

/** The generic anchor-memo prefix the relay's ChainAnchorSubmitter emits. */
const ANCHOR_MEMO_PREFIX = "motebit:anchor:v1:";

export interface IdentityAnchorLookupOptions {
  /** Solana JSON-RPC endpoint. Defaults to mainnet-beta; pin a known-good RPC. */
  readonly rpcUrl?: string;
  /** Inject `fetch`. Defaults to global `fetch`; tests pass a mock. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Max signatures to scan at the anchor address. Identity-log anchors share the
   * address with settlement/credential anchors, so the target root may be several
   * memos back; default 200 covers a generous window of recent anchoring.
   */
  readonly maxSignatures?: number;
}

export type IdentityAnchorResult =
  | {
      readonly ok: true;
      readonly txHash: string;
      readonly anchoredRoot: string;
      readonly relayAnchorAddress: string;
    }
  | {
      readonly ok: false;
      readonly reason: IdentityAnchorFailureReason;
      readonly detail?: string;
    };

export type IdentityAnchorFailureReason = "rpc_failed" | "root_not_anchored";

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
 * Confirm `expectedRootHex` was posted on-chain by the relay at
 * `relayAnchorAddress`. Returns a typed result — never throws on verification
 * failure; HTTP/transport errors surface as `rpc_failed`. A clean
 * `root_not_anchored` means the scan completed but no `motebit:anchor` memo at the
 * address carried that root (either never anchored, or beyond the scan window).
 *
 * The caller is expected to run this AFTER `verifyIdentityBindingAnchored` has
 * confirmed the leaf is included under `expectedRootHex` — this adds the second
 * trust channel (the root is really on-chain by the known relay) on top of the
 * inclusion proof; it does not replace it.
 */
export async function lookupIdentityLogAnchor(
  relayAnchorAddress: string,
  expectedRootHex: string,
  options: IdentityAnchorLookupOptions = {},
): Promise<IdentityAnchorResult> {
  const rpcUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const limit = options.maxSignatures ?? 200;
  const target = expectedRootHex.toLowerCase();

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

  for (const sig of signatures) {
    if (sig.err !== null) continue; // skip failed txs
    if (sig.memo == null) continue;

    // Solana RPC formats memo as `[<size> (len <bytes>)] <utf-8>`; match the
    // canonical prefix anywhere in the formatted string (robust across RPC
    // versions), then read the 64-hex root that immediately follows it.
    const idx = sig.memo.indexOf(ANCHOR_MEMO_PREFIX);
    if (idx === -1) continue;
    const after = sig.memo.slice(idx + ANCHOR_MEMO_PREFIX.length);
    const rootMatch = after.match(/^([0-9a-fA-F]{64})/);
    if (rootMatch == null) continue;

    if (rootMatch[1]!.toLowerCase() === target) {
      return { ok: true, txHash: sig.signature, anchoredRoot: target, relayAnchorAddress };
    }
  }

  return {
    ok: false,
    reason: "root_not_anchored",
    detail: `scanned ${signatures.length} signature(s) at ${relayAnchorAddress}, none carried root ${target}`,
  };
}

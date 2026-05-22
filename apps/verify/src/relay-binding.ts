/**
 * Relay-binding resolution for receipt.computer — fetch the producer's identity
 * material so a pasted receipt can climb past `integrity-only` to `pinned` /
 * `anchored`.
 *
 * The paste flow alone reaches `integrity-only` (the signature checks against the
 * receipt's OWN embedded key). To go higher the verifier needs the motebit's
 * identity chain (for `pinned`) and the relay's transparency-log inclusion proof
 * plus the pinned relay Solana address (for `anchored`). This module fetches both
 * from the relay and assembles the options `verifyReceiptDocument` consumes.
 *
 * Trust bootstrap — no separate out-of-band config. `fetchTransparencyAnchor`
 * TOFU-pins the relay's Ed25519 key (self-signed declaration). The relay's Solana
 * address is `base58(relayPublicKey)` by the Ed25519/Solana curve coincidence —
 * the same channel that pins the key yields the anchor address, and
 * `lookupIdentityLogAnchor` then confirms the log root sits on-chain there.
 *
 * Fail-closed: any failure (relay down, malformed bundle, anchor unverifiable)
 * returns `null`; the caller renders the honest `integrity-only` result. The
 * relay being unreachable never blocks the offline integrity check.
 */

import { fetchTransparencyAnchor, type ReceiptAnchorOptions } from "@motebit/state-export-client";
import {
  base58btcEncode,
  type IdentityLogInclusionProof,
  type MotebitIdentityFile,
  type SuccessionRecord,
} from "@motebit/crypto";

/** The relay's `GET /api/v1/identity/:motebitId` response (binding material). */
export interface IdentityBundle {
  readonly motebit_id: string;
  readonly created_at: string;
  readonly current_public_key: string;
  /** Guardian public key (hex), if registered — needed to verify a recovery rotation. */
  readonly guardian_public_key?: string;
  readonly succession: SuccessionRecord[];
  readonly anchored: {
    readonly proof: IdentityLogInclusionProof;
    readonly tx_hash: string;
    readonly network: string;
  } | null;
}

export interface ResolveBindingOptions {
  /** Relay base URL to fetch the transparency anchor + identity bundle from. */
  readonly relayBase: string;
  /** The producing motebit's id (from the receipt). */
  readonly motebitId: string;
  /** Inject `fetch` (tests pass a mock). Defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Solana RPC for the on-chain cross-check; defaults to mainnet-beta downstream. */
  readonly solanaRpc?: string;
}

export interface ResolvedBinding {
  readonly identity: MotebitIdentityFile;
  /**
   * The relay's pinned Solana address (base58 of its key). Always present — the
   * caller uses it for the on-chain revocation scan even when the motebit isn't
   * anchored (a revoked key poisons the integrity-only claim too).
   */
  readonly relayAnchorAddress: string;
  /** Present only when the relay has an on-chain-anchored binding for this motebit. */
  readonly anchor?: ReceiptAnchorOptions;
}

/** Minimal structural guard for the untrusted relay response. */
function isIdentityBundle(value: unknown): value is IdentityBundle {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  if (typeof b["motebit_id"] !== "string") return false;
  if (typeof b["created_at"] !== "string") return false;
  if (typeof b["current_public_key"] !== "string") return false;
  if (!Array.isArray(b["succession"])) return false;
  const anchored = b["anchored"];
  if (anchored === null) return true;
  if (typeof anchored !== "object") return false;
  const a = anchored as Record<string, unknown>;
  return typeof a["tx_hash"] === "string" && typeof a["proof"] === "object" && a["proof"] !== null;
}

/**
 * Reconstruct a verifier-usable identity file from the relay bundle. Only the
 * binding-relevant fields are real (`motebit_id`, `created_at`, the genesis
 * `public_key`, the succession chain) — `verifyKeyBindingAtTime` /
 * `verifyIdentityBindingAnchored` read nothing else. Governance/privacy/memory
 * are inert placeholders so the value satisfies `MotebitIdentityFile`.
 */
function reconstructIdentity(bundle: IdentityBundle): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: bundle.motebit_id,
    created_at: bundle.created_at,
    owner_id: "",
    identity: { algorithm: "Ed25519", public_key: bundle.current_public_key },
    // The guardian key is binding-relevant: verifyKeyBindingAtTime needs it to
    // check a guardian-recovery rotation (the spec's key-compromise mechanism).
    ...(bundle.guardian_public_key
      ? { guardian: { public_key: bundle.guardian_public_key, established_at: bundle.created_at } }
      : {}),
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "0",
      require_approval_above: "0",
      deny_above: "0",
      operator_mode: false,
    },
    privacy: { default_sensitivity: "none", retention_days: {}, fail_closed: true },
    memory: { half_life_days: 30, confidence_threshold: 0.5, per_turn_limit: 5 },
    devices: [],
    succession: bundle.succession,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Fetch and assemble the binding material for `motebitId` from `relayBase`, or
 * `null` on any failure (fail-closed). The returned `identity` enables the
 * `pinned` rung; `anchor` (present only when the relay reports an on-chain
 * binding) enables `anchored` — and `verifyReceiptDocument` only reaches
 * `anchored` if its own on-chain cross-check against `relayAnchorAddress` passes.
 */
export async function resolveReceiptBinding(
  options: ResolveBindingOptions,
): Promise<ResolvedBinding | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = stripTrailingSlash(options.relayBase);

  // 1. TOFU-pin the relay's identity key; its Solana address is base58 of it.
  const anchorRes = await fetchTransparencyAnchor(base, { fetch: fetchImpl });
  if (!anchorRes.ok) return null;
  const relayAnchorAddress = base58btcEncode(anchorRes.anchor.relayPublicKey);

  // 2. Fetch the identity bundle.
  let bundle: IdentityBundle;
  try {
    const res = await fetchImpl(`${base}/api/v1/identity/${encodeURIComponent(options.motebitId)}`);
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (!isIdentityBundle(json)) return null;
    bundle = json;
  } catch {
    return null;
  }

  // 3. Reconstruct identity (pinned) + assemble the anchor option (anchored).
  const identity = reconstructIdentity(bundle);
  if (bundle.anchored) {
    const anchor: ReceiptAnchorOptions = {
      proof: bundle.anchored.proof,
      relayAnchorAddress,
      lookup: {
        fetch: fetchImpl,
        ...(options.solanaRpc ? { rpcUrl: options.solanaRpc } : {}),
      },
    };
    return { identity, relayAnchorAddress, anchor };
  }
  return { identity, relayAnchorAddress };
}

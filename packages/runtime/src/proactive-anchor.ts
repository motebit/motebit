/**
 * Proactive-anchor resolver — surface-shared helper for wiring a
 * `proactiveAnchor` policy from a surface's persisted toggles + the
 * motebit's identity state.
 *
 * Lives in `@motebit/runtime` so desktop, web, and mobile all consume one
 * source of truth instead of inlining the same conditional. Three branches:
 *
 *   - proactive disabled OR no signing keys → undefined (no auto-anchor)
 *   - enabled + keys, no submitter injected → local-only policy
 *   - enabled + keys + an injected `ChainAnchorSubmitter` → on-chain policy
 *
 * The submitter is CONSTRUCTED BY THE CALLER (a surface builds
 * `createSolanaMemoSubmitter` from `@motebit/wallet-solana`) and injected here.
 * The runtime package owns the policy shape, not the chain provider — it stays
 * free of any settlement-rail dependency (the adapter principle: the interior
 * defines the port, the surface supplies the implementation). Construction
 * failure / "don't pay the bundle cost when off" is the caller's concern.
 */

import type { ChainAnchorSubmitter } from "@motebit/sdk";
import type { RuntimeConfig } from "./runtime-config.js";

export interface ResolveProactiveAnchorArgs {
  proactiveEnabled: boolean;
  signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined;
  /**
   * Caller-constructed chain anchor submitter (e.g. `createSolanaMemoSubmitter`
   * at the surface layer). `undefined` → local-only anchoring.
   */
  submitter?: ChainAnchorSubmitter;
}

export function resolveProactiveAnchor(
  args: ResolveProactiveAnchorArgs,
): RuntimeConfig["proactiveAnchor"] | undefined {
  if (!args.proactiveEnabled || !args.signingKeys) return undefined;
  return { submitter: args.submitter, batchThreshold: 8 };
}

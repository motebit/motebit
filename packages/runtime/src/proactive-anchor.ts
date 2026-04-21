/**
 * Proactive-anchor resolver — surface-shared helper for wiring a
 * `proactiveAnchor` policy from a surface's persisted toggles + the
 * motebit's identity state.
 *
 * Lives in `@motebit/runtime` so desktop, web, and mobile all consume
 * one source of truth instead of inlining the same conditional. Four
 * branches:
 *
 *   - proactive disabled OR no signing keys → undefined (no auto-anchor)
 *   - proactive enabled + keys + anchorOnchain=false → local-only policy
 *   - proactive enabled + keys + anchorOnchain=true → policy with
 *     `SolanaMemoSubmitter` constructed from the identity seed
 *   - submitter construction throws → falls through to local-only —
 *     no surprise crash
 *
 * `@motebit/wallet-solana` is dynamically imported so callers that
 * never enable on-chain anchoring don't pay the bundle cost.
 */

import type { ChainAnchorSubmitter } from "@motebit/sdk";
import type { RuntimeConfig } from "./index.js";

export interface ResolveProactiveAnchorArgs {
  proactiveEnabled: boolean;
  anchorOnchain: boolean;
  signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined;
  solanaRpcUrl: string;
}

export async function resolveProactiveAnchor(
  args: ResolveProactiveAnchorArgs,
): Promise<RuntimeConfig["proactiveAnchor"] | undefined> {
  if (!args.proactiveEnabled || !args.signingKeys) return undefined;
  let submitter: ChainAnchorSubmitter | undefined;
  if (args.anchorOnchain) {
    try {
      const { createSolanaMemoSubmitter } = await import("@motebit/wallet-solana");
      submitter = createSolanaMemoSubmitter({
        rpcUrl: args.solanaRpcUrl,
        identitySeed: args.signingKeys.privateKey,
      });
    } catch {
      // Submitter construction failure (shouldn't happen with valid
      // inputs) falls through to local-only anchoring.
    }
  }
  return { submitter, batchThreshold: 8 };
}

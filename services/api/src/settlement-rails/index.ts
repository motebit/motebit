/**
 * Settlement rail registry and barrel exports.
 *
 * Holds configured rails by name so route handlers can look up
 * the appropriate rail at runtime without coupling to specific implementations.
 */

import type { SettlementRail } from "@motebit/sdk";

export { StripeSettlementRail } from "./stripe-rail.js";
export type { StripeRailConfig } from "./stripe-rail.js";
export { X402SettlementRail } from "./x402-rail.js";
export type { X402RailConfig, X402FacilitatorClient } from "./x402-rail.js";
export { BridgeSettlementRail } from "./bridge-rail.js";
export type { BridgeRailConfig, BridgeClient, BridgeTransfer } from "./bridge-rail.js";
export { DirectAssetRail, InsufficientOnchainBalanceError } from "./direct-asset-rail.js";
export type { DirectAssetRailConfig, WalletProvider } from "./direct-asset-rail.js";
export { PrivyWalletProvider, InMemoryWalletStore } from "./privy-wallet-provider.js";
export type { PrivyWalletProviderConfig, WalletStore } from "./privy-wallet-provider.js";

export class SettlementRailRegistry {
  private readonly rails = new Map<string, SettlementRail>();

  /** Register a rail. Replaces any existing rail with the same name. */
  register(rail: SettlementRail): void {
    this.rails.set(rail.name, rail);
  }

  /** Get a rail by name (e.g., "stripe", "x402-base"). */
  get(name: string): SettlementRail | undefined {
    return this.rails.get(name);
  }

  /** Get all rails of a given type (e.g., all "fiat" rails). */
  getByType(type: string): SettlementRail[] {
    const result: SettlementRail[] = [];
    for (const rail of this.rails.values()) {
      if (rail.railType === type) result.push(rail);
    }
    return result;
  }

  /** List all registered rails. */
  list(): SettlementRail[] {
    return [...this.rails.values()];
  }
}

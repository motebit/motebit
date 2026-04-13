/**
 * Settlement rail registry and barrel exports.
 *
 * The registry accepts only GuestRails — relay-custody rails that the relay
 * mediates on behalf of agents. SovereignRails (agent-custody, e.g. SolanaWalletRail)
 * live in the runtime and are never registered at the relay; the compiler
 * rejects attempts to pass one to `register()`. That mechanical rejection is
 * the sovereignty doctrine expressed as a type.
 */

import type { GuestRail } from "@motebit/sdk";

export { StripeSettlementRail } from "./stripe-rail.js";
export type { StripeRailConfig } from "./stripe-rail.js";
export { X402SettlementRail } from "./x402-rail.js";
export type { X402RailConfig, X402FacilitatorClient } from "./x402-rail.js";
export { BridgeSettlementRail } from "./bridge-rail.js";
export type { BridgeRailConfig, BridgeClient, BridgeTransfer } from "./bridge-rail.js";

export class SettlementRailRegistry {
  private readonly rails = new Map<string, GuestRail>();

  /** Register a guest rail. Replaces any existing rail with the same name. */
  register(rail: GuestRail): void {
    this.rails.set(rail.name, rail);
  }

  /** Get a rail by name (e.g., "stripe", "x402-base"). */
  get(name: string): GuestRail | undefined {
    return this.rails.get(name);
  }

  /** Get all rails of a given type (e.g., all "fiat" rails). */
  getByType(type: string): GuestRail[] {
    const result: GuestRail[] = [];
    for (const rail of this.rails.values()) {
      if (rail.railType === type) result.push(rail);
    }
    return result;
  }

  /** List all registered rails. */
  list(): GuestRail[] {
    return [...this.rails.values()];
  }

  /**
   * Structured manifest for health/readiness reporting and boot-time logging.
   * Pure metadata — no network probes. Use `isAvailable()` on individual rails
   * when provider reachability matters.
   *
   * Sovereign rails never appear here. The manifest describes what the relay
   * can mediate, not what the agent can do on its own behalf.
   */
  manifest(): ReadonlyArray<{
    name: string;
    custody: "relay";
    railType: GuestRail["railType"];
    supportsDeposit: boolean;
  }> {
    return [...this.rails.values()].map((rail) => ({
      name: rail.name,
      custody: rail.custody,
      railType: rail.railType,
      supportsDeposit: rail.supportsDeposit,
    }));
  }
}

/**
 * BridgeSettlementRail — Bridge.xyz orchestration as a treasury-only GuestRail.
 *
 * Wraps Bridge's transfer API behind the `GuestRail` interface, but
 * deliberately does NOT implement `WithdrawableGuestRail`. The
 * `supportsWithdraw: false` discriminant + the structural absence of
 * `withdraw()` from this class is the doctrinal embodiment of the
 * off-ramp principle: Motebit is not a transmitter of user funds. Bridge
 * stays registered for own-account treasury conversion (via the
 * sibling `BridgeOfframpAdapter` consumed at the relay's offramp routes)
 * — never as a user-facing withdrawal target.
 *
 * The `withdraw()` method was removed in Arc 1 Commit 2 of the off-ramp
 * arc (see `docs/doctrine/settlement-rails.md` § "Lanes for external
 * readers" and the future `off-ramp-as-user-action.md`). Anyone who
 * attempts to call `bridgeRail.withdraw(...)` hits a compile error;
 * narrowing `railRegistry.get("bridge")` through `isWithdrawableRail()`
 * (the only sanctioned path to a withdraw call) returns false. The
 * negative-proof is the absence itself.
 *
 * The `BridgeClient.createTransfer` capability still exists on the
 * client interface — future treasury-conversion methods will compose
 * with it (e.g., `convertOwnAccount(amount)` that calls createTransfer
 * with `on_behalf_of: MotebitCustomerId`, `from: motebit_treasury`,
 * `to: motebit_mercury_account` — same-party in/out). Today this rail
 * exposes only `isAvailable()` + `attachProof()` from the `GuestRail`
 * surface; the only consumer is the registry slot itself.
 *
 * Metabolic principle: absorbs Bridge's REST API through a thin BridgeClient
 * interface. Does not reimplement the transfer state machine.
 */

import type { GuestRail, PaymentProof } from "@motebit/sdk";
import { type RailLogger, NOOP_LOGGER } from "./logger.js";

/**
 * Minimal Bridge client interface.
 * The real Bridge REST client satisfies this. Tests inject a mock.
 * The rail absorbs the API — does not reimplement it.
 */
export interface BridgeClient {
  /**
   * Create a transfer.
   * Maps to POST /transfers on Bridge's API.
   */
  createTransfer(params: {
    onBehalfOf: string;
    amount: string;
    sourceCurrency: string;
    sourcePaymentRail: string;
    destinationCurrency: string;
    destinationPaymentRail: string;
    destinationAddress?: string;
    externalAccountId?: string;
    idempotencyKey: string;
  }): Promise<BridgeTransfer>;

  /**
   * Get transfer status by ID.
   * Maps to GET /transfers/{transferID}.
   */
  getTransfer(transferId: string): Promise<BridgeTransfer>;

  /**
   * Health check — verifies API key is valid and API is reachable.
   */
  isReachable(): Promise<boolean>;
}

/** Bridge transfer object (subset of fields we need). */
export interface BridgeTransfer {
  id: string;
  state: string;
  amount: string;
  receipt?: {
    sourceTxHash?: string;
    destinationTxHash?: string;
  };
  source?: {
    paymentRail: string;
  };
  destination?: {
    paymentRail: string;
  };
}

export interface BridgeRailConfig {
  /** Bridge API client instance. */
  bridgeClient: BridgeClient;
  /** Bridge customer ID for the relay operator. Used by future treasury-conversion methods. */
  customerId: string;
  /** Source payment rail for treasury operations (e.g., "base"). */
  sourcePaymentRail: string;
  /** Source currency for treasury operations (e.g., "usdc"). */
  sourceCurrency: string;
  /** Callback to persist proof. Injected by relay — the rail does not own storage. */
  onProofAttached?: (settlementId: string, proof: PaymentProof) => void;
  /** Structured logger. Default is silent — relay injects one carrying correlation id. */
  logger?: RailLogger;
}

export class BridgeSettlementRail implements GuestRail {
  readonly custody = "relay" as const;
  readonly railType = "orchestration" as const;
  readonly name = "bridge";
  readonly supportsDeposit = false as const;
  // Doctrinal absence — see file header. Bridge is treasury-only; user-
  // facing withdrawal is structurally impossible because `withdraw()`
  // does not exist on this class. `isWithdrawableRail(bridgeRail)`
  // returns false on the discriminant alone, before reaching the
  // method-presence check.
  readonly supportsWithdraw = false as const;
  readonly supportsBatch = false as const;

  // Client retained for `isAvailable()` (the only GuestRail-surface method
  // that still reads from it). Customer ID + source rail/currency are
  // retained for future treasury-conversion methods (e.g.,
  // `convertOwnAccount(amount)` mapping to
  // `Bridge.createTransfer({on_behalf_of: MotebitCustomerId, ...})`
  // — same-party in/out, no third-party transmission). The treasury arc
  // lands those; today the class participates in the rail registry for
  // health checks + proof callback wiring only.
  private readonly client: BridgeClient;
  // @ts-expect-error TS6133 — held for the treasury arc, see file header
  private readonly customerId: string;
  // @ts-expect-error TS6133 — held for the treasury arc, see file header
  private readonly sourcePaymentRail: string;
  // @ts-expect-error TS6133 — held for the treasury arc, see file header
  private readonly sourceCurrency: string;
  private readonly onProofAttached?: (settlementId: string, proof: PaymentProof) => void;
  private readonly logger: RailLogger;

  constructor(config: BridgeRailConfig) {
    this.client = config.bridgeClient;
    this.customerId = config.customerId;
    this.sourcePaymentRail = config.sourcePaymentRail;
    this.sourceCurrency = config.sourceCurrency;
    this.onProofAttached = config.onProofAttached;
    this.logger = config.logger ?? NOOP_LOGGER;
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.client.isReachable();
    } catch {
      return false;
    }
  }

  attachProof(settlementId: string, proof: PaymentProof): Promise<void> {
    this.logger.info("bridge.proof.attached", {
      settlementId,
      reference: proof.reference,
      network: proof.network,
      railType: proof.railType,
    });
    this.onProofAttached?.(settlementId, proof);
    return Promise.resolve();
  }
}

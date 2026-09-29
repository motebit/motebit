/**
 * OperatorSolanaTransfer — the operator-side companion to `SolanaWalletRail`.
 *
 * The relay treasury IS a sovereign Solana wallet by the same mathematical
 * accident that makes every agent's identity key a Solana wallet: Solana
 * uses Ed25519, and the relay's Ed25519 identity key (the same key it
 * already uses for `SolanaMemoSubmitter` anchoring) is natively a valid
 * Solana keypair.
 *
 * This primitive exists so the relay can perform two doctrinally-clean
 * USDC transfers from its own treasury wallet:
 *   1. **Same-party return of custody** — a user deposited USDC to the
 *      operator-balance virtual account from their sovereign wallet;
 *      withdrawal returns that custody to the same user's wallet. The
 *      relay is the principal of its own onchain transfer.
 *   2. **Direct delegator→worker pay-out leg** (future arc) — composing
 *      the 5% fee transfer alongside worker settlement when both happen
 *      from the relay's perspective.
 *
 * The structural distinction from `SolanaWalletRail`:
 *   - `SolanaWalletRail` is `custody: "agent"` — the agent's identity
 *     key signs the agent's own transfers; `SettlementRailRegistry`
 *     rejects it at compile time per `services/relay/CLAUDE.md` rule 2.
 *   - `OperatorSolanaTransfer` is NOT a `SovereignRail` and carries no
 *     `custody` label. It is the relay-treasury primitive: the relay
 *     signs its own wallet's transfers from its own custody. There is
 *     no agent-on-whose-behalf to displace.
 *
 * The deleted `DirectAssetRail` (2026-04-08) was the wrong shape because
 * the relay was signing **on behalf of an agent** — the agent's funds,
 * the relay's signature. That is custodial agent-banking. The operator
 * primitive here signs **for the relay itself** — relay's funds, relay's
 * signature, native principal. The negative-doctrine forbids the former;
 * the latter is doctrinally indistinguishable from the relay paying a
 * vendor invoice from its treasury wallet.
 *
 * Internally delegates to the same `Web3JsRpcAdapter` that backs the
 * sovereign rail — the adapter is custody-neutral by design (it signs
 * from whichever seed it's constructed with). The custody distinction
 * lives at the construction-site type (this class vs `SolanaWalletRail`),
 * not at the wire / RPC primitive.
 */

import { Web3JsRpcAdapter } from "./web3js-adapter.js";
import type {
  BroadcastHooks,
  SendUsdcResult,
  SignatureOutcome,
  SignedTransactionRef,
  SolanaRpcAdapter,
} from "./adapter.js";

export interface OperatorSolanaTransferConfig {
  /** Solana RPC endpoint URL. Same value as `SOLANA_RPC_URL` used by the memo submitter. */
  rpcUrl: string;
  /**
   * 32-byte Ed25519 seed — the relay's identity private key. The treasury
   * address derives directly via `Keypair.fromSeed`. Same key that already
   * funds `SolanaMemoSubmitter` for anchoring; the treasury and the
   * anchor-submitter are the same Solana wallet by curve coincidence.
   */
  identitySeed: Uint8Array;
  /** USDC SPL mint (base58). Defaults to mainnet USDC. */
  usdcMint?: string;
  /** RPC commitment level. Defaults to "confirmed". */
  commitment?: "processed" | "confirmed" | "finalized";
}

/**
 * Operator-side USDC sending primitive. Construct once at relay boot
 * via the factory; call `sendUsdc` from the withdrawal-path dispatch
 * when the destination is a Solana sovereign wallet.
 *
 * The constructor accepts a pre-built `SolanaRpcAdapter` for test
 * injection; production wiring goes through `createOperatorSolanaTransfer`
 * which builds the default `Web3JsRpcAdapter` from config. Same shape
 * as `SolanaWalletRail` so the adapter boundary stays test-mockable.
 */
export class OperatorSolanaTransfer {
  constructor(private readonly adapter: SolanaRpcAdapter) {}

  /** The relay treasury's own base58 Solana address. */
  get address(): string {
    return this.adapter.ownAddress;
  }

  /** Treasury USDC balance in micro-units (6 decimals). */
  getUsdcBalance(): Promise<bigint> {
    return this.adapter.getUsdcBalance();
  }

  /** Treasury SOL balance in lamports (the relay pays its own gas). */
  getSolBalance(): Promise<bigint> {
    return this.adapter.getSolBalance();
  }

  /**
   * Send USDC from the relay treasury to a recipient sovereign wallet.
   * Amount in micro-units. Returns the transaction signature once the
   * network reaches the configured commitment.
   *
   * Throws `InsufficientUsdcBalanceError` when the treasury balance is
   * below `microAmount`. Throws `InvalidSolanaAddressError` when
   * `toAddress` is not a valid base58 public key.
   */
  sendUsdc(
    toAddress: string,
    microAmount: bigint,
    hooks?: BroadcastHooks,
  ): Promise<SendUsdcResult> {
    return hooks === undefined
      ? this.adapter.sendUsdc({ toAddress, microAmount })
      : this.adapter.sendUsdc({ toAddress, microAmount }, hooks);
  }

  /**
   * True only when every transaction `sendUsdc` signs is reported to
   * `hooks.beforeBroadcast` BEFORE it is sent, and the chain can be asked
   * about each one (#885, #949). Only then can a payer that recorded every
   * reported signature prove from the chain alone whether its payout
   * landed, and read "no signature recorded" as "nothing was sent". A payer
   * must not send a payout it cannot later prove this way.
   */
  get recordsBroadcasts(): boolean {
    // Round 3: reading an outcome is not enough — "absent" proves nothing
    // without the node's retained-history edge, so an adapter that cannot
    // read it could never prove a payout unpaid, and the payout would have
    // no door.
    return (
      this.adapter.honorsBroadcastHooks === true &&
      typeof this.adapter.getSignatureOutcome === "function" &&
      typeof this.adapter.getLocalLedgerFirstSlot === "function"
    );
  }

  /**
   * What the chain says about one transaction this treasury signed (#885).
   * Read-only. An adapter that cannot answer reports `rpc_error` — never
   * absence.
   */
  getSignatureOutcome(tx: SignedTransactionRef): Promise<SignatureOutcome> {
    if (typeof this.adapter.getSignatureOutcome !== "function") {
      return Promise.resolve({
        status: "rpc_error",
        reason: "adapter cannot read signature outcomes",
      });
    }
    return this.adapter.getSignatureOutcome(tx);
  }

  /**
   * The node's LOCAL ledger edge (`minimumLedgerSlot`, #949 round 4): the
   * lower edge of what an "absent" read can speak for. Rejects when it
   * cannot be read.
   */
  getLocalLedgerFirstSlot(): Promise<number> {
    if (typeof this.adapter.getLocalLedgerFirstSlot !== "function") {
      return Promise.reject(new Error("adapter cannot read the node's local ledger edge"));
    }
    return this.adapter.getLocalLedgerFirstSlot();
  }

  /**
   * The chain's current block height (#949). Rejects when it cannot be read
   * — a caller must never substitute a guess (or the wall clock) for it.
   */
  getBlockHeight(): Promise<number> {
    if (typeof this.adapter.getBlockHeight !== "function") {
      return Promise.reject(new Error("adapter cannot read the block height"));
    }
    return this.adapter.getBlockHeight();
  }

  /** Whether the RPC endpoint is reachable right now. */
  isAvailable(): Promise<boolean> {
    return this.adapter.isReachable();
  }
}

/**
 * Construct an `OperatorSolanaTransfer` backed by the default
 * `Web3JsRpcAdapter`. Production wiring goes through this factory.
 */
export function createOperatorSolanaTransfer(
  config: OperatorSolanaTransferConfig,
): OperatorSolanaTransfer {
  const adapter = new Web3JsRpcAdapter({
    rpcUrl: config.rpcUrl,
    identitySeed: config.identitySeed,
    usdcMint: config.usdcMint,
    commitment: config.commitment,
  });
  return new OperatorSolanaTransfer(adapter);
}

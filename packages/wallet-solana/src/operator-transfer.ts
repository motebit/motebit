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
  DurableBroadcastHooks,
  DurableNonceLane,
  DurableSendResult,
  FinalizedSignatureStatus,
  NonceKillResult,
  NonceLaneState,
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
  /** The payout nonce lane's seed suffix (`nonceSeedFor`) — rotate it to escape a squatted address. */
  nonceSeedSuffix?: string;
}

/**
 * Operator-side USDC sending primitive. Construct once at relay boot
 * via the factory; call `sendPayout` from the withdrawal-path dispatch
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
   * True only when the adapter can make a payout the payer can later DECIDE
   * from consensus rules (#990): it reports every transaction it signs to
   * `hooks.beforeBroadcast` before sending it, signs payouts over the
   * treasury's durable nonce (so they never expire and exactly one
   * transaction per nonce value can land), can broadcast the kill for a
   * nonce value, and can read a signature's FINALIZED status. A payer must
   * not send a payout it cannot decide this way.
   */
  get recordsBroadcasts(): boolean {
    const a = this.adapter;
    return (
      a.honorsBroadcastHooks === true &&
      typeof a.prepareNonceLane === "function" &&
      typeof a.sendUsdcDurable === "function" &&
      typeof a.broadcastNonceKill === "function" &&
      typeof a.getFinalizedStatus === "function"
    );
  }

  /**
   * The treasury's durable-nonce lane (#990), created if absent, read at
   * finalized commitment. `unavailable` ⇒ send nothing.
   */
  prepareNonceLane(): Promise<NonceLaneState> {
    if (typeof this.adapter.prepareNonceLane !== "function") {
      return Promise.resolve({ status: "unavailable", reason: "adapter has no nonce lane" });
    }
    return this.adapter.prepareNonceLane();
  }

  /**
   * Send USDC from the relay treasury to a recipient sovereign wallet as a
   * durable-nonce payout over `lane` (#990). Amount in micro-units.
   * Throws `InsufficientUsdcBalanceError` / `InvalidSolanaAddressError` only
   * before anything is recorded or sent; afterwards it resolves with the
   * transaction and the finalized status its bounded wait last read.
   */
  sendPayout(
    toAddress: string,
    microAmount: bigint,
    lane: DurableNonceLane,
    hooks?: DurableBroadcastHooks,
  ): Promise<DurableSendResult> {
    if (typeof this.adapter.sendUsdcDurable !== "function") {
      return Promise.reject(new Error("adapter cannot send a durable-nonce payout"));
    }
    return this.adapter.sendUsdcDurable({ toAddress, microAmount }, lane, hooks);
  }

  /** Broadcast the kill for `lane.nonceValue` (#990): once finalized, no payout over it can land. */
  broadcastNonceKill(
    lane: DurableNonceLane,
    hooks?: DurableBroadcastHooks,
  ): Promise<NonceKillResult> {
    if (typeof this.adapter.broadcastNonceKill !== "function") {
      return Promise.reject(new Error("adapter cannot broadcast a nonce kill"));
    }
    return this.adapter.broadcastNonceKill(lane, hooks);
  }

  /**
   * One signature's FINALIZED status (#990). An adapter that cannot read it
   * reports `unknown` — never absence as evidence.
   */
  getFinalizedStatus(signature: string): Promise<FinalizedSignatureStatus> {
    if (typeof this.adapter.getFinalizedStatus !== "function") {
      return Promise.resolve({
        status: "unknown",
        reason: "rpc_error",
        detail: "adapter cannot read finalized statuses",
      });
    }
    return this.adapter.getFinalizedStatus(signature);
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
    ...(config.nonceSeedSuffix !== undefined ? { nonceSeedSuffix: config.nonceSeedSuffix } : {}),
  });
  return new OperatorSolanaTransfer(adapter);
}

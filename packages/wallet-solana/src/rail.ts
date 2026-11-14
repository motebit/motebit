/**
 * SolanaWalletRail — the public, motebit-shaped interface to a
 * sovereign Solana USDC wallet. Implements `SovereignRail` from
 * `@motebit/protocol` — custody is "agent", the rail is not registered
 * at the relay, and the identity key signs every transaction.
 *
 * The rail is deliberately tiny: chain, asset, address, plus three
 * methods that delegate to the SolanaRpcAdapter. All Solana-specific
 * code lives in the adapter, never here. This keeps the rail timeless
 * (the same shape will work for Aptos, Sui, or any future Ed25519
 * chain) and the boundary swappable (web3.js today, kit tomorrow).
 *
 * The address is derived from the motebit's identity Ed25519 secret
 * key. There is no second key, no key derivation ceremony, and no
 * vendor: the agent's identity public key IS its Solana address.
 */

import type {
  SovereignWalletRail,
  SovereignP2pPaymentRequest,
  P2pPaymentProof,
} from "@motebit/protocol";
import type { BroadcastHooks, SignedTransactionRef, SolanaRpcAdapter } from "./adapter.js";
import type { SendUsdcResult, SendUsdcBatchItemResult } from "./adapter.js";
import { Web3JsRpcAdapter } from "./web3js-adapter.js";
import {
  buildP2pPaymentProof,
  p2pPaymentLegs,
  assembleP2pPaymentProof,
  type BuildP2pPaymentProofArgs,
} from "./p2p-payment-proof.js";
import {
  InsufficientSolForGasError,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
} from "./constants.js";

export type SendResult = SendUsdcResult;

/**
 * How long after a failed `send` a transaction it broadcast could still
 * land. A Solana transaction is valid for ~151 blocks after its blockhash
 * (~60-90s); 150s is that window with a wide margin for slow slots. After
 * it, a transfer not visible onchain will never be (#887).
 */
export const SOLANA_TX_LANDING_HORIZON_MS = 150_000;

/** Input to {@link SolanaWalletRail.confirmSend}. */
export interface ConfirmSendQuery {
  toAddress: string;
  microAmount: bigint;
  /** Epoch ms when `send` was called — the lookup window starts here. */
  sentAtMs: number;
  /** Epoch ms when `send` threw — the landing horizon runs from here. */
  failedAtMs: number;
  /** What `send` threw. */
  error: unknown;
  /** Signatures the caller already accounts for (its own earlier payments). */
  excludeSignatures?: readonly string[];
}

/** Closed verdict of {@link SolanaWalletRail.confirmSend}. */
export type SendConfirmation =
  | { status: "landed"; signature: string }
  | { status: "absent" }
  | { status: "pending"; recheckAtMs: number }
  | { status: "unknown"; reason: string };

/** Input to {@link SolanaWalletRail.confirmP2pPayment}. */
export interface ConfirmP2pPaymentQuery {
  /** The payment request `buildP2pPayment` was called with — a landed tx must pay exactly it. */
  request: SovereignP2pPaymentRequest;
  /**
   * THE transaction this payer signed, as reported to it by
   * `buildP2pPayment`'s `beforeBroadcast` hook before sending. The verdict
   * is about this transaction only — never about some other transaction
   * whose transfers happen to look the same.
   */
  transaction: SignedTransactionRef;
}

/** How long to wait before asking again about a still-pending transaction. */
const P2P_PENDING_RECHECK_MS = 5_000;

/**
 * Closed verdict of {@link SolanaWalletRail.confirmP2pPayment}. `landed`
 * carries the full proof, assembled exactly as `buildP2pPayment` would have
 * returned it for that transaction.
 */
export type P2pPaymentConfirmation =
  | { status: "landed"; proof: P2pPaymentProof }
  | { status: "absent" }
  /** `seen`: a node reported it in a block — never accept a later `absent` for it. */
  | { status: "pending"; recheckAtMs: number; seen?: true }
  | { status: "unknown"; reason: string };

/**
 * Minimum SOL balance in lamports to consider gas sufficient.
 * 5_000_000 lamports = 0.005 SOL ≈ enough for ~1000 transactions.
 */
import { GAS_FLOOR_LAMPORTS } from "./jupiter.js";

/**
 * Amount of USDC micro-units the (disabled) gas top-up would swap.
 * 2_000_000 micro = $2.00. The swap itself refuses — see `./jupiter.ts`.
 */
const GAS_SWAP_USDC_MICRO = 2_000_000n;

export interface SolanaWalletRailConfig {
  /** Solana RPC endpoint URL (mainnet-beta, devnet, or custom). */
  rpcUrl: string;
  /**
   * 32-byte Ed25519 seed — the motebit's identity private key.
   * The Solana keypair (and address) is derived from this seed
   * directly via Keypair.fromSeed.
   */
  identitySeed: Uint8Array;
  /** USDC SPL mint (base58). Defaults to mainnet USDC. */
  usdcMint?: string;
  /** RPC commitment level. Defaults to "confirmed". */
  commitment?: "processed" | "confirmed" | "finalized";
  /**
   * @deprecated Has no effect — no replacement; rework the caller to drop
   * the field. Automatic gas is OFF and cannot be turned on from here.
   *
   * Reason: the automatic top-up signed a Jupiter-built transaction with the
   * identity key without inspecting it. Jupiter swaps are refused until an
   * intent-bound transaction validator exists (`./jupiter.ts`), so a wallet
   * below the gas floor must be funded with SOL directly — a transfer then
   * fails closed with `InsufficientSolForGasError` before anything is signed.
   */
  disableAutoGas?: boolean;
}

export class SolanaWalletRail implements SovereignWalletRail {
  /** Stable rail vocabulary — independent of which chain library is used. */
  readonly custody = "agent" as const;
  readonly name = "solana-wallet" as const;
  readonly chain = "solana" as const;
  readonly asset = "USDC" as const;

  private readonly autoGas: boolean;
  private readonly web3Adapter: Web3JsRpcAdapter | null;
  private readonly now: () => number;

  /**
   * After `buildP2pPayment` threw: did THIS payer's transaction land? (#885)
   * See {@link confirmOwnP2pPayment}. PRESENT ONLY when the adapter declares
   * `honorsBroadcastHooks` — i.e. every transaction it signs is reported
   * through `beforeBroadcast` before it is sent. A payer reads "no signature
   * reported" as "nothing was sent" only when this is present; over an
   * adapter that does not report, the confirmer is absent and every failed
   * build is undecidable (the caller must not pay again).
   */
  readonly confirmP2pPayment?: (query: ConfirmP2pPaymentQuery) => Promise<P2pPaymentConfirmation>;

  constructor(
    private readonly adapter: SolanaRpcAdapter,
    opts?: { autoGas?: boolean; now?: () => number },
  ) {
    this.autoGas = opts?.autoGas ?? false;
    this.now = opts?.now ?? Date.now;
    this.web3Adapter = adapter instanceof Web3JsRpcAdapter ? adapter : null;
    if (adapter.honorsBroadcastHooks === true) {
      this.confirmP2pPayment = (query) => this.confirmOwnP2pPayment(query);
    }
  }

  /** The wallet's own base58 address. Equivalent to the motebit identity public key. */
  get address(): string {
    return this.adapter.ownAddress;
  }

  /** USDC balance in micro-units (6 decimals, same as motebit money). */
  getBalance(): Promise<bigint> {
    return this.adapter.getUsdcBalance();
  }

  /** Native SOL balance in lamports. */
  getSolBalance(): Promise<bigint> {
    return this.adapter.getSolBalance();
  }

  /**
   * Is there enough SOL for gas? True at or above the floor. Below it,
   * false — the automatic USDC → SOL top-up is disabled: the Jupiter swap
   * refuses before any network call or signature (`./jupiter.ts`), and a
   * rail constructed with the legacy `autoGas: true` reaches only that
   * refusal.
   */
  async ensureGas(): Promise<boolean> {
    return (await this.gasStatus()).ok;
  }

  private async gasStatus(): Promise<{ ok: boolean; balance: bigint }> {
    const balance = await this.adapter.getSolBalance();
    if (balance >= GAS_FLOOR_LAMPORTS) return { ok: true, balance };
    if (!this.autoGas || !this.web3Adapter) return { ok: false, balance };

    try {
      const { swapUsdcToSol } = await import("./jupiter.js");
      await swapUsdcToSol(
        GAS_SWAP_USDC_MICRO,
        this.web3Adapter.getKeypair(),
        this.web3Adapter.getConnection(),
        this.web3Adapter.getCommitment(),
        this.web3Adapter.getUsdcMint(),
      );
      return { ok: true, balance };
    } catch {
      // The swap refuses (JupiterSwapDisabledError) — the honest state is
      // "not enough gas", which the caller turns into a refusal.
      return { ok: false, balance };
    }
  }

  /**
   * Refuse, before anything is signed, a transfer the wallet cannot pay the
   * network fee for. Without this the transaction would be signed and only
   * then fail at preflight or onchain.
   */
  private async requireGas(): Promise<void> {
    const { ok, balance } = await this.gasStatus();
    if (!ok) throw new InsufficientSolForGasError(balance, GAS_FLOOR_LAMPORTS);
  }

  /**
   * Owner-invoked SOL → USDC swap. DISABLED: the Jupiter adapter refuses
   * with `JupiterSwapDisabledError` before any network call or signature,
   * until an intent-bound transaction validator exists. Kept so the
   * `wallet swap` affordance receives the typed refusal.
   */
  async swapSolToUsdc(solLamports: bigint): Promise<import("./jupiter.js").JupiterSwapResult> {
    if (!this.web3Adapter) {
      throw new Error(
        "swap unavailable: this rail was constructed without a web3 adapter (createSolanaWalletRail provides one).",
      );
    }
    const { swapSolToUsdc } = await import("./jupiter.js");
    return swapSolToUsdc(
      solLamports,
      this.web3Adapter.getKeypair(),
      this.web3Adapter.getConnection(),
      this.web3Adapter.getCommitment(),
      this.web3Adapter.getUsdcMint(),
    );
  }

  /**
   * Send USDC to a counterparty Solana address. Amount in micro-units.
   * Refuses with `InsufficientSolForGasError`, before signing, when SOL is
   * below the gas floor. Returns the transaction signature once the network
   * confirms it.
   */
  async send(toAddress: string, microAmount: bigint): Promise<SendResult> {
    await this.requireGas();
    return this.adapter.sendUsdc({ toAddress, microAmount });
  }

  /**
   * Send USDC to multiple counterparties in as few Solana transactions
   * as possible. One transaction with N transfer instructions pays one
   * base fee instead of N — the endgame shape for multi-hop settlement
   * payout on the sovereign rail.
   *
   * Chunking to fit Solana's 1232-byte tx limit is handled internally
   * by the adapter. Fail-fast: if any chunk fails, remaining items are
   * not submitted. Per-item results indicate what landed.
   */
  async sendBatch(
    items: ReadonlyArray<{ toAddress: string; microAmount: bigint }>,
  ): Promise<SendUsdcBatchItemResult[]> {
    await this.requireGas();
    return this.adapter.sendUsdcBatch(items);
  }

  /**
   * Build a P2P payment proof: broadcast the worker leg + relay-fee leg(s)
   * in ONE atomic transaction and return the verifiable proof. This is what
   * lets a paid direct delegation satisfy the relay's Arc-3.5 P2P-proof gate.
   *
   * Delegates to `buildP2pPaymentProof` (the canonical multi-leg builder) so
   * the atomicity guarantee + proof assembly live in exactly one place — the
   * rail only layers the gas-floor refusal on top. Two legs for single-operator P2P
   * (worker + relay treasury); three for cross-operator federated P2P when
   * the executor-relay fields are present.
   *
   * `hooks.beforeBroadcast` (#885) is told each transaction's signature
   * after signing and before sending. A payer records it there, so a throw
   * afterwards is resolved by asking about that exact transaction
   * (`confirmP2pPayment`); if the hook throws, nothing is sent.
   */
  async buildP2pPayment(
    request: SovereignP2pPaymentRequest,
    hooks?: BroadcastHooks,
  ): Promise<P2pPaymentProof> {
    await this.requireGas();
    return buildP2pPaymentProof(this.adapter, proofArgs(request), hooks);
  }

  /**
   * After `send` threw: did the payment land anyway? (#887)
   *
   * A thrown `send` is not proof that no money moved — the transaction may
   * have landed and only the confirmation was lost. A payer that reads the
   * throw as "not paid" and pays someone else pays twice. This read (it
   * never signs or broadcasts) is what a payer consults before any
   * retry:
   *
   *   - `landed` — exactly one matching transfer from this wallet landed
   *     since the send began; the payment happened, with that signature.
   *   - `absent` — authoritatively not paid: the error is one `sendUsdc`
   *     throws only before signing, or no match is visible after
   *     `SOLANA_TX_LANDING_HORIZON_MS` (every blockhash the send could
   *     have used has expired, so nothing it broadcast can still land).
   *   - `pending` — no match yet, but a broadcast could still land; look
   *     again at `recheckAtMs`.
   *   - `unknown` — the lookup could not decide (RPC error, ambiguous
   *     matches, an adapter without the lookup). A payer MUST NOT pay again.
   */
  async confirmSend(query: ConfirmSendQuery): Promise<SendConfirmation> {
    if (
      query.error instanceof InsufficientUsdcBalanceError ||
      query.error instanceof InsufficientSolForGasError ||
      query.error instanceof InvalidSolanaAddressError
    ) {
      return { status: "absent" };
    }
    if (typeof this.adapter.findOutgoingTransfer !== "function") {
      return { status: "unknown", reason: "this wallet adapter cannot look up past transfers" };
    }
    const lookup = await this.adapter.findOutgoingTransfer({
      toAddress: query.toAddress,
      microAmount: query.microAmount,
      sinceMs: query.sentAtMs,
      ...(query.excludeSignatures != null ? { excludeSignatures: query.excludeSignatures } : {}),
    });
    switch (lookup.status) {
      case "found":
        return { status: "landed", signature: lookup.signature };
      case "ambiguous":
        return {
          status: "unknown",
          reason: `${lookup.signatures.length} matching transfers since the send (${lookup.signatures.join(", ")})`,
        };
      case "rpc_error":
        return { status: "unknown", reason: lookup.reason };
      case "not_found": {
        const settledAt = query.failedAtMs + SOLANA_TX_LANDING_HORIZON_MS;
        if (this.now() >= settledAt) return { status: "absent" };
        return { status: "pending", recheckAtMs: settledAt };
      }
    }
  }

  /**
   * After `buildP2pPayment` threw: did THIS payer's transaction land? (#885)
   *
   * Bound to one signature — the one `buildP2pPayment` reported through its
   * `beforeBroadcast` hook before sending. It never looks for "a transaction
   * that pays these legs": two concurrent hires of the same worker at the
   * same price produce identical leg sets, and a leg match would hand one
   * hire the other's payment. Read-only: it never signs or broadcasts.
   *
   *   - `landed` — the transaction is confirmed, succeeded, and pays exactly
   *     the requested legs; `proof` is its proof.
   *   - `absent` — it can never move money: it is past its last valid block
   *     height and not on chain, or it landed and failed.
   *   - `pending` — not yet confirmed and still able to land.
   *   - `unknown` — undecidable (RPC error, an adapter without the status
   *     read, a landed transaction that does not pay the requested legs or
   *     cannot be read). A payer MUST NOT pay again.
   */
  private async confirmOwnP2pPayment(
    query: ConfirmP2pPaymentQuery,
  ): Promise<P2pPaymentConfirmation> {
    if (typeof this.adapter.getSignatureOutcome !== "function") {
      return {
        status: "unknown",
        reason: "this wallet adapter cannot read a transaction's status",
      };
    }
    const signature = query.transaction.signature;
    const outcome = await this.adapter.getSignatureOutcome(query.transaction);
    switch (outcome.status) {
      case "rpc_error":
        return { status: "unknown", reason: outcome.reason };
      case "pending":
        return {
          status: "pending",
          recheckAtMs: this.now() + P2P_PENDING_RECHECK_MS,
          ...(outcome.seen === true ? { seen: true as const } : {}),
        };
      case "failed":
      case "expired":
        return { status: "absent" };
      case "landed":
        break;
    }
    // Landed: money moved. It becomes this hire's payment proof only if the
    // transaction pays exactly what was requested.
    const args = proofArgs(query.request);
    let legs: Array<{ toAddress: string; microAmount: bigint }>;
    try {
      legs = p2pPaymentLegs(args);
    } catch (err: unknown) {
      return { status: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
    const tx = await this.adapter.getTransaction(signature);
    if (tx.status !== "confirmed") {
      return {
        status: "unknown",
        reason: `transaction ${signature} landed but could not be read (${tx.status === "rpc_error" ? tx.reason : "not found"})`,
      };
    }
    if (tx.from !== this.adapter.ownAddress || !paysExactly(tx.transfers, legs)) {
      return {
        status: "unknown",
        reason: `transaction ${signature} landed but does not pay exactly the requested legs`,
      };
    }
    return { status: "landed", proof: assembleP2pPaymentProof(args, signature) };
  }

  /** Whether the RPC endpoint is reachable right now. */
  isAvailable(): Promise<boolean> {
    return this.adapter.isReachable();
  }
}

/**
 * Does a confirmed transaction's transfer set equal `legs` exactly — same
 * recipients, same amounts, nothing else leaving the wallet?
 */
function paysExactly(
  transfers: ReadonlyArray<{ to: string; amountMicro: bigint }>,
  legs: ReadonlyArray<{ toAddress: string; microAmount: bigint }>,
): boolean {
  const remaining = [...transfers];
  for (const leg of legs) {
    const i = remaining.findIndex(
      (t) => t.to === leg.toAddress && t.amountMicro === leg.microAmount,
    );
    if (i < 0) return false;
    remaining.splice(i, 1);
  }
  return remaining.length === 0;
}

/** The builder's arguments for a rail-level request — one mapping for broadcast and lookup. */
function proofArgs(request: SovereignP2pPaymentRequest): BuildP2pPaymentProofArgs {
  return {
    workerAddress: request.workerAddress,
    amountMicro: request.amountMicro,
    treasuryAddress: request.treasuryAddress,
    feeAmountMicro: request.feeAmountMicro,
    ...(request.executorTreasuryAddress != null
      ? { executorTreasuryAddress: request.executorTreasuryAddress }
      : {}),
    ...(request.executorFeeAmountMicro != null
      ? { executorFeeAmountMicro: request.executorFeeAmountMicro }
      : {}),
    ...(request.network != null ? { network: request.network } : {}),
  };
}

/**
 * Construct a SolanaWalletRail backed by the default @solana/web3.js
 * adapter. Production wiring goes through this factory; tests can
 * construct `new SolanaWalletRail(mockAdapter)` directly.
 */
export function createSolanaWalletRail(config: SolanaWalletRailConfig): SolanaWalletRail {
  const adapter = new Web3JsRpcAdapter({
    rpcUrl: config.rpcUrl,
    identitySeed: config.identitySeed,
    usdcMint: config.usdcMint,
    commitment: config.commitment,
  });
  // Automatic gas is OFF, whatever `disableAutoGas` says: the top-up signed
  // a Jupiter-built transaction unvalidated (see `./jupiter.ts`).
  return new SolanaWalletRail(adapter, { autoGas: false });
}

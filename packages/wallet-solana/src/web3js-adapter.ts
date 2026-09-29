/**
 * Web3JsRpcAdapter — concrete SolanaRpcAdapter backed by @solana/web3.js.
 *
 * This is the only file in the package that imports from @solana/web3.js
 * or @solana/spl-token. Everything else (rail, constants, errors) is
 * library-agnostic. Swapping to @solana/kit later means writing a
 * KitRpcAdapter and changing the default in `createSolanaWalletRail`.
 *
 * The adapter:
 *   1. Derives the Solana Keypair from the motebit's 32-byte identity seed
 *      via Keypair.fromSeed (standard Ed25519: seed → keypair).
 *   2. Resolves USDC Associated Token Accounts on demand.
 *   3. Builds, signs, and submits SPL token transfers.
 *   4. Auto-creates the destination ATA on first send to a new address
 *      (payer = self, the cost is a small SOL rent deposit).
 *
 * The agent's identity public key IS its Solana address. Same 32 bytes,
 * different domain — both are Ed25519 public keys.
 */

import {
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  type Commitment,
} from "@solana/web3.js";
import { base58Encode, hexToBytes32 } from "@motebit/protocol";

/**
 * Derive the motebit's sovereign Solana address from its Ed25519 identity
 * public key — a pure base58 encoding of the 32-byte key.
 *
 * The address is knowable from the public key alone. No RPC call, no
 * Keypair, no ATA resolution, no rail instantiation. Callers that need
 * the deposit destination (Stripe onramp, display, verification) should
 * use this helper so address resolution never depends on the RPC rail
 * being up or `SolanaWalletRail` being instantiated. Balance queries and
 * transaction signing still require the full rail — those need the
 * keypair and a connection.
 */
export function deriveSolanaAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(
      `deriveSolanaAddress expects a 32-byte Ed25519 public key, got ${publicKey.length} bytes`,
    );
  }
  // A Solana address IS the base58btc encoding of the 32-byte Ed25519 public
  // key — no hashing, no checksum. Delegating to the shared chain-agnostic codec
  // (`@motebit/protocol`) keeps a single base58 implementation across the repo
  // and lets non-rail consumers (the runtime's no-rail address fallback) derive
  // the address without depending on this provider package.
  return base58Encode(publicKey);
}

/**
 * The DERIVED settlement-authority binding: is `settlementAddress` the identity
 * key's own Solana address? A Solana address IS `deriveSolanaAddress` of the
 * key, so `settlementAddress === deriveSolanaAddress(publicKeyHex)` proves the
 * agent's key authorizes this payout destination — tautologically, offline, no
 * artifact (docs/doctrine/settlement-authority-binding.md, the `derived-bound`
 * rung; the same shape as the commitment bond's address binding). A distinct
 * payout wallet needs the signed-bound rung instead. Fail-closed on a malformed
 * key. The CALLER is responsible for the public key being the agent's real key
 * (its own registry row, or an identity-binding-verified key for a federated
 * worker) — this only checks address⇄key, not key⇄motebit_id.
 */
export function isDerivedSettlementBinding(
  settlementAddress: string,
  publicKeyHex: string,
): boolean {
  const bytes = hexToBytes32(publicKeyHex);
  return bytes != null && settlementAddress === deriveSolanaAddress(bytes);
}
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TokenAccountNotFoundError,
} from "@solana/spl-token";

import type {
  SolanaRpcAdapter,
  SendUsdcArgs,
  SendUsdcResult,
  SendUsdcBatchItemResult,
  TxVerificationResult,
  OutgoingTransferQuery,
  OutgoingTransferLookup,
  BroadcastHooks,
  SignedTransactionRef,
  SignatureOutcome,
  DurableNonceLane,
  NonceLaneState,
  DurableTransactionRef,
  DurableBroadcastHooks,
  FinalizedSignatureStatus,
  DurableSendResult,
  NonceKillResult,
} from "./adapter.js";
import {
  USDC_MINT_MAINNET,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
} from "./constants.js";

/**
 * Short-name shown on confirmed `TxVerificationResult`s. The verifier
 * never consults it for correctness (the mint match is what matters)
 * but the field is carried through so audit logs read naturally. When
 * a future rail supports a second SPL asset, thread the mint through
 * and derive this from a small registry.
 */
const ASSET_NAME_USDC = "USDC";

/**
 * The seed of the treasury's durable-nonce account (#990): the account is
 * `PublicKey.createWithSeed(treasury, NONCE_ACCOUNT_SEED, SystemProgram)`,
 * so its address is derivable from the treasury key alone and no second key
 * exists. Rent: `NONCE_ACCOUNT_LENGTH` = 80 bytes ⇒ 1 447 680 lamports
 * (≈ 0.00145 SOL) rent-exempt, paid once by the treasury.
 */
export const NONCE_ACCOUNT_SEED = "motebit-payout-nonce-v1";

/** Per-call timeout on every RPC read or send in the durable paths (#990). */
const RPC_TIMEOUT_MS = 10_000;

/** How often, and how long, a durable send waits for its transaction to finalize. */
const FINALITY_POLL_MS = 2_000;
const FINALITY_MAX_WAIT_MS = 45_000;

/** One page of recent signatures for `findOutgoingTransfer` (#887). */
const OUTGOING_LOOKUP_PAGE = 50;

/** Backwards slack on the lookup window: whole-second block times + clock drift. */
const OUTGOING_LOOKUP_SKEW_MS = 30_000;

/**
 * True for web3.js's `TransactionExpiredBlockheightExceededError`: the
 * confirmation wait saw the block height pass `lastValidBlockHeight` without
 * HEARING that the transaction confirmed. It is NOT proof the transaction did
 * not land (#885 round 3): web3.js checks the status once when it subscribes
 * and then relies on a websocket notification that can be missed. So this is
 * only the trigger to ASK the chain (`getSignatureOutcome`) for a FOUND status —
 * never a re-sign (#990; see `signSendConfirm`).
 *
 * Deliberately NOT a generic "expired"/"timeout" match: a confirmation TIMEOUT
 * ("was not confirmed in N seconds") means the transaction may still land, so
 * re-broadcasting it WOULD risk a double-spend. Match the message string
 * (web3.js's `TransactionExpiredBlockheightExceededError`) rather than
 * `instanceof` to stay resilient across web3.js minor versions.
 */
function isBlockhashExpiry(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("block height exceeded");
}

export interface Web3JsRpcAdapterConfig {
  rpcUrl: string;
  identitySeed: Uint8Array;
  usdcMint?: string;
  commitment?: Commitment;
  /**
   * How long `signSendConfirm` keeps asking the chain after a blockhash
   * expiry before giving up (#885 round 4). Tests inject `sleep`/`now`.
   */
  expiryConfirm?: {
    pollMs?: number;
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
  /**
   * How long a durable send (#990) waits for its transaction to be
   * FINALIZED before handing the outcome back as unknown. Tests inject
   * `sleep`/`now`.
   */
  finality?: {
    pollMs?: number;
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
  /** Per-call RPC timeout in the durable paths. Default 10 s. */
  rpcTimeoutMs?: number;
}

/**
 * After a blockhash expiry, how often and how long to ask the chain about
 * the transaction just sent (#885 round 4). web3.js raises the expiry as
 * soon as the block height passes `lastValidBlockHeight` (it polls height
 * about once a second), so the first ask lands at lastValid+1 or +2, when the status may not yet be visible. The poll
 * looks only for a FOUND status (landed / failed); an absent one is never
 * evidence that it did not land, so the send is then handed back as
 * undecidable — never re-signed (#990).
 */
const EXPIRY_CONFIRM_POLL_MS = 1_500;
const EXPIRY_CONFIRM_MAX_WAIT_MS = 30_000;

export class Web3JsRpcAdapter implements SolanaRpcAdapter {
  /** #885: `beforeBroadcast` runs after signing and before every send. */
  readonly honorsBroadcastHooks = true as const;
  private readonly connection: Connection;
  private readonly keypair: Keypair;
  private readonly mint: PublicKey;
  private readonly commitment: Commitment;
  private readonly decisionCommitment: "confirmed" | "finalized";
  private readonly expiryPollMs: number;
  private readonly expiryMaxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly finalityPollMs: number;
  private readonly finalityMaxWaitMs: number;
  private readonly finalitySleep: (ms: number) => Promise<void>;
  private readonly finalityNow: () => number;
  private readonly rpcTimeoutMs: number;
  private nonceAddress: PublicKey | null = null;
  private creatingNonce: Promise<void> | null = null;

  constructor(config: Web3JsRpcAdapterConfig) {
    if (config.identitySeed.length !== 32) {
      throw new Error(
        `SolanaWalletRail expects a 32-byte Ed25519 seed, got ${config.identitySeed.length} bytes`,
      );
    }
    this.commitment = config.commitment ?? "confirmed";
    // #885 round 5: whether a payment LANDED or EXPIRED is never decided at
    // "processed" — a single node's processed view can be a minority fork.
    // A "processed" adapter still reads and sends at "processed"; its
    // confirmation and expiry decisions run at "confirmed". (The type keeps
    // "processed" because the relay's read-only reconcilers pass it.)
    this.decisionCommitment = this.commitment === "finalized" ? "finalized" : "confirmed";
    this.connection = new Connection(config.rpcUrl, this.commitment);
    this.expiryPollMs = config.expiryConfirm?.pollMs ?? EXPIRY_CONFIRM_POLL_MS;
    this.expiryMaxWaitMs = config.expiryConfirm?.maxWaitMs ?? EXPIRY_CONFIRM_MAX_WAIT_MS;
    this.sleep =
      config.expiryConfirm?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = config.expiryConfirm?.now ?? Date.now;
    this.finalityPollMs = config.finality?.pollMs ?? FINALITY_POLL_MS;
    this.finalityMaxWaitMs = config.finality?.maxWaitMs ?? FINALITY_MAX_WAIT_MS;
    this.finalitySleep =
      config.finality?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.finalityNow = config.finality?.now ?? Date.now;
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    // Keypair.fromSeed is the standard Ed25519 seed → keypair derivation.
    // The resulting public key is identical to the motebit identity
    // public key derived from the same seed via @noble/ed25519.
    this.keypair = Keypair.fromSeed(config.identitySeed);
    this.mint = new PublicKey(config.usdcMint ?? USDC_MINT_MAINNET);
  }

  get ownAddress(): string {
    return this.keypair.publicKey.toBase58();
  }

  /** Expose keypair for Jupiter swap signing. */
  getKeypair(): Keypair {
    return this.keypair;
  }

  /** Expose connection for Jupiter transaction submission. */
  getConnection(): Connection {
    return this.connection;
  }

  /** Expose commitment for Jupiter confirmation. */
  getCommitment(): Commitment {
    return this.commitment;
  }

  /** Expose USDC mint address for Jupiter quote. */
  getUsdcMint(): string {
    return this.mint.toBase58();
  }

  async getSolBalance(): Promise<bigint> {
    const lamports = await this.connection.getBalance(this.keypair.publicKey, this.commitment);
    return BigInt(lamports);
  }

  async getUsdcBalance(): Promise<bigint> {
    const ata = await getAssociatedTokenAddress(this.mint, this.keypair.publicKey);
    try {
      const account = await getAccount(this.connection, ata, this.commitment);
      return account.amount;
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) return 0n;
      throw err;
    }
  }

  async getUsdcBalanceOf(ownerAddress: string): Promise<bigint> {
    // Read-only counterparty balance lookup (commitment-bond backing). Mirror
    // of `getUsdcBalance` but for an arbitrary owner — resolve the owner's USDC
    // ATA and read its amount. No keypair, no transfer: this method never
    // touches custody. A malformed address is a caller error, surfaced as the
    // same `InvalidSolanaAddressError` the send path uses.
    let owner: PublicKey;
    try {
      owner = new PublicKey(ownerAddress);
    } catch (err) {
      throw new InvalidSolanaAddressError(ownerAddress, err);
    }
    const ata = await getAssociatedTokenAddress(this.mint, owner);
    try {
      const account = await getAccount(this.connection, ata, this.commitment);
      return account.amount;
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) return 0n;
      throw err;
    }
  }

  async sendUsdc(args: SendUsdcArgs, hooks?: BroadcastHooks): Promise<SendUsdcResult> {
    // 1. Validate recipient.
    let recipient: PublicKey;
    try {
      recipient = new PublicKey(args.toAddress);
    } catch (err) {
      throw new InvalidSolanaAddressError(args.toAddress, err);
    }

    // 2. Check balance up front for a clean error path. RPC will reject
    //    insufficient transfers anyway, but the wrapped error is friendlier.
    const balance = await this.getUsdcBalance();
    if (balance < args.microAmount) {
      throw new InsufficientUsdcBalanceError(balance, args.microAmount);
    }

    // 3. Resolve source + destination Associated Token Accounts.
    const sourceAta = await getAssociatedTokenAddress(this.mint, this.keypair.publicKey);
    const destAta = await getAssociatedTokenAddress(this.mint, recipient);

    // 4. Build the instructions. Auto-create destination ATA if missing.
    const instructions: TransactionInstruction[] = [];

    let destExists = false;
    try {
      await getAccount(this.connection, destAta, this.commitment);
      destExists = true;
    } catch (err) {
      if (!(err instanceof TokenAccountNotFoundError)) throw err;
    }
    if (!destExists) {
      // Idempotent (#885): a re-signed transaction must never land-and-fail
      // because an earlier attempt already created the account.
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          this.keypair.publicKey, // payer
          destAta,
          recipient,
          this.mint,
        ),
      );
    }

    instructions.push(
      createTransferInstruction(sourceAta, destAta, this.keypair.publicKey, args.microAmount),
    );

    // 5-6. Fetch a fresh blockhash, sign, submit, confirm — retrying with a new
    // blockhash on the (safe) permanent-expiry flake. See signSendConfirm.
    return this.signSendConfirm(instructions, hooks);
  }

  /**
   * Build a transaction from `instructions`, sign it over a recent
   * blockhash, report its signature (`hooks.beforeBroadcast`), broadcast it
   * ONCE, and await confirmation.
   *
   * On a `TransactionExpiredBlockheightExceededError` it does NOT assume the
   * transaction failed to land (#885): web3.js stops HEARING about a
   * transaction (it checks once, then relies on a websocket notification
   * that can be lost), so the transaction may well have landed. It asks the
   * chain about that transaction (`awaitDecisiveOutcome`): a FOUND status
   * decides it (`landed` ⇒ confirmed; `failed` ⇒ `confirmed: false`);
   * anything else ⇒ the original error is thrown, and the caller decides
   * later from its own recorded signature. It never re-signs (#990): an
   * absent status is not evidence that a transaction did not land, so no
   * re-sign is ever provably safe.
   *
   * Any non-expiry error propagates immediately.
   */
  private async signSendConfirm(
    instructions: readonly TransactionInstruction[],
    hooks?: BroadcastHooks,
  ): Promise<SendUsdcResult> {
    const tx = new Transaction();
    for (const ix of instructions) tx.add(ix);
    const latest = await this.connection.getLatestBlockhash(this.commitment);
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = this.keypair.publicKey;
    tx.sign(this.keypair);
    const rawSig = tx.signature;
    if (rawSig == null) throw new Error("signed transaction has no signature");
    const signed: SignedTransactionRef = {
      signature: base58Encode(new Uint8Array(rawSig)),
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };

    // #885: the signature is fixed now, before anything is sent. The payer
    // records THIS transaction first; if it cannot, nothing is sent.
    if (hooks?.beforeBroadcast != null) await hooks.beforeBroadcast(signed);

    try {
      const signature = await this.connection.sendRawTransaction(tx.serialize());
      const confirmation = await this.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        this.decisionCommitment,
      );
      return {
        signature,
        slot: confirmation.context.slot,
        confirmed: confirmation.value.err === null,
        // Exactly one transaction is ever broadcast per send.
        earlierBroadcastsDead: true,
      };
    } catch (err) {
      if (!isBlockhashExpiry(err)) throw err;
      const outcome = await this.awaitDecisiveOutcome(signed);
      if (outcome.status === "landed") {
        return {
          signature: signed.signature,
          slot: outcome.slot,
          confirmed: true,
          earlierBroadcastsDead: true,
        };
      }
      if (outcome.status === "failed") {
        return {
          signature: signed.signature,
          slot: 0,
          confirmed: false,
          earlierBroadcastsDead: true,
        };
      }
      throw err;
    }
  }

  /**
   * Ask the chain about `signed` until a status is FOUND at the decision
   * commitment (`landed` / `failed`) or `expiryMaxWaitMs` passes (#885).
   * Anything else at the cap is returned as is, and the caller throws.
   */
  private async awaitDecisiveOutcome(signed: SignedTransactionRef): Promise<SignatureOutcome> {
    const deadline = this.now() + this.expiryMaxWaitMs;
    for (;;) {
      const outcome = await this.getSignatureOutcome(signed);
      if (outcome.status === "landed" || outcome.status === "failed") return outcome;
      if (this.now() + this.expiryPollMs > deadline) return outcome;
      await this.sleep(this.expiryPollMs);
    }
  }

  /**
   * Conservative max transfers per Solana transaction.
   *
   * Solana txns are capped at 1232 bytes including signatures. Each SPL
   * transfer adds ~140 bytes (3 accounts + instruction data); each ATA
   * creation adds ~240 bytes (5 accounts + instruction data). Worst case
   * (every recipient needs a new ATA) each item costs ~380 bytes. With
   * ~960 bytes available after header/signature/blockhash, we get ~8
   * items in the worst case. Chunk at 8 to avoid runtime failures.
   */
  private static readonly MAX_TRANSFERS_PER_TX = 8;

  async sendUsdcBatch(
    items: readonly SendUsdcArgs[],
    hooks?: BroadcastHooks,
  ): Promise<SendUsdcBatchItemResult[]> {
    if (items.length === 0) return [];
    if (items.length === 1) {
      const r = await this.sendUsdc(items[0]!, hooks);
      return [
        {
          ok: r.confirmed,
          signature: r.signature,
          slot: r.slot,
          reason: null,
          ...(r.earlierBroadcastsDead !== undefined
            ? { earlierBroadcastsDead: r.earlierBroadcastsDead }
            : {}),
        },
      ];
    }

    const totalAmount = items.reduce((s, i) => s + i.microAmount, 0n);
    const balance = await this.getUsdcBalance();
    if (balance < totalAmount) {
      throw new InsufficientUsdcBalanceError(balance, totalAmount);
    }

    const results: SendUsdcBatchItemResult[] = new Array<SendUsdcBatchItemResult>(
      items.length,
    ).fill({ ok: false, signature: null, slot: 0, reason: "not processed" });
    const chunkSize = Web3JsRpcAdapter.MAX_TRANSFERS_PER_TX;
    let aborted = false;

    for (let start = 0; start < items.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, items.length);

      if (aborted) {
        for (let i = start; i < end; i++) {
          results[i] = { ok: false, signature: null, slot: 0, reason: "prior chunk failed" };
        }
        continue;
      }

      try {
        const instructions: TransactionInstruction[] = [];
        const sourceAta = await getAssociatedTokenAddress(this.mint, this.keypair.publicKey);

        for (let i = start; i < end; i++) {
          const item = items[i]!;
          let recipient: PublicKey;
          try {
            recipient = new PublicKey(item.toAddress);
          } catch (err) {
            throw new InvalidSolanaAddressError(item.toAddress, err);
          }
          const destAta = await getAssociatedTokenAddress(this.mint, recipient);

          let destExists = false;
          try {
            await getAccount(this.connection, destAta, this.commitment);
            destExists = true;
          } catch (err) {
            if (!(err instanceof TokenAccountNotFoundError)) throw err;
          }
          if (!destExists) {
            instructions.push(
              createAssociatedTokenAccountIdempotentInstruction(
                this.keypair.publicKey,
                destAta,
                recipient,
                this.mint,
              ),
            );
          }
          instructions.push(
            createTransferInstruction(sourceAta, destAta, this.keypair.publicKey, item.microAmount),
          );
        }

        // Same fresh-blockhash retry as the single-leg path — the atomic P2P
        // multi-output tx is exactly what the devnet expiry flake was killing.
        const { signature, slot, confirmed, earlierBroadcastsDead } = await this.signSendConfirm(
          instructions,
          hooks,
        );
        for (let i = start; i < end; i++) {
          results[i] = {
            ok: confirmed,
            signature,
            slot,
            reason: confirmed ? null : "tx failed",
            ...(earlierBroadcastsDead !== undefined ? { earlierBroadcastsDead } : {}),
          };
        }
        if (!confirmed) aborted = true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (let i = start; i < end; i++) {
          results[i] = { ok: false, signature: null, slot: 0, reason };
        }
        aborted = true;
      }
    }

    return results;
  }

  /**
   * Look up a transaction by signature and classify the outcome for
   * p2p payment verification. See `TxVerificationResult` for the
   * discrimination contract; the summary is:
   *
   *   - `Connection.getTransaction` throwing → `rpc_error` (transient,
   *     retry, never downgrade trust)
   *   - `null` result → `not_found` (authoritative, terminal)
   *   - result with no parseable SPL transfer → `not_found` (same
   *     effect: no verifiable payment) with a log line for visibility
   *   - result with an SPL transfer → `confirmed` with `from` / `to`
   *     as **owner** addresses (resolved via `preTokenBalances` /
   *     `postTokenBalances`, not ATA addresses) and the exact
   *     `amountMicro`
   *
   * Owner discovery through the meta token balances is robust across
   * legacy and versioned transactions. We deliberately do not decode
   * the SPL instruction data buffer: the balance-delta approach
   * produces the same from/to/amount without needing to own the SPL
   * parser, and it degrades gracefully to `not_found` when the tx
   * isn't a token transfer at all.
   */
  async getTransaction(signature: string): Promise<TxVerificationResult> {
    // `getTransaction` only accepts Finality ("confirmed" | "finalized"),
    // not the full Commitment union. Processed-level reads aren't
    // defined for finalized tx archives, so we narrow upward to
    // "confirmed" when the adapter is configured for "processed".
    const finality: "confirmed" | "finalized" =
      this.commitment === "finalized" ? "finalized" : "confirmed";
    let resp: Awaited<ReturnType<typeof this.connection.getTransaction>> = null;
    try {
      resp = await this.connection.getTransaction(signature, {
        commitment: finality,
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { status: "rpc_error", reason };
    }

    if (resp == null) return { status: "not_found" };

    // An errored tx never moved tokens — surface it as not_found so
    // the caller treats it like a missing payment (no verifiable
    // transfer happened).
    if (resp.meta?.err != null) return { status: "not_found" };

    const pre = resp.meta?.preTokenBalances ?? [];
    const post = resp.meta?.postTokenBalances ?? [];
    const mintString = this.mint.toBase58();

    // Build a per-(accountIndex) delta table for balances on our mint.
    // One side will have a negative delta (the payer), one positive
    // (the recipient). Using the declared mint as a filter keeps any
    // multi-asset transaction from polluting the result.
    type Row = { owner: string; delta: bigint };
    const rows = new Map<number, Row>();
    const addRow = (
      accountIndex: number,
      owner: string | undefined,
      amountString: string,
      sign: 1n | -1n,
    ): void => {
      if (!owner) return; // owner is optional in the wire format
      let amount: bigint;
      try {
        amount = BigInt(amountString);
      } catch {
        return;
      }
      const existing = rows.get(accountIndex);
      const prior = existing?.delta ?? 0n;
      rows.set(accountIndex, { owner, delta: prior + sign * amount });
    };

    for (const b of post) {
      if (b.mint !== mintString) continue;
      addRow(b.accountIndex, b.owner, b.uiTokenAmount.amount, 1n);
    }
    for (const b of pre) {
      if (b.mint !== mintString) continue;
      addRow(b.accountIndex, b.owner, b.uiTokenAmount.amount, -1n);
    }

    // After Arc 2 of the off-ramp arc, multi-recipient transactions
    // are first-class (the delegator's single tx pays worker AND relay
    // treasury atomically). Single payer is still required — multi-
    // payer cases remain ambiguous and surface as not_found. The
    // delegator side composes via a multi-instruction Solana
    // transaction; the verifier walks `transfers[]` to find the legs
    // it expects.
    let from: string | null = null;
    const transfers: Array<{ to: string; amountMicro: bigint }> = [];
    for (const { owner, delta } of rows.values()) {
      if (delta < 0n) {
        if (from != null) {
          // Multi-payer — genuinely ambiguous; the delegator must be
          // the sole payer in Motebit's P2P model. (Arc 2 doctrine.)
          return { status: "not_found" };
        }
        from = owner;
      } else if (delta > 0n) {
        transfers.push({ to: owner, amountMicro: delta });
      }
    }

    if (from == null || transfers.length === 0) {
      return { status: "not_found" };
    }

    return {
      status: "confirmed",
      from,
      transfers,
      slot: resp.slot,
      asset: ASSET_NAME_USDC,
    };
  }

  /**
   * Read-only recovery lookup (#887): did a transfer of exactly
   * `microAmount` from this wallet to `toAddress` land at or after
   * `sinceMs`? Walks one page of signatures touching this wallet's USDC
   * token account (newest first), classifies each through `getTransaction`
   * (the one authorized tx-reading boundary), and keeps those whose sole
   * payer is this wallet and that carry an exact leg to `toAddress`.
   *
   * Fail-closed: a page that may not reach back to `sinceMs`, or any RPC
   * error on the way, is `rpc_error` — never read as absence.
   */
  async findOutgoingTransfer(query: OutgoingTransferQuery): Promise<OutgoingTransferLookup> {
    const finality: "confirmed" | "finalized" =
      this.commitment === "finalized" ? "finalized" : "confirmed";
    const exclude = new Set(query.excludeSignatures ?? []);
    const own = this.keypair.publicKey.toBase58();
    // Block times are whole seconds and clocks drift; widen the window
    // backwards so a real match is never cut off by rounding.
    const sinceSec = Math.floor((query.sinceMs - OUTGOING_LOOKUP_SKEW_MS) / 1000);
    try {
      const sourceAta = await getAssociatedTokenAddress(this.mint, this.keypair.publicKey);
      const sigs = await this.connection.getSignaturesForAddress(
        sourceAta,
        { limit: OUTGOING_LOOKUP_PAGE },
        finality,
      );
      const oldest = sigs[sigs.length - 1];
      if (
        sigs.length >= OUTGOING_LOOKUP_PAGE &&
        (oldest?.blockTime == null || oldest.blockTime >= sinceSec)
      ) {
        return {
          status: "rpc_error",
          reason: `${OUTGOING_LOOKUP_PAGE}+ transactions since the send — lookup window not covered`,
        };
      }
      const matches: string[] = [];
      for (const info of sigs) {
        if (info.err != null) continue; // an errored tx moved nothing
        if (info.blockTime != null && info.blockTime < sinceSec) continue;
        if (exclude.has(info.signature)) continue;
        const tx = await this.getTransaction(info.signature);
        if (tx.status === "rpc_error") return { status: "rpc_error", reason: tx.reason };
        if (tx.status !== "confirmed" || tx.from !== own) continue;
        if (
          tx.transfers.some((l) => l.to === query.toAddress && l.amountMicro === query.microAmount)
        ) {
          matches.push(info.signature);
        }
      }
      if (matches.length === 1) return { status: "found", signature: matches[0]! };
      if (matches.length > 1) return { status: "ambiguous", signatures: matches };
      return { status: "not_found" };
    } catch (err) {
      return { status: "rpc_error", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * What the chain says about ONE signed transaction (#885). Read-only.
   *
   * Only a FOUND status is evidence: `landed` / `failed` when its
   * per-status `confirmationStatus` reaches the decision commitment,
   * `pending` + `seen` when it is in a block below it. An ABSENT status is
   * never evidence that the transaction did not land — a history lookup
   * reads a pruned range, a snapshot jump or a swallowed BigTable error as
   * absent (agave `rpc.rs` `get_signature_statuses`) — so absence is
   * `pending`, and no adapter reports `expired` (#990).
   */
  async getSignatureOutcome(tx: SignedTransactionRef): Promise<SignatureOutcome> {
    try {
      const resp = await this.connection.getSignatureStatuses([tx.signature], {
        searchTransactionHistory: true,
      });
      const status = resp.value[0];
      if (status == null) return { status: "pending" };
      const settled =
        status.confirmationStatus === "finalized" ||
        (this.commitment !== "finalized" && status.confirmationStatus === "confirmed");
      if (settled) {
        return status.err == null ? { status: "landed", slot: status.slot } : { status: "failed" };
      }
      return { status: "pending", seen: true };
    } catch (err) {
      return { status: "rpc_error", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── durable-nonce payouts (#990) ───────────────────────────────────────

  /** `p` bounded by the per-call RPC timeout. */
  private timed<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${this.rpcTimeoutMs}ms`)),
        this.rpcTimeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private async nonceAccount(): Promise<PublicKey> {
    this.nonceAddress ??= await PublicKey.createWithSeed(
      this.keypair.publicKey,
      NONCE_ACCOUNT_SEED,
      SystemProgram.programId,
    );
    return this.nonceAddress;
  }

  /** The nonce lane read at FINALIZED commitment; `absent` when no account exists. */
  private async readNonceLane(): Promise<NonceLaneState | { status: "absent" }> {
    const address = await this.nonceAccount();
    const info = await this.timed(
      this.connection.getAccountInfo(address, { commitment: "finalized" }),
      "getAccountInfo(nonce)",
    );
    if (info == null) return { status: "absent" };
    if (
      info.owner.toBase58() !== SystemProgram.programId.toBase58() ||
      info.data.length !== NONCE_ACCOUNT_LENGTH
    ) {
      return { status: "unavailable", reason: `${address.toBase58()} is not a nonce account` };
    }
    const nonce = NonceAccount.fromAccountData(info.data);
    if (nonce.authorizedPubkey.toBase58() !== this.keypair.publicKey.toBase58()) {
      return {
        status: "unavailable",
        reason: `nonce account ${address.toBase58()} is not authorized by the treasury`,
      };
    }
    return { status: "ready", account: address.toBase58(), nonceValue: nonce.nonce };
  }

  /** Create the nonce account (the treasury pays the rent and is its authority). */
  private async createNonceAccount(): Promise<void> {
    const address = await this.nonceAccount();
    const lamports = await this.timed(
      this.connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH),
      "getMinimumBalanceForRentExemption",
    );
    const tx = new Transaction().add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: this.keypair.publicKey,
        newAccountPubkey: address,
        basePubkey: this.keypair.publicKey,
        seed: NONCE_ACCOUNT_SEED,
        lamports,
        space: NONCE_ACCOUNT_LENGTH,
        programId: SystemProgram.programId,
      }),
      SystemProgram.nonceInitialize({
        noncePubkey: address,
        authorizedPubkey: this.keypair.publicKey,
      }),
    );
    const latest = await this.timed(
      this.connection.getLatestBlockhash(this.commitment),
      "getLatestBlockhash",
    );
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = this.keypair.publicKey;
    tx.sign(this.keypair);
    const signature = await this.timed(
      this.connection.sendRawTransaction(tx.serialize()),
      "sendRawTransaction(create nonce)",
    );
    // Creating twice is harmless (the second fails: the account exists).
    await this.awaitFinalized(signature);
  }

  async prepareNonceLane(): Promise<NonceLaneState> {
    try {
      const first = await this.readNonceLane();
      if (first.status !== "absent") return first;
      this.creatingNonce ??= this.createNonceAccount().finally(() => {
        this.creatingNonce = null;
      });
      await this.creatingNonce;
      const second = await this.readNonceLane();
      return second.status === "absent"
        ? { status: "unavailable", reason: "the nonce account is not finalized yet" }
        : second;
    } catch (err) {
      return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Sign a durable-nonce transaction: `nonceAdvance` first, over `lane.nonceValue`. */
  private signDurable(
    lane: DurableNonceLane,
    rest: readonly TransactionInstruction[],
    kind: DurableTransactionRef["kind"],
  ): { tx: Transaction; ref: DurableTransactionRef } {
    const tx = new Transaction().add(
      SystemProgram.nonceAdvance({
        noncePubkey: new PublicKey(lane.account),
        authorizedPubkey: this.keypair.publicKey,
      }),
    );
    for (const ix of rest) tx.add(ix);
    tx.recentBlockhash = lane.nonceValue;
    tx.feePayer = this.keypair.publicKey;
    tx.sign(this.keypair);
    const rawSig = tx.signature;
    if (rawSig == null) throw new Error("signed transaction has no signature");
    return {
      tx,
      ref: {
        signature: base58Encode(new Uint8Array(rawSig)),
        kind,
        nonceAccount: lane.account,
        nonceValue: lane.nonceValue,
      },
    };
  }

  async sendUsdcDurable(
    args: SendUsdcArgs,
    lane: DurableNonceLane,
    hooks?: DurableBroadcastHooks,
  ): Promise<DurableSendResult> {
    let recipient: PublicKey;
    try {
      recipient = new PublicKey(args.toAddress);
    } catch (err) {
      throw new InvalidSolanaAddressError(args.toAddress, err);
    }
    const balance = await this.timed(this.getUsdcBalance(), "getUsdcBalance");
    if (balance < args.microAmount) {
      throw new InsufficientUsdcBalanceError(balance, args.microAmount);
    }
    const sourceAta = await getAssociatedTokenAddress(this.mint, this.keypair.publicKey);
    const destAta = await getAssociatedTokenAddress(this.mint, recipient);
    const { tx, ref } = this.signDurable(
      lane,
      [
        // Idempotent create: no read of the destination, never a failure
        // because the account already exists.
        createAssociatedTokenAccountIdempotentInstruction(
          this.keypair.publicKey,
          destAta,
          recipient,
          this.mint,
        ),
        createTransferInstruction(sourceAta, destAta, this.keypair.publicKey, args.microAmount),
      ],
      "payout",
    );
    // Recorded before it is sent; a hook that cannot record stops the send.
    if (hooks?.beforeBroadcast != null) await hooks.beforeBroadcast(ref);
    try {
      await this.timed(this.connection.sendRawTransaction(tx.serialize()), "sendRawTransaction");
    } catch (err) {
      // The RPC may or may not have forwarded it: unknown, decided later.
      return {
        tx: ref,
        final: {
          status: "unknown",
          reason: "rpc_error",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
    return { tx: ref, final: await this.awaitFinalized(ref.signature) };
  }

  async broadcastNonceKill(
    lane: DurableNonceLane,
    hooks?: DurableBroadcastHooks,
  ): Promise<NonceKillResult> {
    const { tx, ref } = this.signDurable(lane, [], "kill");
    if (hooks?.beforeBroadcast != null) await hooks.beforeBroadcast(ref);
    try {
      await this.timed(
        this.connection.sendRawTransaction(tx.serialize()),
        "sendRawTransaction(kill)",
      );
      return { tx: ref, sent: true };
    } catch (err) {
      return { tx: ref, sent: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async getFinalizedStatus(signature: string): Promise<FinalizedSignatureStatus> {
    try {
      // The status cache first (works on a node without transaction
      // history), then history for an older one.
      let resp = await this.timed(
        this.connection.getSignatureStatuses([signature]),
        "getSignatureStatuses",
      );
      if (resp.value[0] == null) {
        resp = await this.timed(
          this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
          "getSignatureStatuses(history)",
        );
      }
      const status = resp.value[0];
      if (status == null) return { status: "unknown", reason: "absent" };
      // Released agave ignores the request's commitment; the per-status
      // confirmationStatus is the only finality signal (rpc.rs).
      if (status.confirmationStatus !== "finalized") {
        return { status: "unknown", reason: "not_finalized" };
      }
      return { status: "finalized", ok: status.err == null, slot: status.slot };
    } catch (err) {
      return {
        status: "unknown",
        reason: "rpc_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Poll `signature` until it is FINALIZED or the bounded wait ends. */
  private async awaitFinalized(signature: string): Promise<FinalizedSignatureStatus> {
    const deadline = this.finalityNow() + this.finalityMaxWaitMs;
    for (;;) {
      const status = await this.getFinalizedStatus(signature);
      if (status.status === "finalized") return status;
      if (this.finalityNow() + this.finalityPollMs > deadline) return status;
      await this.finalitySleep(this.finalityPollMs);
    }
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.connection.getLatestBlockhash(this.commitment);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The production `SolanaGenesisHashReader` (`network.ts`): `getGenesisHash`
 * on `rpcUrl`. It lives here because this is the file that owns
 * `@solana/web3.js`; the derivation law itself is pure (`network.ts`).
 */
export function createSolanaGenesisHashReader(rpcUrl: string): () => Promise<string> {
  const connection = new Connection(rpcUrl, "confirmed");
  return () => connection.getGenesisHash();
}

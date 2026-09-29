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
  PublicKey,
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
} from "./adapter.js";
import { historyCoversLanding } from "./adapter.js";
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
 * Broadcast attempts before giving up. A Solana transaction is signed over a
 * recent blockhash that expires after ~151 blocks (~60-90s); on a slow or
 * congested cluster (devnet especially) the confirmation can miss that window,
 * surfacing as a `TransactionExpiredBlockheightExceededError` ("... has expired:
 * block height exceeded"). Bounded so a genuinely-down RPC still fails fast.
 */
const BROADCAST_MAX_ATTEMPTS = 3;

/** One page of recent signatures for `findOutgoingTransfer` (#887). */
const OUTGOING_LOOKUP_PAGE = 50;

/** Backwards slack on the lookup window: whole-second block times + clock drift. */
const OUTGOING_LOOKUP_SKEW_MS = 30_000;

/**
 * Blocks past `lastValidBlockHeight` before absence counts as expiry (#885).
 * Absorbs commitment skew between the height read and the status read; a few
 * seconds of extra wait against a wrongly-voided payment.
 */
const EXPIRY_HEIGHT_MARGIN = 10;

/**
 * True for web3.js's `TransactionExpiredBlockheightExceededError`: the
 * confirmation wait saw the block height pass `lastValidBlockHeight` without
 * HEARING that the transaction confirmed. It is NOT proof the transaction did
 * not land (#885 round 3): web3.js checks the status once when it subscribes
 * and then relies on a websocket notification that can be missed. So this is
 * only the trigger to ASK the chain (`getSignatureOutcome`) — a re-sign
 * follows only a definitive `expired` answer (see `signSendConfirm`).
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
}

/**
 * After a blockhash expiry, how often and how long to ask the chain about
 * the transaction just sent (#885 round 4). web3.js raises the expiry as
 * soon as the block height passes `lastValidBlockHeight` (it polls height
 * about once a second), so the first ask lands at lastValid+1 or +2 —
 * inside the `EXPIRY_HEIGHT_MARGIN`, where absence is not yet proof. At
 * ~400ms a block the margin clears in ~4-5s; 30s is a generous cap for a
 * slow cluster before the send is handed back as undecidable.
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
   * Build a transaction from `instructions`, sign it over a FRESH recent
   * blockhash, report its signature (`hooks.beforeBroadcast`), broadcast, and
   * await confirmation.
   *
   * On a `TransactionExpiredBlockheightExceededError` it does NOT assume the
   * transaction failed to land (#885). web3.js raises that error when it
   * stopped HEARING about the transaction before the block height passed —
   * it checks the status once when it subscribes and then relies on a
   * websocket notification that can be lost — so the transaction may well
   * have landed. Before any re-sign, the adapter asks the chain about the
   * transaction it just sent (`getSignatureOutcome`):
   *
   *   - `landed`  ⇒ that transaction IS the payment; return it. No re-sign.
   *   - `expired` ⇒ authoritatively not on chain and past its last valid
   *     height (the slot-anchored rule in `getSignatureOutcome`): it can
   *     never be included, so a re-sign with a fresh blockhash is the only
   *     transaction that can move the money — no double-spend.
   *   - `failed`  ⇒ it was included and errored: a failed Solana transaction
   *     applies none of its instructions (only the fee is charged), so no
   *     funds moved. The failure is definitive and usually deterministic
   *     (a retry would fail the same way), so it is returned as
   *     `confirmed: false` — exactly what a confirmed-with-error send
   *     returns — and never retried.
   *   - `pending` / `rpc_error` ⇒ asked again every ~1.5s for up to 30s
   *     (`awaitDecisiveOutcome`) — web3.js reports the expiry at
   *     lastValid+1, inside the absence margin, so the first answer is
   *     usually `pending`. Still undecidable at the cap ⇒ the original error
   *     is thrown and the caller's own-signature confirmation decides
   *     later. Never a re-sign on a maybe.
   *
   * Any non-expiry error propagates immediately.
   */
  private async signSendConfirm(
    instructions: readonly TransactionInstruction[],
    hooks?: BroadcastHooks,
  ): Promise<SendUsdcResult> {
    // The chain's verdict on every attempt broadcast before the current one.
    // `earlierBroadcastsDead` is derived from this EVIDENCE, not from the
    // control flow: true only if each earlier attempt was decisively
    // `expired` (for the first attempt the list is empty — one broadcast).
    const earlierVerdicts: SignatureOutcome["status"][] = [];
    const earlierBroadcastsDead = (): boolean =>
      earlierVerdicts.every((status) => status === "expired");
    for (let attempt = 1; ; attempt++) {
      const tx = new Transaction();
      for (const ix of instructions) tx.add(ix);
      // #949 round 2: a slot read BEFORE the blockhash — the transaction can
      // only land after it, so a late reader can check that a node's retained
      // history reaches back that far before trusting "absent". Read FIRST:
      // read after the blockhash, the slot could be past where the
      // transaction lands.
      //
      // Round 3 (C1): a payer that records what it broadcasts gets no
      // transaction without this slot. The read is retried once; if it still
      // fails, nothing is signed or sent and the send throws — "nothing was
      // broadcast" stays a clean, provable verdict. Without hooks nobody
      // records the ref, and a missing slot only means a late reader can
      // never prove the transaction absent.
      const recentSlot = await this.readRecentSlot();
      if (recentSlot === undefined && hooks?.beforeBroadcast != null) {
        throw new Error(
          "cannot read the current slot before signing: nothing was signed or sent (the payout's landing window could not be recorded)",
        );
      }
      const latest = await this.connection.getLatestBlockhash(this.commitment);
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = this.keypair.publicKey;
      tx.sign(this.keypair);
      const rawSig = tx.signature;
      if (rawSig == null) throw new Error("signed transaction has no signature");
      const signed: SignedTransactionRef = {
        signature: base58Encode(new Uint8Array(rawSig)),
        lastValidBlockHeight: latest.lastValidBlockHeight,
        ...(typeof recentSlot === "number" ? { recentSlot } : {}),
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
          earlierBroadcastsDead: earlierBroadcastsDead(),
        };
      } catch (err) {
        if (!isBlockhashExpiry(err)) throw err;
        const outcome = await this.awaitDecisiveOutcome(signed);
        switch (outcome.status) {
          case "landed":
            return {
              signature: signed.signature,
              slot: outcome.slot,
              confirmed: true,
              earlierBroadcastsDead: earlierBroadcastsDead(),
            };
          case "failed":
            return {
              signature: signed.signature,
              slot: 0,
              confirmed: false,
              earlierBroadcastsDead: earlierBroadcastsDead(),
            };
          case "expired":
            earlierVerdicts.push(outcome.status);
            if (attempt < BROADCAST_MAX_ATTEMPTS) continue;
            throw err;
          case "pending":
          case "rpc_error":
            throw err;
        }
      }
    }
  }

  /** The slot at the decision commitment, read up to twice; undefined when both reads fail. */
  private async readRecentSlot(): Promise<number | undefined> {
    for (let i = 0; i < 2; i++) {
      try {
        const slot = await this.connection.getSlot(this.decisionCommitment);
        if (Number.isSafeInteger(slot) && slot >= 0) return slot;
      } catch {
        // retried once, then unknown
      }
    }
    return undefined;
  }

  /**
   * Ask the chain about `signed` until the answer is decisive (`landed`,
   * `failed`, `expired`) or `expiryMaxWaitMs` passes (#885 round 4). Right
   * after web3.js reports an expiry the height is only just past
   * `lastValidBlockHeight`, so the first answer is usually `pending` (inside
   * the margin); a few more blocks settle it. This poll is where the
   * devnet-flake blockhash-expiry retry now lives: an expired first attempt
   * becomes `expired` here, and only then does `signSendConfirm` re-sign.
   * Still `pending` (or `rpc_error`) at the cap ⇒ returned as is, and the
   * caller throws — never a re-sign on a maybe.
   */
  private async awaitDecisiveOutcome(signed: SignedTransactionRef): Promise<SignatureOutcome> {
    const deadline = this.now() + this.expiryMaxWaitMs;
    // Sticky pending (#885 round 5): once ANY read has seen this signature
    // in a block, an `expired` answer for it is never accepted — the
    // expiry rule compares slot NUMBERS, not fork membership, and a
    // load-balanced RPC can answer from a node on a minority fork. The
    // transaction then lands (returned) or the cap is reached (thrown).
    let seen = false;
    for (;;) {
      let outcome = await this.getSignatureOutcome(signed);
      if (outcome.status === "pending" && outcome.seen === true) seen = true;
      if (outcome.status === "expired" && seen) outcome = { status: "pending", seen: true };
      if (outcome.status === "landed" || outcome.status === "failed") return outcome;
      if (outcome.status === "expired") return outcome;
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
   * Status is looked up with full history search, so a transaction that
   * landed long ago is still found. Absence becomes authoritative only
   * once the chain's block height is past the transaction's
   * `lastValidBlockHeight`: from then on it can never be included.
   */
  async getSignatureOutcome(tx: SignedTransactionRef): Promise<SignatureOutcome> {
    try {
      // Height and slot come from ONE read (#885 round 3). The absence of a
      // signature proves "never landed" only if the node answering the status
      // query had already seen every slot where it could have landed:
      //
      //   1. `epoch.blockHeight > lastValidBlockHeight + margin` ⇒ every block
      //      the transaction could be in (block height ≤ lastValidBlockHeight)
      //      is at a slot ≤ `epoch.absoluteSlot`.
      //   2. The status response's `context.slot ≥ epoch.absoluteSlot` ⇒ the
      //      answering node has processed all of those slots, and
      //      `searchTransactionHistory` makes it look through them.
      //   3. So `value[0] === null` from that response means the transaction
      //      is in none of them, and never can be.
      //
      // A node lagging behind (context.slot < absoluteSlot) proves nothing:
      // `pending`. The margin absorbs commitment-level skew between the two
      // reads (a block counted at `processed` by one node, not yet at
      // `confirmed` by another).
      const epoch = await this.connection.getEpochInfo(this.decisionCommitment);
      const resp = await this.connection.getSignatureStatuses([tx.signature], {
        searchTransactionHistory: true,
      });
      const status = resp.value[0];
      const settled =
        status != null &&
        (status.confirmationStatus === "finalized" ||
          (this.commitment !== "finalized" && status.confirmationStatus === "confirmed"));
      if (status != null && settled) {
        return status.err == null ? { status: "landed", slot: status.slot } : { status: "failed" };
      }
      // In a block, not yet at commitment. `seen` makes every later
      // "absent" read for this signature untrustworthy (sticky pending).
      if (status != null) return { status: "pending", seen: true };
      const pastLastValid =
        epoch.blockHeight != null &&
        epoch.blockHeight > tx.lastValidBlockHeight + EXPIRY_HEIGHT_MARGIN;
      const nodeCaughtUp = resp.context.slot >= epoch.absoluteSlot;
      if (!(pastLastValid && nodeCaughtUp)) return { status: "pending" };
      // #949 round 2: absence is evidence of absence only inside the node's
      // retained history. When the signer recorded where the transaction
      // could first land, require the node to still hold that slot; a node
      // that pruned it may be hiding a landing. (A ref with no `recentSlot`
      // keeps the prior rule — the in-send re-sign asks within seconds, well
      // inside any retention window; a LATE reader must hold the slot itself.)
      if (typeof tx.recentSlot === "number") {
        const first = await this.connection.getFirstAvailableBlock();
        if (!historyCoversLanding(tx, first)) {
          return {
            status: "rpc_error",
            reason: `history pruned: the node's first available slot ${first} is after where ${tx.signature} could have landed`,
            historyPruned: true,
          };
        }
      }
      return { status: "expired" };
    } catch (err) {
      return { status: "rpc_error", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The node's first available slot (`getFirstAvailableBlock`, #949 round 2). Rejects on failure. */
  async getFirstAvailableSlot(): Promise<number> {
    return this.connection.getFirstAvailableBlock();
  }

  /** The chain's block height at the decision commitment (#949). Rejects on failure. */
  async getBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight(this.decisionCommitment);
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

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

import { Connection, Keypair, PublicKey, Transaction, type Commitment } from "@solana/web3.js";

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
  return new PublicKey(publicKey).toBase58();
}
import {
  createAssociatedTokenAccountInstruction,
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

export interface Web3JsRpcAdapterConfig {
  rpcUrl: string;
  identitySeed: Uint8Array;
  usdcMint?: string;
  commitment?: Commitment;
}

export class Web3JsRpcAdapter implements SolanaRpcAdapter {
  private readonly connection: Connection;
  private readonly keypair: Keypair;
  private readonly mint: PublicKey;
  private readonly commitment: Commitment;

  constructor(config: Web3JsRpcAdapterConfig) {
    if (config.identitySeed.length !== 32) {
      throw new Error(
        `SolanaWalletRail expects a 32-byte Ed25519 seed, got ${config.identitySeed.length} bytes`,
      );
    }
    this.commitment = config.commitment ?? "confirmed";
    this.connection = new Connection(config.rpcUrl, this.commitment);
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

  async sendUsdc(args: SendUsdcArgs): Promise<SendUsdcResult> {
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

    // 4. Build the transaction. Auto-create destination ATA if missing.
    const tx = new Transaction();

    let destExists = false;
    try {
      await getAccount(this.connection, destAta, this.commitment);
      destExists = true;
    } catch (err) {
      if (!(err instanceof TokenAccountNotFoundError)) throw err;
    }
    if (!destExists) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          this.keypair.publicKey, // payer
          destAta,
          recipient,
          this.mint,
        ),
      );
    }

    tx.add(createTransferInstruction(sourceAta, destAta, this.keypair.publicKey, args.microAmount));

    // 5. Fetch a recent blockhash and sign.
    const latest = await this.connection.getLatestBlockhash(this.commitment);
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = this.keypair.publicKey;
    tx.sign(this.keypair);

    // 6. Submit and wait for confirmation.
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      this.commitment,
    );

    return {
      signature,
      slot: confirmation.context.slot,
      confirmed: confirmation.value.err === null,
    };
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

  async sendUsdcBatch(items: readonly SendUsdcArgs[]): Promise<SendUsdcBatchItemResult[]> {
    if (items.length === 0) return [];
    if (items.length === 1) {
      const r = await this.sendUsdc(items[0]!);
      return [{ ok: r.confirmed, signature: r.signature, slot: r.slot, reason: null }];
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
        const tx = new Transaction();
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
            tx.add(
              createAssociatedTokenAccountInstruction(
                this.keypair.publicKey,
                destAta,
                recipient,
                this.mint,
              ),
            );
          }
          tx.add(
            createTransferInstruction(sourceAta, destAta, this.keypair.publicKey, item.microAmount),
          );
        }

        const latest = await this.connection.getLatestBlockhash(this.commitment);
        tx.recentBlockhash = latest.blockhash;
        tx.feePayer = this.keypair.publicKey;
        tx.sign(this.keypair);

        const signature = await this.connection.sendRawTransaction(tx.serialize());
        const confirmation = await this.connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          this.commitment,
        );

        const ok = confirmation.value.err === null;
        for (let i = start; i < end; i++) {
          results[i] = {
            ok,
            signature,
            slot: confirmation.context.slot,
            reason: ok ? null : "tx failed",
          };
        }
        if (!ok) aborted = true;
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

    let from: string | null = null;
    let to: string | null = null;
    let amountMicro = 0n;
    for (const { owner, delta } of rows.values()) {
      if (delta < 0n) {
        // A single tx could touch multiple payer accounts; we only
        // surface a transfer when exactly one payer and one recipient
        // are on the mint. The verifier checks for an exact match,
        // so any ambiguity should be treated as not_found.
        if (from != null) {
          return { status: "not_found" };
        }
        from = owner;
        amountMicro = -delta;
      } else if (delta > 0n) {
        if (to != null) {
          return { status: "not_found" };
        }
        to = owner;
      }
    }

    if (from == null || to == null || amountMicro === 0n) {
      return { status: "not_found" };
    }

    return {
      status: "confirmed",
      from,
      to,
      amountMicro,
      slot: resp.slot,
      asset: ASSET_NAME_USDC,
    };
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

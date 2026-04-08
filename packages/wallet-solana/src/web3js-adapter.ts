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
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TokenAccountNotFoundError,
} from "@solana/spl-token";

import type { SolanaRpcAdapter, SendUsdcArgs, SendUsdcResult } from "./adapter.js";
import {
  USDC_MINT_MAINNET,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
} from "./constants.js";

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

  async isReachable(): Promise<boolean> {
    try {
      await this.connection.getLatestBlockhash(this.commitment);
      return true;
    } catch {
      return false;
    }
  }
}

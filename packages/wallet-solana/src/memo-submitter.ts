/**
 * SolanaMemoSubmitter — writes Merkle roots to Solana via the Memo program.
 *
 * Implements ChainAnchorSubmitter (motebit/credential-anchor@1.0 §6.2).
 *
 * The relay's Ed25519 identity key is natively a valid Solana keypair (same
 * curve). No second key, no custodial provider. The memo transaction is
 * signed by the relay's identity — anyone can look up the tx by hash and
 * verify the root was published by a known relay address.
 *
 * Memo format: "motebit:anchor:v1:{merkle_root_hex}:{leaf_count}"
 * Human-readable, machine-parseable, permanent.
 *
 * The Memo program (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr) is a
 * Solana system program that records arbitrary data in a transaction's log.
 * The data is indexed, searchable, and immutable. Cost: ~5000 lamports
 * (~$0.001 at current SOL prices).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Commitment,
} from "@solana/web3.js";

import type { ChainAnchorSubmitter } from "@motebit/protocol";

// Solana Memo Program v2
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// Minimum SOL balance to submit a memo (~5000 lamports for tx fee)
const MIN_SOL_LAMPORTS = 10_000;

// CAIP-2 network identifiers
const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export interface SolanaMemoSubmitterConfig {
  /** Solana RPC endpoint URL. */
  rpcUrl: string;
  /** 32-byte Ed25519 identity seed (relay's identity key). */
  identitySeed: Uint8Array;
  /** Commitment level. Default: "confirmed". */
  commitment?: Commitment;
  /** CAIP-2 network identifier. Default: mainnet. */
  network?: string;
}

export class SolanaMemoSubmitter implements ChainAnchorSubmitter {
  readonly chain = "solana" as const;
  readonly network: string;

  private readonly connection: Connection;
  private readonly keypair: Keypair;
  private readonly commitment: Commitment;

  constructor(config: SolanaMemoSubmitterConfig) {
    if (config.identitySeed.length !== 32) {
      throw new Error(
        `SolanaMemoSubmitter expects a 32-byte Ed25519 seed, got ${config.identitySeed.length} bytes`,
      );
    }
    this.commitment = config.commitment ?? "confirmed";
    this.connection = new Connection(config.rpcUrl, this.commitment);
    this.keypair = Keypair.fromSeed(config.identitySeed);
    this.network = config.network ?? SOLANA_MAINNET_CAIP2;
  }

  /** The relay's Solana address (base58 public key). */
  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  async submitMerkleRoot(
    root: string,
    _relayId: string,
    leafCount: number,
  ): Promise<{ txHash: string }> {
    // relayId is implicit — the transaction signer IS the relay's identity key.
    // Verifiers derive the relay identity from the tx's signer pubkey.

    // Build memo data — human-readable, machine-parseable
    const memo = `motebit:anchor:v1:${root}:${leafCount}`;

    // Construct memo instruction
    const instruction = new TransactionInstruction({
      keys: [{ pubkey: this.keypair.publicKey, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf-8"),
    });

    // Build, sign, submit
    const tx = new Transaction().add(instruction);
    const latest = await this.connection.getLatestBlockhash(this.commitment);
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = this.keypair.publicKey;
    tx.sign(this.keypair);

    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      this.commitment,
    );

    return { txHash: signature };
  }

  /**
   * Submit a revocation memo to Solana — immediate, no batching.
   *
   * Revocations are rare and urgent. A compromised key must be visible
   * onchain immediately so any party can verify revocation without
   * contacting any relay.
   *
   * Memo format: "motebit:revocation:v1:{old_public_key_hex}:{timestamp}"
   */
  async submitRevocation(oldPublicKeyHex: string, timestamp: number): Promise<{ txHash: string }> {
    const memo = `motebit:revocation:v1:${oldPublicKeyHex}:${timestamp}`;

    const instruction = new TransactionInstruction({
      keys: [{ pubkey: this.keypair.publicKey, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf-8"),
    });

    const tx = new Transaction().add(instruction);
    const latest = await this.connection.getLatestBlockhash(this.commitment);
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = this.keypair.publicKey;
    tx.sign(this.keypair);

    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      this.commitment,
    );

    return { txHash: signature };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check RPC reachability
      await this.connection.getLatestBlockhash(this.commitment);

      // Check SOL balance for tx fees
      const balance = await this.connection.getBalance(this.keypair.publicKey, this.commitment);
      return balance >= MIN_SOL_LAMPORTS;
    } catch {
      return false;
    }
  }
}

/**
 * Create a SolanaMemoSubmitter for credential anchoring.
 * Factory function for consistency with createSolanaWalletRail.
 */
export function createSolanaMemoSubmitter(config: SolanaMemoSubmitterConfig): SolanaMemoSubmitter {
  return new SolanaMemoSubmitter(config);
}

/** Parse a memo string back into its components. For verification. */
export function parseMemoAnchor(memo: string): {
  version: string;
  merkleRoot: string;
  leafCount: number;
} | null {
  const parts = memo.split(":");
  if (parts.length !== 5) return null;
  if (parts[0] !== "motebit" || parts[1] !== "anchor") return null;
  const version = parts[2]!;
  const merkleRoot = parts[3]!;
  const leafCount = parseInt(parts[4]!, 10);
  if (isNaN(leafCount)) return null;
  return { version, merkleRoot, leafCount };
}

/** Parse a revocation memo string back into its components. For verification. */
export function parseRevocationMemo(memo: string): {
  version: string;
  publicKeyHex: string;
  timestamp: number;
} | null {
  const parts = memo.split(":");
  if (parts.length !== 5) return null;
  if (parts[0] !== "motebit" || parts[1] !== "revocation") return null;
  const version = parts[2]!;
  const publicKeyHex = parts[3]!;
  const timestamp = parseInt(parts[4]!, 10);
  if (isNaN(timestamp)) return null;
  return { version, publicKeyHex, timestamp };
}

export { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 };

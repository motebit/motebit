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

import { base58Encode, type ChainAnchorSubmitter } from "@motebit/protocol";

import {
  checkSignatureOnce,
  confirmSignatureByPolling,
  type ConfirmByPollingOptions,
  type PolledSignatureOutcome,
  type PolledSignatureRef,
} from "./confirm-signature.js";

import {
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  SolanaNetworkResolver,
} from "./network.js";

// Solana Memo Program v2
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// Minimum SOL balance to submit a memo (~5000 lamports for tx fee)
const MIN_SOL_LAMPORTS = 10_000;

/** A signed memo transaction, known before it is sent. */
export type AnchorBroadcastRef = PolledSignatureRef;

/**
 * Sign → record → send → confirm that signature. `beforeBroadcast` runs after
 * the memo is signed and before it is sent; a hook that throws stops the send.
 * A caller that records the signature here never sends a second memo for the
 * same anchor while the first may still land: it asks `checkBroadcast` instead.
 */
export interface AnchorBroadcastHooks {
  beforeBroadcast?: (ref: AnchorBroadcastRef) => void | Promise<void>;
}

/** The memo landed with an error: its fee was spent, nothing was anchored. */
export class AnchorTransactionFailedError extends Error {
  constructor(
    readonly signature: string,
    readonly err: unknown,
  ) {
    super(`anchor memo ${signature} landed with an error: ${JSON.stringify(err)}`);
    this.name = "AnchorTransactionFailedError";
  }
}

/** The memo's blockhash expired without it landing: it can never land. */
export class AnchorBroadcastExpiredError extends Error {
  constructor(readonly signature: string) {
    super(`anchor memo ${signature} expired without landing`);
    this.name = "AnchorBroadcastExpiredError";
  }
}

/**
 * The bounded confirmation wait ended undecided. The memo may still land; a
 * caller that recorded the signature asks `checkBroadcast` later and never
 * re-sends blindly.
 */
export class AnchorConfirmationPendingError extends Error {
  constructor(
    readonly signature: string,
    detail?: string,
  ) {
    super(
      `anchor memo ${signature} is not confirmed yet${detail ? ` (${detail})` : ""}; its signature decides it later`,
    );
    this.name = "AnchorConfirmationPendingError";
  }
}

/** The RPC reads and writes the memo submitter makes. A web3.js `Connection` satisfies it. */
export type MemoSubmitterConnection = Pick<
  Connection,
  | "getLatestBlockhash"
  | "sendRawTransaction"
  | "getSignatureStatuses"
  | "getBlockHeight"
  | "getBalance"
  | "getMinimumBalanceForRentExemption"
  | "getGenesisHash"
>;

export interface SolanaMemoSubmitterConfig {
  /** Solana RPC endpoint URL. */
  rpcUrl: string;
  /** 32-byte Ed25519 identity seed (relay's identity key). */
  identitySeed: Uint8Array;
  /** Commitment level. Default: "confirmed". */
  commitment?: Commitment;
  /**
   * The CAIP-2 id the caller expects the RPC to serve. There is NO default
   * (#954 — the old `?? mainnet` labelled devnet anchors "mainnet"). Either
   * way the id is checked against the RPC's own genesis hash before the
   * first write (`resolveNetwork`):
   *   - given: a mismatch refuses every write — never a mislabelled anchor;
   *   - omitted: the id is DERIVED from the genesis hash.
   * An unreadable genesis hash refuses the write; the next write retries.
   */
  network?: string;
  /**
   * A shared resolver for this RPC (the relay passes the one its health
   * surface and reconciliation also read). When given, it is the only source
   * of the network, and `network`, if also given, must equal its `expected`.
   * Default: a resolver over this submitter's own connection.
   */
  networkResolver?: SolanaNetworkResolver;
  /** The RPC client. Default: a web3.js `Connection` on `rpcUrl` (tests inject a fake). */
  connection?: MemoSubmitterConnection;
  /** Bounds on the HTTP-polling confirmation wait. Default: 1 s polls for up to 45 s. */
  confirm?: ConfirmByPollingOptions;
}

const MEMO_CONFIRM_MAX_WAIT_MS = 45_000;

function mismatchError(expected: string, served: string): Error {
  return new Error(
    `SolanaMemoSubmitter refuses to write: declared network ${expected} but the RPC serves ${served}`,
  );
}

export class SolanaMemoSubmitter implements ChainAnchorSubmitter {
  readonly chain = "solana" as const;

  private readonly connection: MemoSubmitterConnection;
  private readonly confirmOpts: ConfirmByPollingOptions;
  private readonly keypair: Keypair;
  private readonly commitment: Commitment;
  /** Where the network comes from: the RPC's genesis hash, lazily, with a timeout. */
  private readonly resolver: SolanaNetworkResolver;

  constructor(config: SolanaMemoSubmitterConfig) {
    if (config.identitySeed.length !== 32) {
      throw new Error(
        `SolanaMemoSubmitter expects a 32-byte Ed25519 seed, got ${config.identitySeed.length} bytes`,
      );
    }
    this.commitment = config.commitment ?? "confirmed";
    this.connection = config.connection ?? new Connection(config.rpcUrl, this.commitment);
    this.confirmOpts = { maxWaitMs: MEMO_CONFIRM_MAX_WAIT_MS, ...config.confirm };
    this.keypair = Keypair.fromSeed(config.identitySeed);
    if (config.networkResolver) {
      if (config.network !== undefined && config.network !== config.networkResolver.expected) {
        throw new Error(
          `SolanaMemoSubmitter: network ${config.network} disagrees with the resolver's declared ${String(config.networkResolver.expected)}`,
        );
      }
      this.resolver = config.networkResolver;
    } else {
      const connection = this.connection;
      this.resolver = new SolanaNetworkResolver(() => connection.getGenesisHash(), {
        ...(config.network !== undefined ? { expected: config.network } : {}),
      });
    }
  }

  /**
   * The CAIP-2 id this submitter writes under: the id verified against the
   * RPC once a write (or `resolveNetwork`) has checked it, else the caller's
   * declared id. With neither, there is no label to give and reading it
   * throws — it never falls back to a default. Consumers record it only
   * after a successful submit, by which point it is verified.
   */
  get network(): string {
    const state = this.resolver.state;
    if (state.status === "resolved") return state.network;
    if (state.status === "mismatch") throw mismatchError(state.expected, state.network);
    if (this.resolver.expected !== undefined) return this.resolver.expected;
    throw new Error(
      "SolanaMemoSubmitter network is not yet known: it is read from the RPC's genesis hash before the first write (resolveNetwork)",
    );
  }

  /**
   * Read the RPC's genesis hash and return the CAIP-2 id of the cluster it
   * serves. Throws when the read fails (retryable) or when a declared
   * network disagrees with it (permanent). Every submit calls this first, so
   * no anchor is ever written under a label the RPC contradicts.
   */
  async resolveNetwork(): Promise<string> {
    const r = await this.resolver.resolve();
    if (r.status === "resolved") return r.network;
    if (r.status === "mismatch") throw mismatchError(r.expected, r.network);
    throw new Error(
      `SolanaMemoSubmitter refuses to write: the RPC's network is unknown (${r.reason})`,
    );
  }

  /** The relay's Solana address (base58 public key). */
  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Read the fee-payer's on-chain solvency: its native SOL balance and the
   * rent-exempt minimum for a bare (0-data) account. The fee-payer IS this
   * submitter's identity wallet, which pays the base fee on every anchor
   * (settlement / credential / revocation / transparency) memo.
   *
   * Solana rejects any transaction that would leave the fee-payer below the
   * rent-exempt minimum — so the *spendable* headroom is
   * `balance - rentExemptMin`, NOT the raw balance. A wallet sitting just
   * above the rent floor (headroom < one base fee) is effectively FROZEN:
   * every anchor fails at simulation with an empty-log error, silently
   * stalling all on-chain anchoring. Callers use this to alert before that
   * threshold, not after. (Observed in prod 2026-07-25: 895_000 lamports
   * balance, 890_880 rent-min ⇒ 4_120 headroom < 5_000 fee ⇒ frozen.)
   */
  async getFeePayerSolvency(): Promise<{
    balanceLamports: number;
    rentExemptMinLamports: number;
  }> {
    const [balanceLamports, rentExemptMinLamports] = await Promise.all([
      this.connection.getBalance(this.keypair.publicKey, this.commitment),
      this.connection.getMinimumBalanceForRentExemption(0, this.commitment),
    ]);
    return { balanceLamports, rentExemptMinLamports };
  }

  async submitMerkleRoot(
    root: string,
    _relayId: string,
    leafCount: number,
    hooks?: AnchorBroadcastHooks,
  ): Promise<{ txHash: string }> {
    // relayId is implicit — the transaction signer IS the relay's identity key.
    // Verifiers derive the relay identity from the tx's signer pubkey.

    await this.resolveNetwork();

    // Build memo data — human-readable, machine-parseable
    const memo = `motebit:anchor:v1:${root}:${leafCount}`;

    return this.sendMemo(memo, hooks);
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
  async submitRevocation(
    oldPublicKeyHex: string,
    timestamp: number,
    hooks?: AnchorBroadcastHooks,
  ): Promise<{ txHash: string }> {
    await this.resolveNetwork();
    const memo = `motebit:revocation:v1:${oldPublicKeyHex}:${timestamp}`;

    return this.sendMemo(memo, hooks);
  }

  /**
   * Submit an operator-transparency declaration anchor — immediate, no batching.
   *
   * The relay anchors `sha256(canonicalJson(declaration))` to Solana when
   * it deploys (or when the declaration changes). A verifier who knows the
   * relay's Solana address (pinned out-of-band — like Apple App Attest's
   * root cert is pinned) can confirm the declaration's hash matches a memo
   * at that address. This closes the trust-on-first-use (TOFU) gap on the
   * first fetch of `/.well-known/motebit-transparency.json` — without an
   * anchor, the verifier trusts whatever HTTPS + DNS returned; with an
   * anchor, the verifier trusts a separate channel (Solana) that the
   * network provider cannot tamper with.
   *
   * Memo format: "motebit:transparency:v1:{declaration_hash_hex}"
   *
   * Doctrine: `docs/doctrine/operator-transparency.md` (Stage 2 onchain
   * anchor), `docs/doctrine/nist-alignment.md` §8 (savant-gap closure).
   */
  async submitTransparencyAnchor(
    declarationHashHex: string,
    hooks?: AnchorBroadcastHooks,
  ): Promise<{ txHash: string }> {
    await this.resolveNetwork();
    const memo = `motebit:transparency:v1:${declarationHashHex}`;

    return this.sendMemo(memo, hooks);
  }

  /**
   * Sign `memo`, report its signature (`hooks.beforeBroadcast`), send it ONCE
   * and confirm THAT signature by HTTP polling (`confirm-signature.ts` — never
   * a websocket subscription). Throws `AnchorTransactionFailedError` (landed
   * with an error), `AnchorBroadcastExpiredError` (can never land) or
   * `AnchorConfirmationPendingError` (undecided — ask `checkBroadcast` later).
   */
  private async sendMemo(memo: string, hooks?: AnchorBroadcastHooks): Promise<{ txHash: string }> {
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
    const rawSig = tx.signature;
    if (rawSig == null) throw new Error("signed memo transaction has no signature");
    const ref: AnchorBroadcastRef = {
      signature: base58Encode(new Uint8Array(rawSig)),
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };

    // Recorded before it is sent; a hook that cannot record stops the send.
    if (hooks?.beforeBroadcast != null) await hooks.beforeBroadcast(ref);

    await this.connection.sendRawTransaction(tx.serialize());
    const outcome = await confirmSignatureByPolling(
      this.connection,
      ref,
      this.commitment,
      this.confirmOpts,
    );
    return { txHash: settledTxHash(ref.signature, outcome) };
  }

  /**
   * What became of a memo this submitter sent earlier (its recorded
   * signature). One read, no send. `expired` means it can never land, so a
   * new memo for the same anchor is safe; `pending` means ask again later.
   */
  async checkBroadcast(ref: AnchorBroadcastRef): Promise<PolledSignatureOutcome> {
    return checkSignatureOnce(this.connection, ref, this.commitment);
  }

  async isAvailable(): Promise<boolean> {
    try {
      // The RPC must serve the cluster this submitter labels its anchors with.
      await this.resolveNetwork();

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

/** The tx hash of a confirmed memo, or the matching error for any other outcome. */
function settledTxHash(signature: string, outcome: PolledSignatureOutcome): string {
  switch (outcome.status) {
    case "confirmed":
      return signature;
    case "failed":
      throw new AnchorTransactionFailedError(signature, outcome.err);
    case "expired":
      throw new AnchorBroadcastExpiredError(signature);
    case "pending":
      throw new AnchorConfirmationPendingError(signature, outcome.reason);
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

/**
 * Parse a transparency-declaration anchor memo back into its
 * components. Memo format: `motebit:transparency:v1:{declaration_hash_hex}`.
 * Used by verifiers who scan a relay's Solana address for the latest
 * declaration anchor (`@motebit/state-export-client`'s
 * `lookupTransparencyAnchor`).
 */
export function parseTransparencyAnchorMemo(memo: string): {
  version: string;
  declarationHashHex: string;
} | null {
  const parts = memo.split(":");
  if (parts.length !== 4) return null;
  if (parts[0] !== "motebit" || parts[1] !== "transparency") return null;
  const version = parts[2]!;
  const declarationHashHex = parts[3]!;
  if (!/^[0-9a-fA-F]{64}$/.test(declarationHashHex)) return null;
  return { version, declarationHashHex: declarationHashHex.toLowerCase() };
}

export { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2 };

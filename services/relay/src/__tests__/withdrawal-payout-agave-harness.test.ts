/**
 * Path 0 payout harness against RELEASED agave semantics (#949 round 6, #990).
 *
 * Every earlier harness mocked the adapter, and every mock answered like the
 * RPC's documentation instead of like the RPC. This one runs the REAL
 * `Web3JsRpcAdapter` and `OperatorSolanaTransfer` through the REAL relay
 * routes against a fake `Connection` that behaves like released agave
 * (v2.3.13 … v4.0.0, `rpc/src/rpc.rs`):
 *
 *   - `getSignatureStatuses` IGNORES `commitment` and `minContextSlot`
 *     (`RpcSignatureStatusConfig` carries only `search_transaction_history`);
 *     it answers from the PROCESSED bank (`self.bank(Some(processed()))`),
 *     so a status may come from a minority fork, and `context.slot` is the
 *     processed slot;
 *   - each found status carries a per-status `confirmationStatus`
 *     (`get_transaction_status`: `finalized` only when the slot is at or
 *     below the highest super-majority root and on the rooted path —
 *     `is_finalized`; `confirmed` when the optimistically confirmed bank has
 *     it; `processed` otherwise);
 *   - with `searchTransactionHistory`, a status outside the status cache
 *     comes from the blockstore or BigTable (rooted only, `finalized`) — or
 *     not at all: a BigTable error is swallowed as absent;
 *   - `getEpochInfo` honours `commitment` and `minContextSlot` (errors when
 *     the bank at that commitment is behind it);
 *   - processed / confirmed / finalized lag (2 and 32 slots), minority forks
 *     that show a status and then vanish, a load-balanced pool whose nodes
 *     disagree, and BigTable-style absence;
 *   - the durable-nonce state machine: a durable transaction lands only while
 *     the nonce account holds its `recentBlockhash`, and landing advances
 *     the nonce whether the transaction succeeds or fails
 *     (`svm/src/rollback_accounts.rs`: a failed transaction's nonce account
 *     is stored ADVANCED); a blockhash transaction lands only up to its
 *     `lastValidBlockHeight`.
 *
 * The oracle is the cluster's CANONICAL truth, asserted after every step:
 *   - value leaves at most once (refunds + landed payouts ≤ 1);
 *   - never refunded while a payout of the withdrawal can still land;
 *   - `completed` names a payout that landed on the canonical chain;
 *   - an open withdrawal is on the operator's queue;
 * and at the end, once nothing can land: landed ⇒ completed, else failed and
 * refunded exactly once. No stuck state.
 *
 * The reviewer's findings on 655267bf4, as cells:
 *   1a `dropped`             — a payout that never lands: the round-5 third
 *                               read (finalized, minContextSlot = processed
 *                               slot) always fails, so it is stuck for good;
 *   1b `fork_ok_never`       — a processed minority-fork status persisted as
 *                               landed: debited, never paid;
 *   1c `fork_err_then_lands` — a processed minority-fork ERROR persisted as
 *                               failed: refunded, then the payout lands.
 */

import { createRequire } from "node:module";
import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { OperatorSolanaTransfer, Web3JsRpcAdapter } from "@motebit/wallet-solana";

import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import * as chainPayouts from "../withdrawal-chain-payouts.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

// ── @solana/web3.js + spl-token, loaded through wallet-solana's own tree ──
// (the relay does not depend on them; the fake needs them only to parse the
// transactions the real adapter sends and to encode account data).
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
const walletRequire = createRequire(
  createRequire(import.meta.url).resolve("@motebit/wallet-solana"),
);
const web3: any = walletRequire("@solana/web3.js");
const spl: any = walletRequire("@solana/spl-token");

const FUNDED = 5_000_000;
const W_USD = 1.5;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const TREASURY_SEED = new Uint8Array(32).fill(7);
const DEST: string = web3.Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ── the relay's clock ────────────────────────────────────────────────────
const realNow = Date.now.bind(Date);
let clockOffset = 0;
function jumpClock(ms: number): void {
  clockOffset += ms;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
}

// ── the cluster ──────────────────────────────────────────────────────────

type TxKind = "payout" | "kill" | "create_nonce" | "blockhash_payout" | "other";
type Fate =
  | { kind: "land"; delay: number; err?: boolean }
  | { kind: "drop" }
  | { kind: "fork"; err: boolean; thenLand?: { delay: number; err?: boolean } };

interface ClusterTx {
  signature: string;
  kind: TxKind;
  nonceAccount?: string;
  nonceValue?: string;
  lastValid?: number;
  fate: Fate;
  landAt?: number;
  landErr: boolean;
  state: "mempool" | "canonical" | "dropped";
  slot?: number;
  forkSlot?: number;
  forkErr?: boolean;
  createsNonce?: {
    account: string;
    authority: string;
    /** `create`: createAccountWithSeed; `allocate`: allocateWithSeed (take over a squat); `init`: nonceInitialize only. */
    mode: "create" | "allocate" | "init";
    topUp: number;
  };
}

/** A raw (non-nonce) account sitting at an address — a squat. */
interface RawAccount {
  owner: string;
  dataLen: number;
  lamports: number;
}

const NONCE_RENT = 1_447_680;

type Witness = "honest" | "lagging_lb" | "bigtable_absent";

class AgaveCluster {
  slot = 10_000;
  halted = false;
  witness: Witness = "honest";
  /** The cluster halts the moment a payout is broadcast. */
  haltOnPayout = false;
  /**
   * The next N account reads are served by a node 40 slots behind (a
   * load-balanced pool; finalized account reads are not monotonic across it).
   * Such a node honours minContextSlot (agave rpc.rs get_bank_with_config).
   */
  staleAccountReads = 0;
  /** A payout send forwards the transaction, then the RPC call errors. */
  forwardThenError = false;
  /** Raw accounts (squats): anyone can fund an address; only its key (or base) can shape it. */
  readonly raw = new Map<string, RawAccount>();
  /** The blockhash confirmation wait's connection drops (a non-expiry error). */
  confirmError: string | null = null;
  readonly txs = new Map<string, ClusterTx>();
  readonly nonces = new Map<
    string,
    { authority: string; created: number; history: Array<{ slot: number; value: string }> }
  >();
  private readonly blockhashes = new Map<string, number>();
  private lbFlip = false;
  private n = 0;
  constructor(
    readonly fateOf: (kind: TxKind, index: number) => Fate,
    readonly tokenAccounts: Set<string>,
  ) {}

  finalizedAt(tip: number): number {
    return tip - 32;
  }
  confirmedAt(tip: number): number {
    return tip - 2;
  }

  advance(slots: number): void {
    if (this.halted) return;
    for (let i = 0; i < slots; i++) {
      this.slot++;
      for (const tx of this.txs.values()) this.settle(tx);
    }
  }

  private freshValue(): string {
    this.n++;
    const seed = new Uint8Array(32);
    seed[0] = this.n & 0xff;
    seed[1] = (this.n >> 8) & 0xff;
    seed[31] = 0xaa;
    return web3.Keypair.fromSeed(seed).publicKey.toBase58();
  }

  /** The canonical nonce value at `slot`. */
  nonceAt(account: string, slot: number): string | null {
    const n = this.nonces.get(account);
    if (!n || n.created > slot) return null;
    let v: string | null = null;
    for (const h of n.history) if (h.slot <= slot) v = h.value;
    return v;
  }

  /** Could this transaction still land on the canonical chain? */
  canLand(tx: ClusterTx): boolean {
    if (tx.state === "canonical") return false;
    if (tx.nonceAccount !== undefined) {
      return this.nonceAt(tx.nonceAccount, this.slot) === tx.nonceValue;
    }
    if (tx.lastValid !== undefined) return this.slot <= tx.lastValid;
    return false;
  }

  private settle(tx: ClusterTx): void {
    if (tx.state !== "mempool" || tx.landAt === undefined || tx.landAt > this.slot) return;
    if (!this.canLand(tx)) {
      tx.state = "dropped";
      return;
    }
    tx.state = "canonical";
    tx.slot = this.slot;
    if (tx.nonceAccount !== undefined) {
      // Landing advances the nonce, success or failure (rollback_accounts.rs).
      this.nonces.get(tx.nonceAccount)!.history.push({ slot: this.slot, value: this.freshValue() });
    }
    if (tx.createsNonce && !tx.landErr) {
      // agave system_processor: create_account refuses an address with
      // lamports > 0 (AccountAlreadyInUse); allocate(_with_seed) needs a
      // system-owned account with empty data; initialize needs an
      // Uninitialized 80-byte account holding the rent-exempt minimum.
      const c = tx.createsNonce;
      const r = this.raw.get(c.account);
      const ok =
        !this.nonces.has(c.account) &&
        (c.mode === "create"
          ? r === undefined
          : r !== undefined &&
            r.owner === web3.SystemProgram.programId.toBase58() &&
            r.dataLen === (c.mode === "allocate" ? 0 : 80) &&
            r.lamports + c.topUp >= NONCE_RENT);
      if (!ok) tx.landErr = true;
    }
    if (tx.createsNonce && !tx.landErr) {
      this.raw.delete(tx.createsNonce.account);
      this.nonces.set(tx.createsNonce.account, {
        authority: tx.createsNonce.authority,
        created: this.slot,
        history: [{ slot: this.slot, value: this.freshValue() }],
      });
    }
  }

  /** The node answering this read: a load-balanced pool alternates with a lagging node. */
  private viewTip(): number {
    if (this.witness !== "lagging_lb") return this.slot;
    this.lbFlip = !this.lbFlip;
    return this.lbFlip ? this.slot - 40 : this.slot;
  }

  private bankSlot(commitment: string | undefined, tip: number): number {
    if (commitment === "finalized") return this.finalizedAt(tip);
    if (commitment === "confirmed") return this.confirmedAt(tip);
    return tip;
  }

  // ── the Connection surface the adapter uses ────────────────────────────

  connection(): Record<string, unknown> {
    return {
      getLatestBlockhash: (c?: unknown) => {
        const commitment = typeof c === "string" ? c : (c as { commitment?: string })?.commitment;
        const bank = this.bankSlot(commitment ?? "confirmed", this.slot);
        const blockhash = this.freshValue();
        this.blockhashes.set(blockhash, bank);
        return Promise.resolve({ blockhash, lastValidBlockHeight: bank + 150 });
      },
      getEpochInfo: (cfg?: { commitment?: string; minContextSlot?: number }) => {
        const tip = this.viewTip();
        const bank = this.bankSlot(cfg?.commitment ?? "confirmed", tip);
        if (cfg?.minContextSlot !== undefined && cfg.minContextSlot > bank) {
          return Promise.reject(
            new Error(
              `failed to get epoch info: Minimum context slot has not been reached (context slot ${bank})`,
            ),
          );
        }
        return Promise.resolve({
          absoluteSlot: bank,
          blockHeight: bank,
          epoch: 0,
          slotIndex: bank,
          slotsInEpoch: 432_000,
          transactionCount: 0,
        });
      },
      getBalance: () => Promise.resolve(10_000_000_000),
      getMinimumBalanceForRentExemption: () => Promise.resolve(1_447_680),
      getAccountInfoAndContext: (
        pubkey: { toBase58(): string },
        c?: { commitment?: string; minContextSlot?: number },
      ) => {
        const tip =
          this.staleAccountReads > 0 ? (this.staleAccountReads--, this.slot - 40) : this.viewTip();
        const bank = this.bankSlot(c?.commitment ?? "confirmed", tip);
        if (c?.minContextSlot !== undefined && c.minContextSlot > bank) {
          return Promise.reject(
            new Error(
              `failed to get info about account: Minimum context slot has not been reached (context slot ${bank})`,
            ),
          );
        }
        return (this.accountAt(pubkey.toBase58(), bank) as Promise<unknown>).then((value) => ({
          context: { slot: bank },
          value,
        }));
      },
      getAccountInfo: (pubkey: { toBase58(): string }, c?: unknown) => {
        const commitment = typeof c === "string" ? c : (c as { commitment?: string })?.commitment;
        const tip =
          this.staleAccountReads > 0 ? (this.staleAccountReads--, this.slot - 40) : this.viewTip();
        const bank = this.bankSlot(commitment ?? "confirmed", tip);
        return this.accountAt(pubkey.toBase58(), bank);
      },
      sendRawTransaction: (raw: Uint8Array, opts?: { skipPreflight?: boolean }) =>
        this.send(raw, opts?.skipPreflight === true),
      // Released agave: the config's commitment / minContextSlot are ignored.
      getSignatureStatuses: (sigs: string[], config?: { searchTransactionHistory?: boolean }) => {
        const tip = this.viewTip();
        const finalized = this.finalizedAt(tip);
        const confirmed = this.confirmedAt(tip);
        const value = sigs.map((sig) => {
          const tx = this.txs.get(sig);
          if (!tx) return null;
          if (tx.state === "canonical" && tx.slot! <= tip) {
            const inCache = tip - tx.slot! < 300;
            const err = tx.landErr ? { InstructionError: [1, { Custom: 1 }] } : null;
            if (inCache) {
              const isFinal = tx.slot! <= finalized;
              return {
                slot: tx.slot,
                confirmations: isFinal ? null : Math.max(0, tip - tx.slot!),
                err,
                confirmationStatus: isFinal
                  ? "finalized"
                  : tx.slot! <= confirmed
                    ? "confirmed"
                    : "processed",
              };
            }
            if (config?.searchTransactionHistory !== true) return null;
            if (this.witness === "bigtable_absent") return null;
            return { slot: tx.slot, confirmations: null, err, confirmationStatus: "finalized" };
          }
          // A minority fork: visible at processed for a while, never rooted.
          if (tx.forkSlot !== undefined && tip >= tx.forkSlot && tip < tx.forkSlot + 20) {
            return {
              slot: tx.forkSlot,
              confirmations: 0,
              err: tx.forkErr ? { InstructionError: [1, { Custom: 1 }] } : null,
              confirmationStatus: "processed",
            };
          }
          return null;
        });
        return Promise.resolve({ context: { slot: tip }, value });
      },
      // The blockhash confirmation wait (655267bf4's path): time passes
      // until the transaction is confirmed or its blockhash expires.
      confirmTransaction: (strategy: { signature: string; lastValidBlockHeight: number }) => {
        if (this.confirmError !== null) return Promise.reject(new Error(this.confirmError));
        for (let i = 0; i < 400; i++) {
          const tx = this.txs.get(strategy.signature);
          if (tx?.state === "canonical" && tx.slot! <= this.confirmedAt(this.slot)) {
            return Promise.resolve({
              context: { slot: this.slot },
              value: { err: tx.landErr ? { InstructionError: [1, { Custom: 1 }] } : null },
            });
          }
          if (this.slot > strategy.lastValidBlockHeight) {
            return Promise.reject(
              new Error(`Signature ${strategy.signature} has expired: block height exceeded.`),
            );
          }
          if (this.halted) {
            return Promise.reject(new Error("Transaction was not confirmed in 60.00 seconds"));
          }
          this.advance(1);
        }
        return Promise.reject(new Error("Transaction was not confirmed in 60.00 seconds"));
      },
    };
  }

  private send(raw: Uint8Array, skipPreflight: boolean): Promise<string> {
    const tx = web3.Transaction.from(Buffer.from(raw));
    const sig = encodeSig(tx.signature as Uint8Array);
    const existing = this.txs.get(sig);
    if (existing) return Promise.resolve(sig);

    const ixs: any[] = tx.instructions;
    const sys = web3.SystemProgram.programId.toBase58();
    const typeOf = (ix: any): string | null =>
      ix.programId.toBase58() === sys ? web3.SystemInstruction.decodeInstructionType(ix) : null;
    let kind: TxKind = "other";
    const rec: ClusterTx = {
      signature: sig,
      kind,
      fate: { kind: "drop" },
      landErr: false,
      state: "mempool",
    };
    if (ixs.length > 0 && typeOf(ixs[0]) === "AdvanceNonceAccount") {
      const adv = web3.SystemInstruction.decodeNonceAdvance(ixs[0]);
      rec.nonceAccount = adv.noncePubkey.toBase58();
      rec.nonceValue = tx.recentBlockhash;
      kind = ixs.length === 1 ? "kill" : "payout";
      if (!skipPreflight && this.nonceAt(rec.nonceAccount!, this.slot) !== rec.nonceValue) {
        return Promise.reject(
          new Error(
            "failed to send transaction: Transaction simulation failed: Blockhash not found",
          ),
        );
      }
    } else if (ixs.some((ix) => typeOf(ix) === "InitializeNonceAccount")) {
      const init = web3.SystemInstruction.decodeNonceInitialize(
        ixs.find((ix) => typeOf(ix) === "InitializeNonceAccount"),
      );
      kind = "create_nonce";
      const account = init.noncePubkey.toBase58();
      const topUp = ixs
        .filter((ix) => typeOf(ix) === "Transfer")
        .map((ix) => web3.SystemInstruction.decodeTransfer(ix))
        .filter((t: any) => t.toPubkey.toBase58() === account)
        .reduce((a: number, t: any) => a + Number(t.lamports), 0);
      rec.createsNonce = {
        account,
        authority: init.authorizedPubkey.toBase58(),
        mode: ixs.some((ix) => typeOf(ix) === "CreateWithSeed" || typeOf(ix) === "Create")
          ? "create"
          : ixs.some((ix) => typeOf(ix) === "AllocateWithSeed" || typeOf(ix) === "Allocate")
            ? "allocate"
            : "init",
        topUp,
      };
      rec.lastValid = (this.blockhashes.get(tx.recentBlockhash) ?? this.slot) + 150;
    } else {
      kind = "blockhash_payout";
      const registered = this.blockhashes.get(tx.recentBlockhash);
      rec.lastValid = (registered ?? -1_000) + 150;
      if (!skipPreflight && (registered === undefined || this.slot > rec.lastValid)) {
        return Promise.reject(
          new Error(
            "failed to send transaction: Transaction simulation failed: Blockhash not found",
          ),
        );
      }
    }
    rec.kind = kind;
    const index = [...this.txs.values()].filter((t) => t.kind === kind).length;
    rec.fate = this.fateOf(kind, index);
    switch (rec.fate.kind) {
      case "land":
        rec.landAt = this.slot + rec.fate.delay;
        rec.landErr = rec.fate.err === true;
        break;
      case "fork":
        rec.forkSlot = this.slot;
        rec.forkErr = rec.fate.err;
        if (rec.fate.thenLand) {
          rec.landAt = this.slot + rec.fate.thenLand.delay;
          rec.landErr = rec.fate.thenLand.err === true;
        }
        break;
      case "drop":
        break;
    }
    this.txs.set(sig, rec);
    this.settle(rec);
    if (this.forwardThenError && kind === "payout") {
      this.forwardThenError = false;
      return Promise.reject(new Error("fetch failed: socket hang up (the RPC forwarded it)"));
    }
    if (this.haltOnPayout && (kind === "payout" || kind === "blockhash_payout")) this.halted = true;
    return Promise.resolve(sig);
  }

  accountAt(address: string, bank: number): Promise<unknown> {
    const squat = this.raw.get(address);
    if (squat && !this.nonces.has(address)) {
      return Promise.resolve({
        data: Buffer.alloc(squat.dataLen),
        owner: new web3.PublicKey(squat.owner),
        lamports: squat.lamports,
        executable: false,
        rentEpoch: 0,
      });
    }
    const nonce = this.nonces.get(address);
    if (nonce) {
      const value = this.nonceAt(address, bank);
      if (value === null) return Promise.resolve(null);
      const data = Buffer.alloc(80);
      data.writeUInt32LE(1, 0);
      data.writeUInt32LE(1, 4);
      Buffer.from(new web3.PublicKey(nonce.authority).toBytes()).copy(data, 8);
      Buffer.from(new web3.PublicKey(value).toBytes()).copy(data, 40);
      data.writeBigUInt64LE(5000n, 72);
      return Promise.resolve({
        data,
        owner: web3.SystemProgram.programId,
        lamports: 1_447_680,
        executable: false,
        rentEpoch: 0,
      });
    }
    if (this.tokenAccounts.has(address)) {
      const data = Buffer.alloc(spl.ACCOUNT_SIZE);
      spl.AccountLayout.encode(
        {
          mint: new web3.PublicKey(USDC_MAINNET),
          owner: web3.Keypair.fromSeed(TREASURY_SEED).publicKey,
          amount: 10_000_000_000n,
          delegateOption: 0,
          delegate: web3.PublicKey.default,
          state: 1,
          isNativeOption: 0,
          isNative: 0n,
          delegatedAmount: 0n,
          closeAuthorityOption: 0,
          closeAuthority: web3.PublicKey.default,
        },
        data,
      );
      return Promise.resolve({
        data,
        owner: spl.TOKEN_PROGRAM_ID,
        lamports: 2_039_280,
        executable: false,
        rentEpoch: 0,
      });
    }
    return Promise.resolve(null);
  }

  /** An UNRECORDED transaction (another tool, another process) advances the nonce. */
  externalAdvance(account: string): void {
    this.nonces.get(account)!.history.push({ slot: this.slot, value: this.freshValue() });
  }

  payouts(): ClusterTx[] {
    return [...this.txs.values()].filter(
      (t) => t.kind === "payout" || t.kind === "blockhash_payout",
    );
  }

  landedOk(): ClusterTx[] {
    return this.payouts().filter((t) => t.state === "canonical" && !t.landErr);
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeSig(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// ── scripts ──────────────────────────────────────────────────────────────

type Script =
  | "lands"
  | "lands_err"
  | "dropped"
  | "fork_ok_never"
  | "fork_err_then_lands"
  | "halt_then_lands"
  | "late_lands"
  | "nonce_lane_unavailable";

const SCRIPTS: Script[] = [
  "lands",
  "lands_err",
  "dropped",
  "fork_ok_never",
  "fork_err_then_lands",
  "halt_then_lands",
  "late_lands",
  "nonce_lane_unavailable",
];

function fatesFor(script: Script): (kind: TxKind, index: number) => Fate {
  return (kind) => {
    if (kind === "create_nonce") {
      return script === "nonce_lane_unavailable" ? { kind: "drop" } : { kind: "land", delay: 1 };
    }
    if (kind === "kill" || kind === "other") return { kind: "land", delay: 1 };
    switch (script) {
      case "lands":
      case "nonce_lane_unavailable":
        return { kind: "land", delay: 2 };
      case "lands_err":
        return { kind: "land", delay: 2, err: true };
      case "dropped":
        return { kind: "drop" };
      case "fork_ok_never":
        return { kind: "fork", err: false };
      case "fork_err_then_lands":
        return { kind: "fork", err: true, thenLand: { delay: 100 } };
      case "halt_then_lands":
        return { kind: "land", delay: 5 };
      case "late_lands":
        return { kind: "land", delay: 600 };
    }
  };
}

// ── relay helpers ────────────────────────────────────────────────────────

interface Row {
  withdrawal_id: string;
  status: string;
  payout_reference: string | null;
}

function rowsOf(r: SyncRelay, mid: string): Row[] {
  return r.moteDb.db
    .prepare(
      "SELECT withdrawal_id, status, payout_reference FROM relay_withdrawals WHERE motebit_id = ?",
    )
    .all(mid) as Row[];
}

function refunds(r: SyncRelay, mid: string): number {
  const ids = new Set(rowsOf(r, mid).map((w) => w.withdrawal_id));
  return getTransactions(r.moteDb.db, mid, 200).filter(
    (t) => t.reference_id != null && ids.has(t.reference_id) && t.amount > 0,
  ).length;
}

function balance(r: SyncRelay, mid: string): number {
  return getAccountBalance(r.moteDb.db, mid)?.balance ?? 0;
}

async function adminQueueIds(r: SyncRelay): Promise<Set<string>> {
  const res = await r.app.request(`/api/v1/admin/withdrawals/pending`, { headers: AUTH_HEADER });
  const body = (await res.json()) as { withdrawals: Array<{ withdrawal_id: string }> };
  return new Set(body.withdrawals.map((w) => w.withdrawal_id));
}

function admin(
  r: SyncRelay,
  id: string,
  verb: "fail" | "complete" | "reconcile",
  body: Record<string, unknown>,
): Promise<Response> {
  return Promise.resolve(
    r.app.request(`/api/v1/admin/withdrawals/${id}/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(body),
    }),
  );
}

async function registerAndFund(r: SyncRelay, mid: string): Promise<void> {
  const kp = await generateKeypair();
  await r.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: mid,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  creditAccount(r.moteDb.db, mid, FUNDED, "deposit", `${mid}-dep`, "self-deposit");
}

/** The relay's background resolution, one tick — whichever this build has. */
/** Errors the resolution tick raised (the supervisor's alarm), per cell. */
let alarms: string[] = [];

async function resolveOnce(r: SyncRelay, operator: OperatorSolanaTransfer): Promise<void> {
  const hook = (r as unknown as { withdrawalPayouts?: { resolveOnce(): Promise<void> } })
    .withdrawalPayouts;
  if (hook) {
    try {
      await hook.resolveOnce();
    } catch (err) {
      alarms.push(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  const sweep = (chainPayouts as unknown as Record<string, unknown>).runFreshVerdictSweep as
    ((db: unknown, reader: unknown) => Promise<number>) | undefined;
  if (sweep) await sweep(r.moteDb.db, operator);
}

function makeRealTransfer(
  cluster: AgaveCluster,
  opts: { nonceSeedSuffix?: string } = {},
): OperatorSolanaTransfer {
  let virtualNow = realNow();
  const waits = {
    pollMs: 2_000,
    maxWaitMs: 60_000,
    // Waiting is where time passes: the chain moves 5 slots per 2 s.
    sleep: (ms: number) => {
      cluster.advance(Math.ceil(ms / 400));
      virtualNow += ms;
      return Promise.resolve();
    },
    now: () => virtualNow,
  };
  const adapter = new Web3JsRpcAdapter({
    rpcUrl: "http://127.0.0.1:1",
    identitySeed: TREASURY_SEED,
    expiryConfirm: waits,
    ...({ finality: waits, rpcTimeoutMs: 5_000 } as Record<string, unknown>),
    ...(opts.nonceSeedSuffix !== undefined ? { nonceSeedSuffix: opts.nonceSeedSuffix } : {}),
  });
  (adapter as unknown as { connection: unknown }).connection = cluster.connection();
  return new OperatorSolanaTransfer(adapter);
}

/** An honest operator: looks at the CANONICAL chain and asks the relay to settle what it sees. */
async function truthfulOperator(
  r: SyncRelay,
  mid: string,
  cluster: AgaveCluster,
  misled: boolean,
): Promise<void> {
  const landed = cluster.landedOk();
  for (const w of rowsOf(r, mid)) {
    if (misled && w.status === "processing" && landed.length > 0) {
      // An explorer on a lagging node shows nothing yet.
      await admin(r, w.withdrawal_id, "reconcile", {
        outcome: "not_paid",
        attestation: "my explorer shows nothing for this payout",
      });
    }
    if (w.status === "processing") {
      await admin(
        r,
        w.withdrawal_id,
        "reconcile",
        landed.length > 0
          ? {
              outcome: "paid",
              payout_reference: landed[0]!.signature,
              attestation: `explorer shows ${landed[0]!.signature} paid the destination`,
            }
          : { outcome: "not_paid", attestation: "explorer shows no transfer to the destination" },
      );
    } else if (w.status === "pending") {
      if (landed.length > 0) {
        await admin(r, w.withdrawal_id, "complete", { payout_reference: landed[0]!.signature });
      } else {
        await admin(r, w.withdrawal_id, "fail", { reason: "nothing on chain" });
      }
    }
  }
}

const OPEN = new Set(["pending", "processing"]);

async function oracle(
  r: SyncRelay,
  mid: string,
  cluster: AgaveCluster,
  step: string,
  final: boolean,
): Promise<string[]> {
  const out: string[] = [];
  const rows = rowsOf(r, mid);
  const landed = cluster.landedOk();
  const refunded = refunds(r, mid);
  if (refunded + landed.length > 1) {
    out.push(`${step}: value out twice (refunds=${refunded}, landed=${landed.length})`);
  }
  if (refunded > 0 && cluster.payouts().some((t) => cluster.canLand(t))) {
    out.push(`${step}: refunded while a payout can still land`);
  }
  for (const w of rows) {
    if (w.status === "completed" && !landed.some((t) => t.signature === w.payout_reference)) {
      out.push(`${step}: completed with ${w.payout_reference}, which did not land`);
    }
  }
  const W_MICRO = W_USD * 1_000_000;
  if (balance(r, mid) !== FUNDED - rows.length * W_MICRO + refunded * W_MICRO) {
    out.push(`${step}: balance ${balance(r, mid)} is not exact`);
  }
  const queue = await adminQueueIds(r);
  for (const w of rows) {
    if (OPEN.has(w.status) && !queue.has(w.withdrawal_id)) {
      out.push(`${step}: open withdrawal ${w.status} not on the operator's queue`);
    }
  }
  if (final) {
    if (cluster.payouts().some((t) => cluster.canLand(t))) {
      out.push(`${step}: a payout can still land at the end (the harness must decide the chain)`);
    }
    for (const w of rows) {
      if (OPEN.has(w.status)) out.push(`${step}: stuck ${w.status} after the chain decided`);
      else if (landed.length > 0 && w.status !== "completed")
        out.push(`${step}: a payout landed but the row is ${w.status}`);
      else if (landed.length === 0 && (w.status !== "failed" || refunded !== 1))
        out.push(`${step}: nothing landed but the row is ${w.status} with ${refunded} refund(s)`);
    }
  }
  return out;
}

const PHASES: Array<{ name: string; move: (c: AgaveCluster) => void }> = [
  { name: "P0 right after the send", move: () => {} },
  {
    name: "P1 +10 slots, clock +1 min",
    move: (c) => {
      c.advance(10);
      jumpClock(MIN);
    },
  },
  {
    name: "P2 chain resumes, +60 slots, clock +10 min",
    move: (c) => {
      c.halted = false;
      c.advance(60);
      jumpClock(10 * MIN);
    },
  },
  {
    name: "P3 +200 slots, clock +10 min",
    move: (c) => {
      c.advance(200);
      jumpClock(10 * MIN);
    },
  },
  {
    name: "P4 +700 slots, clock +1 h",
    move: (c) => {
      c.advance(700);
      jumpClock(HOUR);
    },
  },
  {
    name: "P5 +100 slots, clock +1 h",
    move: (c) => {
      c.advance(100);
      jumpClock(HOUR);
    },
  },
];

type Timing = "prompt" | "late";
const WITNESSES: Witness[] = ["honest", "lagging_lb", "bigtable_absent"];
const TIMINGS: Timing[] = ["prompt", "late"];

const CELLS = SCRIPTS.flatMap((script) =>
  WITNESSES.flatMap((witness) => TIMINGS.map((timing) => ({ script, witness, timing }))),
);

let relay: SyncRelay | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  clockOffset = 0;
  await relay?.close();
  relay = undefined;
});

/** The treasury's derived nonce address (the default seed). */
async function nonceAddressOf(): Promise<string> {
  const treasury = web3.Keypair.fromSeed(TREASURY_SEED).publicKey;
  return (
    await web3.PublicKey.createWithSeed(
      treasury,
      "motebit-payout-nonce-v1",
      web3.SystemProgram.programId,
    )
  ).toBase58();
}

/** What the last cell's cluster saw, for the mechanism checks below. */
let lastCluster: AgaveCluster | undefined;
let lastRows: Row[] = [];

async function runCell(
  script: Script,
  witness: Witness,
  timing: Timing,
  setup?: (c: AgaveCluster, nonceAddress: string) => void,
): Promise<string[]> {
  alarms = [];
  const treasury = web3.Keypair.fromSeed(TREASURY_SEED).publicKey;
  const sourceAta: string = spl
    .getAssociatedTokenAddressSync(new web3.PublicKey(USDC_MAINNET), treasury)
    .toBase58();
  const cluster = new AgaveCluster(fatesFor(script), new Set([sourceAta]));
  cluster.witness = witness;
  setup?.(cluster, await nonceAddressOf());
  const operator = makeRealTransfer(cluster);
  relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
  const mid = `zzag-${script}-${witness}-${timing}`;
  await registerAndFund(relay, mid);

  const headers = jsonAuthWithIdempotency();
  const post = () =>
    relay!.app.request(`/api/v1/agents/${mid}/withdraw`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount: W_USD, destination: DEST }),
    });
  cluster.haltOnPayout = script === "halt_then_lands";
  // 1c: the sender loses its connection while the fork shows an error.
  if (script === "fork_err_then_lands") cluster.confirmError = "socket hang up";
  await post();
  cluster.haltOnPayout = false;
  await post(); // a replay never sends again

  const violations: string[] = [];
  const payoutBroadcasts = cluster.payouts().filter((t) => t.kind === "payout").length;
  if (payoutBroadcasts > 1) violations.push(`durable payout broadcast ${payoutBroadcasts} times`);
  for (const [i, phase] of PHASES.entries()) {
    phase.move(cluster);
    await resolveOnce(relay, operator);
    cluster.advance(40);
    await resolveOnce(relay, operator);
    if (timing === "prompt" || i >= 3) await truthfulOperator(relay, mid, cluster, true);
    violations.push(...(await oracle(relay, mid, cluster, phase.name, i === PHASES.length - 1)));
  }
  lastCluster = cluster;
  lastRows = rowsOf(relay, mid);
  return violations;
}

describe("Path 0 against released agave — real adapter, real routes (#949 round 6, #990)", () => {
  it.each(CELLS)("$script × $witness × $timing", async ({ script, witness, timing }) => {
    expect(await runCell(script, witness, timing)).toEqual([]);
  });
});

describe("the reviewer's 655267bf4 findings, named", () => {
  it("1a: a payout that never lands is resolved (refunded once, after it provably cannot land)", async () => {
    expect(await runCell("dropped", "honest", "prompt")).toEqual([]);
  });
  it("1b: a processed minority-fork status is never taken as landed", async () => {
    expect(await runCell("fork_ok_never", "honest", "prompt")).toEqual([]);
  });
  it("1c: a processed minority-fork ERROR is never taken as failed (no refund, then landing)", async () => {
    expect(await runCell("fork_err_then_lands", "honest", "prompt")).toEqual([]);
  });
});

describe("the mechanism: durable nonce, finalized status, kill (#990)", () => {
  const kinds = (c: AgaveCluster) => [...c.txs.values()].map((t) => `${t.kind}:${t.state}`);

  it("a landed payout is a durable-nonce transaction, completed only once finalized", async () => {
    expect(await runCell("lands", "honest", "prompt")).toEqual([]);
    const payouts = lastCluster!.payouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.kind).toBe("payout");
    expect(payouts[0]!.nonceValue).toBeTruthy();
    expect(kinds(lastCluster!)).not.toContain("kill:canonical");
    expect(lastRows.map((r) => r.status)).toEqual(["completed"]);
  });

  it("a payout that never lands is refunded only after its kill is on the canonical chain", async () => {
    expect(await runCell("dropped", "honest", "late")).toEqual([]);
    expect(kinds(lastCluster!)).toContain("kill:canonical");
    expect(lastRows.map((r) => r.status)).toEqual(["failed"]);
  });

  it("an unavailable nonce lane sends nothing; the withdrawal stays pending with a working /fail", async () => {
    expect(await runCell("nonce_lane_unavailable", "honest", "prompt")).toEqual([]);
    expect(lastCluster!.payouts()).toHaveLength(0);
    expect(lastRows.map((r) => r.status)).toEqual(["failed"]);
  });

  it("1c: the fork error is never read as failed — the payout completes, or its kill wins and refunds", async () => {
    expect(await runCell("fork_err_then_lands", "honest", "prompt")).toEqual([]);
    const k = kinds(lastCluster!);
    const status = lastRows[0]!.status;
    expect(
      (status === "completed" && k.includes("payout:canonical")) ||
        (status === "failed" && k.includes("kill:canonical")),
    ).toBe(true);
  });

  it("two concurrent withdrawals serialize over one lane: the second waits pending, then pays over the next nonce", async () => {
    const treasury = web3.Keypair.fromSeed(TREASURY_SEED).publicKey;
    const sourceAta: string = spl
      .getAssociatedTokenAddressSync(new web3.PublicKey(USDC_MAINNET), treasury)
      .toBase58();
    // The first payout lands late (it outlives the send's finality wait);
    // the second lands at once.
    const cluster = new AgaveCluster(
      (kind, index) =>
        kind === "payout"
          ? { kind: "land", delay: index === 0 ? 300 : 2 }
          : { kind: "land", delay: 1 },
      new Set([sourceAta]),
    );
    const operator = makeRealTransfer(cluster);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zzag-two-on-one-lane";
    await registerAndFund(relay, mid);
    const post = () =>
      relay!.app.request(`/api/v1/agents/${mid}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: W_USD, destination: DEST }),
      });
    await Promise.all([post(), post()]);
    const statuses = rowsOf(relay, mid)
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual(["pending", "processing"]);
    expect(await adminQueueIds(relay)).toHaveProperty("size", 2);
    for (let i = 0; i < 12; i++) {
      cluster.advance(60);
      await relay.withdrawalPayouts.resolveOnce();
    }
    const payouts = cluster.payouts();
    expect(payouts).toHaveLength(2);
    expect(new Set(payouts.map((p) => p.nonceValue)).size).toBe(2);
    expect(rowsOf(relay, mid).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(refunds(relay, mid)).toBe(0);
  });

  it.each([
    { name: "legacy_lands", lands: true },
    { name: "legacy_never", lands: false },
  ])(
    "$name: a claim an earlier process made without recording a signature — never refunded; paid accepted; never-landed is the documented stuck set",
    async ({ name, lands }) => {
      const treasury = web3.Keypair.fromSeed(TREASURY_SEED).publicKey;
      const sourceAta: string = spl
        .getAssociatedTokenAddressSync(new web3.PublicKey(USDC_MAINNET), treasury)
        .toBase58();
      const cluster = new AgaveCluster(() => ({ kind: "land", delay: 1 }), new Set([sourceAta]));
      const operator = makeRealTransfer(cluster);
      relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
      const mid = `zzag-${name}`;
      await registerAndFund(relay, mid);
      const res = await relay.app.request(`/api/v1/agents/${mid}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: W_USD, destination: "not-a-payout-address" }),
      });
      const id = ((await res.json()) as { withdrawal: { withdrawal_id: string } }).withdrawal
        .withdrawal_id;
      relay.moteDb.db
        .prepare(
          "UPDATE relay_withdrawals SET status = 'processing', destination = ?, claimed_at = ?, payout_valid_until = NULL WHERE withdrawal_id = ?",
        )
        .run(DEST, Date.now() - 20 * MIN, id);
      const legacySig = "LegacyPayoutSignature".padEnd(88, "L");
      for (const phase of PHASES) {
        phase.move(cluster);
        await relay.withdrawalPayouts.resolveOnce();
        const not = await admin(relay, id, "reconcile", {
          outcome: "not_paid",
          attestation: "explorer shows nothing",
        });
        if (rowsOf(relay, mid)[0]!.status === "processing") expect(not.status).toBe(409);
        if (lands) {
          await admin(relay, id, "reconcile", {
            outcome: "paid",
            payout_reference: legacySig,
            attestation: "explorer shows the legacy payout landed",
          });
        }
      }
      expect(refunds(relay, mid)).toBe(0);
      expect(rowsOf(relay, mid)[0]!.status).toBe(lands ? "completed" : "processing");
    },
  );
});

// ── round 7: the lane's public address can be squatted (C1) ──────────────

describe("the nonce lane's address is public: every squat state (#990 round 7, C1)", () => {
  const SYSTEM = () => web3.SystemProgram.programId.toBase58();

  it("pre-funded, system-owned, 0 bytes (the ~$0.15 attack): the relay TAKES IT OVER and pays", async () => {
    expect(
      await runCell("lands", "honest", "prompt", (c, addr) =>
        c.raw.set(addr, { owner: SYSTEM(), dataLen: 0, lamports: 890_880 }),
      ),
    ).toEqual([]);
    expect(lastCluster!.landedOk()).toHaveLength(1);
    expect(lastRows.map((r) => r.status)).toEqual(["completed"]);
  });

  it("pre-funded with MORE than the rent: taken over without a top-up, pays", async () => {
    expect(
      await runCell("lands", "honest", "prompt", (c, addr) =>
        c.raw.set(addr, { owner: SYSTEM(), dataLen: 0, lamports: 5_000_000 }),
      ),
    ).toEqual([]);
    expect(lastRows.map((r) => r.status)).toEqual(["completed"]);
  });

  const UNRECOVERABLE: Array<{ name: string; set: (c: AgaveCluster, addr: string) => void }> = [
    {
      name: "owned by another program",
      set: (c, addr) =>
        c.raw.set(addr, {
          owner: spl.TOKEN_PROGRAM_ID.toBase58(),
          dataLen: 165,
          lamports: 2_039_280,
        }),
    },
    {
      name: "system-owned with partial data (unreachable without the treasury key; fail closed anyway)",
      set: (c, addr) => c.raw.set(addr, { owner: SYSTEM(), dataLen: 10, lamports: 1_000_000 }),
    },
    {
      name: "a nonce account whose authority is not the treasury",
      set: (c, addr) =>
        c.nonces.set(addr, {
          authority: web3.Keypair.generate().publicKey.toBase58(),
          created: 0,
          history: [{ slot: 0, value: web3.Keypair.generate().publicKey.toBase58() }],
        }),
    },
  ];

  it.each(UNRECOVERABLE)(
    "$name: fail closed — nothing sent, the withdrawal stays pending (/fail works), and the loop raises an alarm naming the address",
    async ({ set }) => {
      expect(await runCell("lands", "honest", "prompt", set)).toEqual([]);
      expect(lastCluster!.payouts()).toHaveLength(0);
      const addr = await nonceAddressOf();
      expect(alarms.some((a) => a.includes(addr))).toBe(true);
    },
  );
});

// ── round 7: the nonce advanced by a transaction we never recorded (P1) ───

describe("an unrecorded transaction consumes the in-flight payout's nonce (#990 round 7, P1)", () => {
  async function inFlightThenExternalAdvance(mid: string) {
    const treasury = web3.Keypair.fromSeed(TREASURY_SEED).publicKey;
    const sourceAta: string = spl
      .getAssociatedTokenAddressSync(new web3.PublicKey(USDC_MAINNET), treasury)
      .toBase58();
    const cluster = new AgaveCluster(fatesFor("dropped"), new Set([sourceAta]));
    const operator = makeRealTransfer(cluster);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, mid);
    await relay.app.request(`/api/v1/agents/${mid}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: W_USD, destination: DEST }),
    });
    const id = rowsOf(relay, mid)[0]!.withdrawal_id;
    expect(rowsOf(relay, mid)[0]!.status).toBe("processing");
    cluster.externalAdvance(await nonceAddressOf());
    cluster.advance(80); // finalized sees the advance
    return { cluster, id };
  }

  it("not_paid answers the truth — 409 nonce_consumed_unrecorded, and no kill is recorded as sent", async () => {
    const mid = "zzag-p1-honest";
    const { cluster, id } = await inFlightThenExternalAdvance(mid);
    const res = await admin(relay!, id, "reconcile", {
      outcome: "not_paid",
      attestation: "explorer shows nothing",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("nonce_consumed_unrecorded");
    expect([...cluster.txs.values()].filter((t) => t.kind === "kill")).toHaveLength(0);
    expect(refunds(relay!, mid)).toBe(0);
  });

  it("the operator's explicit, attested not_paid override refunds once — the payout provably cannot land", async () => {
    const mid = "zzag-p1-override";
    const { cluster, id } = await inFlightThenExternalAdvance(mid);
    const res = await admin(relay!, id, "reconcile", {
      outcome: "not_paid",
      override: "nonce_consumed_unrecorded",
      attestation: "the treasury ran a manual nonce advance at 12:00; the payout never landed",
    });
    expect(res.status).toBe(200);
    expect(refunds(relay!, mid)).toBe(1);
    expect(cluster.payouts().some((t) => cluster.canLand(t))).toBe(false);
    expect(cluster.landedOk()).toHaveLength(0);
  });

  it("paid naming the recorded payout is still accepted", async () => {
    const mid = "zzag-p1-paid";
    const { cluster, id } = await inFlightThenExternalAdvance(mid);
    const sig = cluster.payouts()[0]!.signature;
    const res = await admin(relay!, id, "reconcile", {
      outcome: "paid",
      payout_reference: sig,
      attestation: "an archive explorer shows it landed",
    });
    expect(res.status).toBe(200);
    expect(refunds(relay!, mid)).toBe(0);
  });
});

// ── round 8: "different" is not "past" (C-1); seed rotation (P-a) ────────

describe("a stale finalized account read never proves a nonce consumed (#990 round 8, C-1)", () => {
  /** W2 alone: refunded while its own payout landed or can still land is value out twice. */
  function w2Violations(cluster: AgaveCluster, mid: string, id: string, step: string): string[] {
    const sigs = new Set(
      (
        relay!.moteDb.db
          .prepare(
            "SELECT signature FROM relay_withdrawal_payout_attempts WHERE withdrawal_id = ? AND kind = 'payout'",
          )
          .all(id) as Array<{ signature: string }>
      ).map((r) => r.signature),
    );
    const mine = cluster.payouts().filter((t) => sigs.has(t.signature));
    const refunded = getTransactions(relay!.moteDb.db, mid, 200).some(
      (t) => t.reference_id === id && t.amount > 0,
    );
    const out: string[] = [];
    if (refunded && mine.some((t) => t.state === "canonical" && !t.landErr)) {
      out.push(`${step}: W2 refunded AND its payout landed — value out twice`);
    }
    if (refunded && mine.some((t) => cluster.canLand(t))) {
      out.push(`${step}: W2 refunded while its payout can still land`);
    }
    return out;
  }

  async function twoPayouts(mid: string, externalBetween: boolean) {
    const treasury = web3.Keypair.fromSeed(TREASURY_SEED).publicKey;
    const sourceAta: string = spl
      .getAssociatedTokenAddressSync(new web3.PublicKey(USDC_MAINNET), treasury)
      .toBase58();
    // W1 lands at once; W2 is forwarded, the send errors, and it lands 200
    // slots later — if its nonce is still there.
    const cluster = new AgaveCluster(
      (kind, index) =>
        kind === "payout"
          ? { kind: "land", delay: index === 0 ? 2 : 200 }
          : { kind: "land", delay: 1 },
      new Set([sourceAta]),
    );
    const operator = makeRealTransfer(cluster);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, mid);
    const post = () =>
      relay!.app.request(`/api/v1/agents/${mid}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: W_USD, destination: DEST }),
      });
    await post(); // W1: completes
    if (externalBetween) {
      // An unrecorded transaction advances the lane between W1 and W2.
      cluster.externalAdvance(await nonceAddressOf());
      cluster.advance(40);
    }
    cluster.forwardThenError = true;
    await post(); // W2: forwarded, then the send errors ⇒ processing
    const w2 = rowsOf(relay, mid).find((r) => r.status === "processing")!;
    return { cluster, w2 };
  }

  for (const externalBetween of [false, true]) {
    it(`an honest operator's not_paid + override while a lagging node serves the lane${externalBetween ? " (after an unrecorded advance)" : ""}: never value out twice`, async () => {
      const mid = `zzag-c1-${externalBetween ? "ext" : "plain"}`;
      const { cluster, w2 } = await twoPayouts(mid, externalBetween);
      const violations: string[] = [];
      for (const body of [
        { outcome: "not_paid", attestation: "explorer shows nothing" },
        {
          outcome: "not_paid",
          override: "nonce_consumed_unrecorded",
          attestation: "the relay says the nonce moved and nothing of ours landed",
        },
      ]) {
        cluster.staleAccountReads = 1;
        await admin(relay!, w2.withdrawal_id, "reconcile", body);
        violations.push(...w2Violations(cluster, mid, w2.withdrawal_id, "after reconcile"));
      }
      cluster.advance(260);
      await resolveOnce(relay!, undefined as unknown as OperatorSolanaTransfer);
      await resolveOnce(relay!, undefined as unknown as OperatorSolanaTransfer);
      violations.push(...w2Violations(cluster, mid, w2.withdrawal_id, "after W2's landing window"));
      expect(violations).toEqual([]);
    });
  }
});

describe("seed rotation never strands a payout over the OLD lane (#990 round 8, P-a)", () => {
  it("a dropped old-lane payout is killed on its OWN nonce account after rotation, then refunded", async () => {
    const treasury = web3.Keypair.fromSeed(TREASURY_SEED).publicKey;
    const sourceAta: string = spl
      .getAssociatedTokenAddressSync(new web3.PublicKey(USDC_MAINNET), treasury)
      .toBase58();
    const cluster = new AgaveCluster(fatesFor("dropped"), new Set([sourceAta]));
    const operator = makeRealTransfer(cluster);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zzag-pa-rotate";
    await registerAndFund(relay, mid);
    await relay.app.request(`/api/v1/agents/${mid}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: W_USD, destination: DEST }),
    });
    expect(rowsOf(relay, mid)[0]!.status).toBe("processing");
    // The operator rotates the lane (the same relay, now deriving "-r2").
    const adapter = (operator as unknown as { adapter: Record<string, unknown> }).adapter;
    adapter["nonceSeed"] = "motebit-payout-nonce-v1-r2";
    adapter["nonceAddress"] = null;
    const violations: string[] = [];
    for (let i = 0; i < 4; i++) {
      cluster.advance(80);
      jumpClock(3 * MIN);
      await resolveOnce(relay, operator);
    }
    violations.push(...(await oracle(relay, mid, cluster, "after rotation", true)));
    expect(violations).toEqual([]);
    expect(rowsOf(relay, mid)[0]!.status).toBe("failed");
  });
});

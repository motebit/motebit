/**
 * SolanaRpcAdapter — the boundary between the rail interface and any
 * concrete Solana RPC client.
 *
 * The adapter is intentionally narrow: it does only the four things
 * the rail needs (own address, balance, send, reachability). All
 * @solana/web3.js (or @solana/kit, or any other library) coupling
 * lives in concrete implementations of this interface — never in the
 * rail itself.
 *
 * Tests inject a fake adapter; production wires the Web3JsRpcAdapter.
 */

export interface SendUsdcArgs {
  /** Recipient base58 Solana address. */
  toAddress: string;
  /** Amount in USDC micro-units (6 decimals). */
  microAmount: bigint;
}

/**
 * Outcome of one `sendUsdc` call. The call RESOLVES only when the outcome
 * of the returned `signature` is known; a timeout, an expired blockhash on
 * the last attempt, or any other unknown outcome REJECTS (throws) — it never
 * resolves with `confirmed: false`.
 */
export interface SendUsdcResult {
  /**
   * Signature (base58) of the LAST transaction broadcast. When the adapter
   * re-signed and re-broadcast (e.g. after a blockhash expiry), earlier
   * signatures are not reported here and `confirmed` describes only this one.
   */
  signature: string;
  /** Slot of the RPC context that reported the outcome of `signature`. */
  slot: number;
  /**
   * `true`: `signature` landed at the configured commitment with no error —
   * funds moved. `false`: `signature` LANDED and FAILED on chain (a processed
   * transaction with an error; Solana transactions are atomic, so it moved no
   * funds — only the fee was charged). `false` never means "not yet
   * confirmed" or "unknown": those reject. It says nothing about any EARLIER
   * broadcast of the same payout — see `earlierBroadcastsDead`.
   */
  confirmed: boolean;
  /**
   * Whether it is PROVEN that no earlier broadcast of this same payout can
   * land. `true` only when the adapter broadcast exactly one signature, OR
   * every earlier signature was proven dead on chain (its blockhash expired,
   * established by a slot-consistent read). `false` or absent = unknown: an
   * earlier broadcast may have landed and paid, so a consumer MUST NOT treat
   * `confirmed: false` as "nothing was paid" (e.g. refund a withdrawal)
   * unless this is `true` (issue #920).
   */
  earlierBroadcastsDead?: boolean;
}

/**
 * Per-item outcome in a batch send. Either the item landed in a
 * confirmed transaction (ok=true, signature present) or it failed
 * (ok=false, reason present). Items within a single Solana transaction
 * are atomic — they all succeed or all fail together. Items that were
 * not submitted because a prior chunk failed return ok=false with
 * reason "prior chunk failed."
 */
export interface SendUsdcBatchItemResult {
  ok: boolean;
  signature: string | null;
  slot: number;
  reason: string | null;
  /**
   * `SendUsdcResult.earlierBroadcastsDead` for the transaction that carried
   * this item. Absent when the item has no transaction outcome (its chunk
   * threw or was never sent) — unknown, never assumed.
   */
  earlierBroadcastsDead?: boolean;
}

/**
 * One recipient leg of a confirmed SPL transfer. A single signed Solana
 * transaction can carry multiple SPL Transfer instructions atomically
 * (one payer, N recipients) — the canonical shape for Motebit's P2P
 * settlement after Arc 2 of the off-ramp arc, where the delegator's
 * single tx pays the worker (one leg) AND the relay treasury (another
 * leg) in the same atomic transaction.
 *
 * `to` is the base58 **owner** address (NOT the Associated Token
 * Account address); the verifier compares directly to declared
 * settlement / treasury addresses. `amountMicro` is the exact transfer
 * amount — §11.1 forbids `>=` matching.
 */
export interface ConfirmedTransferLeg {
  to: string;
  amountMicro: bigint;
}

/**
 * Closed, motebit-shaped result of looking up a Solana transaction by
 * signature. The discrimination is load-bearing: p2p payment
 * verification MUST distinguish `not_found` (authoritative null,
 * terminal, triggers trust downgrade) from `rpc_error` (transient,
 * retry, never downgrades trust). See `spec/settlement-v1.md` §11.1
 * Foundation Law: "Payment verification status MUST distinguish
 * between transaction not found (permanent) and RPC error
 * (transient/retryable). A transient error MUST NOT trigger trust
 * downgrade."
 *
 *   - `not_found`: the tx does not exist onchain at the configured
 *     commitment level. Also returned when the tx exists but carries
 *     no SPL transfer instruction the verifier can parse — the
 *     verifier should treat both the same (no verifiable payment).
 *     Also returned when MULTIPLE payers are present on the configured
 *     mint (genuinely ambiguous source — the delegator must be the
 *     sole payer for Motebit's P2P model). Multiple **recipients** are
 *     legitimate (Arc 2 fee-leg composition) and surface as multiple
 *     entries in `transfers[]`.
 *   - `confirmed`: the tx landed at the configured commitment with
 *     exactly one payer (`from`) and one-or-more recipients
 *     (`transfers[]`). The verifier walks `transfers[]` to find the
 *     legs it expects (e.g., worker payment, treasury fee). `asset` is
 *     the SPL mint's short name (today: always `"USDC"`).
 *   - `rpc_error`: any failure the RPC boundary couldn't classify as
 *     authoritative null. The caller retries; the settlement state
 *     stays pending.
 *
 * Doctrine: Arc 2 of the off-ramp arc replaced the single-recipient
 * `to` + `amountMicro` fields on the `confirmed` variant with a
 * `transfers[]` array, enabling atomic multi-output composition for the
 * P2P fee leg. The shape change is breaking for consumers that read
 * the prior single-recipient fields; the only authorized consumer (the
 * relay's `p2p-verifier.ts`) was updated in the same arc. See
 * `docs/doctrine/off-ramp-as-user-action.md` § "What Arc 1 did NOT close".
 */
export type TxVerificationResult =
  | { status: "not_found" }
  | {
      status: "confirmed";
      from: string;
      transfers: ConfirmedTransferLeg[];
      slot: number;
      asset: string;
    }
  | { status: "rpc_error"; reason: string };

/**
 * Query for {@link SolanaRpcAdapter.findOutgoingTransfer} — "did a transfer
 * of exactly `microAmount` USDC from this wallet to `toAddress` land at or
 * after `sinceMs`?" (#887).
 */
export interface OutgoingTransferQuery {
  /** Recipient base58 OWNER address (not the ATA). */
  toAddress: string;
  /** Exact amount in micro-units — never a `>=` match. */
  microAmount: bigint;
  /** Epoch ms; transactions whose block time is earlier are ignored. */
  sinceMs: number;
  /** Signatures the caller already accounts for (its own earlier payments). */
  excludeSignatures?: readonly string[];
}

/**
 * Closed result of an outgoing-transfer lookup. READ-ONLY: the lookup never
 * signs or broadcasts.
 *
 *   - `found`: exactly one landed transfer from this wallet matches.
 *   - `not_found`: no match in a window the lookup fully covered. NOT, by
 *     itself, proof that no transfer will land — a transaction still in
 *     flight is invisible until it lands. The rail decides when absence is
 *     authoritative (`SolanaWalletRail.confirmSend`).
 *   - `ambiguous`: more than one match — the caller cannot tell which is its
 *     own.
 *   - `rpc_error`: the lookup could not be completed (transient, or the
 *     window was larger than one page). Never read as absence.
 */
export type OutgoingTransferLookup =
  | { status: "found"; signature: string }
  | { status: "not_found" }
  | { status: "ambiguous"; signatures: string[] }
  | { status: "rpc_error"; reason: string };

/**
 * A transaction that has been SIGNED and is about to be broadcast (#885).
 * A Solana signature is fixed the moment the transaction is signed, so a
 * payer can record the exact transaction it is about to send before any
 * money moves — and, if the send throws, ask the chain about THAT
 * transaction instead of guessing from matching transfers.
 */
export interface SignedTransactionRef {
  /** Base58 transaction signature (the transaction id). */
  signature: string;
  /** The block height after which this transaction can never land. */
  lastValidBlockHeight: number;
  /**
   * A slot the signer read BEFORE fetching the blockhash this transaction is
   * signed over (#949 round 2). The transaction can only land after it (less
   * `LANDING_SLOT_MARGIN`), so a node whose retained history starts at or
   * before that slot has seen every slot the transaction could be in.
   * Absent = unknown: absence on chain can then never be proven complete by
   * a late reader (see `historyCoversLanding`).
   */
  recentSlot?: number;
}

/**
 * Slots subtracted from `recentSlot` for node skew: the slot was read from
 * one node, the transaction lands in a block another node produced.
 */
export const LANDING_SLOT_MARGIN = 512;

/**
 * Blocks below `lastValidBlockHeight` the transaction's blockhash can sit
 * (150), plus the same again for cross-node lag and 10 for the absence
 * margin — the height floor used when no `recentSlot` was recorded.
 */
export const LANDING_HEIGHT_WINDOW = 150 + 150 + 10;

/**
 * The lowest slot `tx` could have landed in (#949 rounds 2–3): its recorded
 * `recentSlot` less `LANDING_SLOT_MARGIN`; without one, a floor from its own
 * validity — every block's slot is at least its block height, and the
 * transaction lands above `lastValidBlockHeight − LANDING_HEIGHT_WINDOW`. The
 * floor is far below the real landing slot (slots run ahead of heights), so it
 * is decisive only on a node holding deep history — but it is never wrong, so
 * a transaction recorded without its slot still has a door.
 */
export function earliestLandingSlot(tx: SignedTransactionRef): number | null {
  if (typeof tx.recentSlot === "number" && Number.isSafeInteger(tx.recentSlot)) {
    return tx.recentSlot - LANDING_SLOT_MARGIN;
  }
  return Number.isSafeInteger(tx.lastValidBlockHeight)
    ? tx.lastValidBlockHeight - LANDING_HEIGHT_WINDOW
    : null;
}

/**
 * Whether a node whose retained history starts at `firstAvailableSlot` has
 * kept every slot `tx` could have landed in (#949 round 2). Absence of a
 * signature is evidence of absence only inside that window: many RPC nodes
 * prune history after days, and a landed transaction then reads as absent.
 */
export function historyCoversLanding(
  tx: SignedTransactionRef,
  firstAvailableSlot: number,
): boolean {
  const earliest = earliestLandingSlot(tx);
  return (
    earliest !== null && Number.isSafeInteger(firstAvailableSlot) && firstAvailableSlot <= earliest
  );
}
/**
 * Hooks around a broadcast. `beforeBroadcast` runs once per signed
 * transaction, after signing and BEFORE it is sent; a retry that re-signs
 * (blockhash expiry) calls it again with the new signature. If it throws,
 * that transaction is never sent — a payer that cannot record a payment
 * does not make it.
 */
export interface BroadcastHooks {
  beforeBroadcast?: (tx: SignedTransactionRef) => void | Promise<void>;
}

/**
 * What the chain says about ONE signed transaction (#885). READ-ONLY.
 *
 *   - `landed` — confirmed at the adapter's commitment and succeeded.
 *   - `failed` — confirmed, but the transaction errored: it moved nothing.
 *   - `expired` — not on chain and its blockhash is past
 *     `lastValidBlockHeight`: it can never land.
 *   - `pending` — not (yet) confirmed and still able to land; `seen`
 *     when a node reported it in a block.
 *   - `rpc_error` — the lookup could not be completed. Never absence.
 */
export type SignatureOutcome =
  | { status: "landed"; slot: number }
  | { status: "failed" }
  | { status: "expired" }
  /**
   * `seen: true` — a node reported the transaction IN A BLOCK (not yet at
   * the adapter's commitment). A caller asking again MUST NOT accept a
   * later `expired` for it: a slot-number comparison cannot tell a lagging
   * or minority-fork node from the canonical chain, and a transaction some
   * node has seen may well land (#885 round 5).
   */
  | { status: "pending"; seen?: true }
  /**
   * `historyPruned: true` — the transaction is past its last valid height and
   * the node has no record of it, but its retained history does not reach
   * back to where it could have landed: it may have landed and been pruned.
   * Undecided, never `expired` (#949 round 2).
   */
  | { status: "rpc_error"; reason: string; historyPruned?: true };

export interface SolanaRpcAdapter {
  /**
   * `true` ONLY for an adapter whose send paths call `hooks.beforeBroadcast`
   * for every transaction they sign, before sending it (#885). A payer
   * infers "nothing was sent" from "no signature was reported" — sound only
   * for an adapter that declares this. `SolanaWalletRail` exposes
   * `confirmP2pPayment` only over such an adapter.
   */
  readonly honorsBroadcastHooks?: boolean;

  /** The wallet's own base58 address (derived from the keypair seed). */
  readonly ownAddress: string;

  /** USDC balance in micro-units. Returns 0 if no token account exists yet. */
  getUsdcBalance(): Promise<bigint>;

  /**
   * USDC balance in micro-units at an ARBITRARY base58 owner address.
   *
   * Distinct from `getUsdcBalance()`, which reads only the adapter's OWN
   * Associated Token Account. This is the single authorized read of a
   * counterparty's balance — the commitment-bond verifier
   * (`services/relay/src/bond-verifier.ts`) uses it to confirm an agent's
   * self-declared backing at the agent's own sovereign address. It reads,
   * never moves: there is no custody implication. Returns 0 when no token
   * account exists for `ownerAddress`. Throws `InvalidSolanaAddressError`
   * when `ownerAddress` is not a valid base58 public key.
   */
  getUsdcBalanceOf(ownerAddress: string): Promise<bigint>;

  /** Native SOL balance in lamports. */
  getSolBalance(): Promise<bigint>;

  /**
   * Send USDC to a counterparty address. Creates the destination
   * Associated Token Account if it doesn't exist (payer = self).
   * Throws InsufficientUsdcBalanceError when the source balance is
   * lower than `microAmount`. Throws InvalidSolanaAddressError when
   * `toAddress` is not a valid base58 public key. Both are thrown only
   * BEFORE any transaction is signed — `SolanaWalletRail.confirmSend`
   * reads them as proof that nothing was broadcast (#887), so an
   * implementation must never throw either after a broadcast.
   */
  sendUsdc(args: SendUsdcArgs, hooks?: BroadcastHooks): Promise<SendUsdcResult>;

  /**
   * Send USDC to multiple counterparties in as few Solana transactions
   * as possible. Each transaction carries up to MAX_TRANSFERS_PER_TX
   * transfer instructions (conservative for the 1232-byte tx limit).
   * ATA creation instructions are prepended where needed.
   *
   * Chunking is internal. Fail-fast: if any chunk fails, subsequent
   * chunks are NOT submitted; their items return ok=false.
   */
  sendUsdcBatch(
    items: readonly SendUsdcArgs[],
    hooks?: BroadcastHooks,
  ): Promise<SendUsdcBatchItemResult[]>;

  /**
   * Fetch a transaction by signature and extract transfer details
   * sufficient to verify a p2p payment proof. Closed three-state
   * discriminated union — see `TxVerificationResult` for why the
   * boundary is classification, not retrieval.
   *
   * This method is the only authorized boundary through which relay
   * code may read Solana transactions. `services/relay/src/p2p-verifier.ts`
   * consumes it; do not add a second RPC path.
   */
  getTransaction(signature: string): Promise<TxVerificationResult>;

  /**
   * Look up whether a transfer of exactly `microAmount` USDC from this
   * wallet to `toAddress` landed at or after `sinceMs` (#887). Read-only —
   * the recovery read a payer runs when `sendUsdc` threw and it cannot know
   * from the error alone whether its transaction landed. Optional: an
   * adapter without it makes every ambiguous send failure `unknown`
   * (fail-closed — the caller must never pay again).
   */
  findOutgoingTransfer?(query: OutgoingTransferQuery): Promise<OutgoingTransferLookup>;

  /**
   * The chain's answer about ONE signed transaction (#885) — the recovery
   * read a payer runs when a send it recorded by signature threw. Read-only.
   * Optional: an adapter without it leaves every such failure undecidable
   * (the payer must not pay again).
   */
  getSignatureOutcome?(tx: SignedTransactionRef): Promise<SignatureOutcome>;

  /**
   * The chain's current block height at the adapter's decision commitment
   * (#949). Read-only. Block height — never wall-clock — is what bounds a
   * Solana transaction's life: it can land only at a height ≤ its
   * `lastValidBlockHeight`, and a halted cluster produces no heights however
   * long it is down. Optional: without it, a payer cannot bound a broadcast
   * it did not record, and must not treat that broadcast as dead. Rejects
   * on any read failure — never a guessed height.
   */
  getBlockHeight?(): Promise<number>;

  /**
   * The first slot the node still holds history for (`getFirstAvailableBlock`)
   * — the lower edge of what an "absent" status read can speak for (#949
   * round 2). Rejects on failure. Optional: without it a late absence read
   * can never be proven complete.
   */
  getFirstAvailableSlot?(): Promise<number>;

  /** Whether the RPC endpoint is reachable. Best-effort, no retries. */
  isReachable(): Promise<boolean>;
}

/**
 * The state machine. Pure orchestration over injected store + rpc +
 * onDeposit callback. Zero DB access, zero fetch calls — those live in
 * the store and rpc implementations respectively.
 *
 * Endgame pattern: ONE eth_getLogs per cycle fetches ALL Transfer events
 * in the block range, then we filter in-memory against the known-wallets
 * map. O(1) RPC calls regardless of wallet count.
 */

import type { DetectDepositsConfig, EvmTransferLog } from "./types.js";

/** Decoded log in motebit shape. */
interface DecodedTransfer {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  blockNumber: bigint;
}

function decodeTransfer(log: EvmTransferLog): DecodedTransfer {
  return {
    txHash: log.txHash,
    logIndex: log.logIndex,
    // topics[1]/[2] are 32-byte left-padded — strip "0x" + 24 leading hex chars.
    from: "0x" + log.fromTopic.slice(26).toLowerCase(),
    to: "0x" + log.toTopic.slice(26).toLowerCase(),
    value: BigInt(log.amountHex),
    blockNumber: log.blockNumber,
  };
}

/**
 * Run one detection cycle.
 *
 *  1. Get current block; subtract `confirmations` to get the safe horizon.
 *  2. Fetch Transfer logs from last cursor up to (and including) the safe horizon.
 *  3. Filter for transfers to known agent wallets.
 *  4. For each new (non-deduped) transfer, call `onDeposit`. The caller
 *     is responsible for the atomic dedup-record + credit-account write.
 *  5. Advance the cursor — but never past the safe horizon, so a deeper
 *     reorg cannot strand the cursor in a vanished branch.
 *
 * The confirmation horizon is the reorg-safety mechanism: a credit is only
 * issued for a log buried at least `confirmations` blocks deep, and the
 * cursor only advances over confirmed blocks. A reorg shallower than
 * `confirmations` cannot roll back a credit because the credit hadn't
 * happened yet at that depth. A reorg deeper than `confirmations` can in
 * principle, but for L2s on Base / Optimism / Arbitrum the practical
 * upper bound (block-checkpointing latency) is far below the depths a
 * conservative payment service uses, so the residual risk is on the same
 * order as L1 finality itself.
 *
 * Returns the number of `onDeposit` calls made in this cycle.
 */
export async function detectDeposits(config: DetectDepositsConfig): Promise<number> {
  const {
    store,
    rpc,
    chain,
    contractAddress,
    transferTopic,
    maxBlocksPerCycle,
    confirmations,
    onDeposit,
    logger,
  } = config;

  // Step 1 — current block. RPC failure collapses to 0 credits.
  let currentBlock: bigint;
  try {
    currentBlock = await rpc.getBlockNumber();
  } catch {
    return 0;
  }

  // Step 1.5 — apply the confirmation horizon. Never scan past
  // `currentBlock - confirmations`. Early-life chains where the head is
  // shallower than the confirmation depth scan nothing this cycle.
  const confirmationsBig = BigInt(confirmations);
  if (currentBlock <= confirmationsBig) return 0;
  const safeBlock = currentBlock - confirmationsBig;

  // Step 2 — compute the scan range from the stored cursor.
  const cursor = store.getCursor(chain);
  // On first run, start from the safe horizon — don't scan history.
  const lastBlock = cursor ?? safeBlock;
  if (lastBlock >= safeBlock) return 0;

  const fromBlock = lastBlock + BigInt(1);
  const toBlock =
    safeBlock - fromBlock > BigInt(maxBlocksPerCycle)
      ? fromBlock + BigInt(maxBlocksPerCycle)
      : safeBlock;

  // Step 3 — known wallets. If nothing to monitor, just advance the cursor.
  const wallets = store.getWallets();
  if (wallets.length === 0) {
    store.setCursor(chain, toBlock, Date.now());
    return 0;
  }

  const walletMap = new Map<string, string>(); // address (lc) → motebitId
  for (const w of wallets) walletMap.set(w.address.toLowerCase(), w.agentId);

  // Step 4 — ALL Transfer logs in the range, single RPC call.
  let rawLogs: EvmTransferLog[];
  try {
    rawLogs = await rpc.getTransferLogs({
      fromBlock,
      toBlock,
      contractAddress,
      topic0: transferTopic,
    });
  } catch {
    return 0;
  }

  let detected = 0;
  for (const raw of rawLogs) {
    const log = decodeTransfer(raw);
    const motebitId = walletMap.get(log.to);
    if (!motebitId) continue; // not an agent wallet

    if (store.hasProcessedLog(log.txHash, log.logIndex)) continue;

    if (log.value <= 0n) continue;

    try {
      await onDeposit({
        motebitId,
        amountOnchain: log.value,
        txHash: log.txHash,
        logIndex: log.logIndex,
        fromAddress: log.from,
        blockNumber: log.blockNumber,
        chain,
      });
      detected++;
    } catch (err) {
      // Individual failures don't halt the cycle — the dedup table is the
      // safety net against re-credit; the cursor still advances below.
      logger?.warn("deposit.credit_failed", {
        motebitId,
        txHash: log.txHash,
        logIndex: log.logIndex,
        chain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 5 — advance cursor unconditionally on successful scan.
  store.setCursor(chain, toBlock, Date.now());
  return detected;
}

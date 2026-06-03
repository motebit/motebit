/**
 * Sovereign wallet sweep — move accrued USDC out of a service's earnings wallet
 * to a destination it controls (an operator treasury / cold wallet).
 *
 * A P2P-capable service RECEIVES its earnings at its identity-derived Solana
 * address (the worker leg of each delegation's atomic settlement). Without a way
 * to move those funds, earnings pile up unspendable. This is the spend side: a
 * single, idempotent-enough sweep of the current balance. The caller (e.g. the
 * molecule runner) wraps it in a lifecycle loop — keeping timers/scheduling out
 * of this Layer-1 primitive so it stays pure + adapter-testable.
 *
 * The wallet pays its own SOL gas (wallet-solana CLAUDE.md rule 4) — fund the
 * service with a little SOL or sweeps fail with insufficient gas. This primitive
 * does not subsidize gas.
 */

/**
 * The minimal sovereign-wallet surface a sweep needs — structurally satisfied by
 * `SolanaWalletRail`. Taking an interface (not the concrete rail) keeps the sweep
 * testable with a fake and free of construction concerns.
 */
export interface SweepableWallet {
  /** Whether the RPC endpoint is reachable right now. */
  isAvailable(): Promise<boolean>;
  /** Current USDC balance in micro-units. */
  getBalance(): Promise<bigint>;
  /** Send `microAmount` micro-USDC to `toAddress`; returns the confirmed tx signature. */
  send(toAddress: string, microAmount: bigint): Promise<{ signature: string }>;
}

export interface SweepResult {
  /** True only when a transfer was broadcast. */
  swept: boolean;
  /** The balance observed at sweep time (micro-units). */
  balanceMicro: bigint;
  /** The transfer's tx signature, when `swept`. */
  signature?: string;
  /** Why no transfer happened (`rail_unavailable` | `below_min`), when `!swept`. */
  reason?: "rail_unavailable" | "below_min";
}

/**
 * Sweep the wallet's full current USDC balance to `destinationAddress`, but only
 * when it is at least `minSweepMicro` (so small dust doesn't burn a gas fee per
 * tick). No-ops (without sending) when the rail is unreachable or the balance is
 * below the floor. Returns what happened; never throws for the no-send cases —
 * a real send failure (insufficient gas, RPC error) propagates from `send` for
 * the caller's loop to catch and log.
 *
 * @param wallet the sovereign wallet to sweep FROM (its own identity wallet)
 * @param destinationAddress the address to sweep TO (base58 — an operator-controlled wallet)
 * @param minSweepMicro do not sweep below this balance (micro-units; e.g. 1_000 = $0.001)
 */
export async function sweepWalletRail(
  wallet: SweepableWallet,
  destinationAddress: string,
  minSweepMicro: bigint,
): Promise<SweepResult> {
  if (!(await wallet.isAvailable())) {
    return { swept: false, balanceMicro: 0n, reason: "rail_unavailable" };
  }
  const balanceMicro = await wallet.getBalance();
  if (balanceMicro < minSweepMicro) {
    return { swept: false, balanceMicro, reason: "below_min" };
  }
  const { signature } = await wallet.send(destinationAddress, balanceMicro);
  return { swept: true, balanceMicro, signature };
}

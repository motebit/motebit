/**
 * `motebit wallet` — display the motebit's sovereign Solana wallet.
 *
 * Jobsian minimal: show the address (always derivable from the identity
 * key) and the USDC balance (requires an RPC call). No send command in
 * v1 — this is observability only. Sending happens from the runtime
 * during actual motebit-to-motebit transactions, not as a human-driven
 * CLI action.
 *
 * The command lives at the subcommand layer and does NOT spin up a full
 * runtime. It loads the identity key from the CLI config, derives the
 * Solana address via `@motebit/wallet-solana`, and queries the balance
 * directly. Lightweight, fast, read-only.
 *
 * See `spec/settlement-v1.md` §6 for the Ed25519/Solana coincidence that
 * makes this work — the motebit's identity public key IS a valid Solana
 * address, no second key, no binding ceremony.
 */

import { createSolanaWalletRail } from "@motebit/wallet-solana";
import { fromMicro } from "@motebit/sdk";
import { secureErase } from "@motebit/encryption";
import { loadFullConfig } from "../config.js";
import { loadActiveSigningKey, IdentityKeyError } from "../identity.js";
import { NO_IDENTITY_MESSAGE } from "./_helpers.js";

interface WalletOptions {
  /** Solana RPC endpoint. Defaults to mainnet-beta public RPC. */
  rpcUrl?: string;
  /** Skip the balance query (address-only). Useful for scripts. */
  addressOnly?: boolean;
}

export async function handleWallet(options: WalletOptions = {}): Promise<void> {
  const config = loadFullConfig();

  if (!config.motebit_id) {
    console.error(NO_IDENTITY_MESSAGE);
    process.exit(1);
  }

  let privateKey: Uint8Array;
  try {
    const loaded = await loadActiveSigningKey(config, {
      promptLabel: "Passphrase (to read wallet): ",
    });
    privateKey = loaded.privateKey;
  } catch (err) {
    if (err instanceof IdentityKeyError) {
      console.error(`Wallet unavailable: ${err.message}`);
      console.error(`  → ${err.remedy}`);
    } else {
      console.error(`Wallet unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  const rpcUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
  let rail;
  try {
    rail = createSolanaWalletRail({
      rpcUrl,
      identitySeed: privateKey,
    });
  } finally {
    // Best-effort wipe. The rail holds its own copy of the key now;
    // we can erase our local bytes.
    secureErase(privateKey);
  }

  console.log();
  console.log(`  chain        solana`);
  console.log(`  asset        USDC`);
  console.log(`  address      ${rail.address}`);

  if (options.addressOnly) {
    console.log();
    return;
  }

  // Balance is async. Show "Loading..." while we wait, then overwrite.
  process.stdout.write(`  balance      Loading…`);
  try {
    const microUsdc = await rail.getBalance();
    const usdc = fromMicro(Number(microUsdc));
    process.stdout.write(`\r  balance      ${usdc.toFixed(2)} USDC         \n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\r  balance      (unavailable: ${msg})\n`);
  }

  console.log();
  console.log(`  This address IS your Ed25519 identity public key, base58-encoded.`);
  console.log(`  Fund with USDC on the SOLANA network (not Base/Ethereum — same asset,`);
  console.log(`  different chains). SOL received here is gas, auto-managed; convert extra`);
  console.log(`  SOL to working capital with \`motebit wallet swap <sol-amount>\`.`);
  console.log(`  Sovereign — no relay, no custody.`);
  console.log();
}

/**
 * `motebit wallet swap <sol-amount>` — owner-invoked SOL → USDC
 * normalization (wallet homeostasis, funding side). A deterministic
 * affordance: the owner's passphrase IS the authorization; the Jupiter
 * adapter's gas floor refuses fail-closed to metabolize the last fuel.
 * Born 2026-07-05: the founder funded the first live motebit with SOL
 * from an exchange, and the wallet had no way to normalize it.
 */
export async function handleWalletSwap(
  amountArg: string | undefined,
  options: WalletOptions = {},
): Promise<void> {
  if (amountArg == null || amountArg.trim() === "") {
    console.error("Usage: motebit wallet swap <sol-amount>   e.g. motebit wallet swap 0.01");
    process.exit(1);
  }
  // Decimal SOL → lamports without float drift: split on the point.
  const m = amountArg.trim().match(/^(\d+)(?:\.(\d{1,9}))?$/);
  if (m == null) {
    console.error(`Invalid SOL amount "${amountArg}" — up to 9 decimal places.`);
    process.exit(1);
  }
  const lamports = BigInt(m[1]!) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
  if (lamports <= 0n) {
    console.error("Amount must be positive.");
    process.exit(1);
  }

  const config = loadFullConfig();
  if (!config.motebit_id) {
    console.error(NO_IDENTITY_MESSAGE);
    process.exit(1);
  }

  let privateKey: Uint8Array;
  try {
    const loaded = await loadActiveSigningKey(config, {
      promptLabel: "Passphrase (to sign swap): ",
    });
    privateKey = loaded.privateKey;
  } catch (err) {
    if (err instanceof IdentityKeyError) {
      console.error(`Swap unavailable: ${err.message}`);
      console.error(`  → ${err.remedy}`);
    } else {
      console.error(`Swap unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  const rpcUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
  let rail;
  try {
    rail = createSolanaWalletRail({ rpcUrl, identitySeed: privateKey });
  } finally {
    secureErase(privateKey);
  }

  console.log(`Swapping ${amountArg} SOL → USDC via Jupiter (1% slippage bound)…`);
  try {
    const result = await rail.swapSolToUsdc(lamports);
    console.log(
      `  swapped   ${amountArg} SOL → ${fromMicro(Number(result.outputAmount)).toFixed(2)} USDC`,
    );
    console.log(`  tx        https://explorer.solana.com/tx/${result.signature}`);
    console.log();
    console.log(`Run \`motebit wallet\` to see the updated balance.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Swap refused or failed: ${msg}`);
    process.exit(1);
  }
}

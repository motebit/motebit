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
import { secureErase } from "@motebit/encryption";
import { loadFullConfig } from "../config.js";
import { fromHex, promptPassphrase, decryptPrivateKey } from "../identity.js";

interface WalletOptions {
  /** Solana RPC endpoint. Defaults to mainnet-beta public RPC. */
  rpcUrl?: string;
  /** Skip the balance query (address-only). Useful for scripts. */
  addressOnly?: boolean;
}

/**
 * Load the identity private key from CLI config. Returns the raw 32-byte
 * Ed25519 seed (the same one that signs identity assertions, receipts,
 * credentials, and — by curve coincidence — Solana transactions).
 *
 * Prompts for the passphrase when the key is encrypted. Returns null
 * when no key is found (fresh install, no identity bootstrapped yet).
 */
async function loadIdentityPrivateKey(): Promise<Uint8Array | null> {
  const config = loadFullConfig();

  // Legacy plaintext path (older configs). Migrated to encrypted on next
  // launch via the same flow as `motebit run`.
  if (config.cli_private_key != null && config.cli_private_key !== "") {
    return fromHex(config.cli_private_key);
  }

  // Encrypted path (current). Requires passphrase prompt.
  if (config.cli_encrypted_key) {
    const passphrase = await promptPassphrase("Passphrase (to read wallet): ");
    const privateKeyHex = await decryptPrivateKey(config.cli_encrypted_key, passphrase);
    return fromHex(privateKeyHex);
  }

  return null;
}

export async function handleWallet(options: WalletOptions = {}): Promise<void> {
  const config = loadFullConfig();

  if (!config.motebit_id) {
    console.error(
      "No identity found. Run `motebit run` or `npm create motebit` to create one first.",
    );
    process.exit(1);
  }

  const privateKey = await loadIdentityPrivateKey();
  if (privateKey == null) {
    console.error("No private key found in config. Wallet derivation requires an identity key.");
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
    const usdc = Number(microUsdc) / 1_000_000;
    process.stdout.write(`\r  balance      ${usdc.toFixed(2)} USDC         \n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\r  balance      (unavailable: ${msg})\n`);
  }

  console.log();
  console.log(`  This address IS your Ed25519 identity public key, base58-encoded.`);
  console.log(`  Send USDC directly to fund your motebit. Sovereign — no relay, no custody.`);
  console.log();
}

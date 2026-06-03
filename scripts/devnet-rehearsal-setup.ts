/**
 * Devnet rehearsal — provisioning step.
 *
 * Stands up everything the paid-P2P proof harness needs on Solana DEVNET so the
 * full loop (discover → eligibility → atomic multi-output tx → two-leg onchain
 * verification → signed receipt) can be rehearsed with ZERO real money before
 * the mainnet run:
 *
 *   1. Derive the delegator's Solana keypair from a 32-byte seed via the SAME
 *      `Keypair.fromSeed` derivation `@motebit/wallet-solana` uses, so the
 *      address funded here is exactly the address the harness spends from.
 *   2. Airdrop devnet SOL to the delegator (it pays its own gas + the rent for
 *      the recipient ATAs the atomic P2P tx auto-creates).
 *   3. Create a fresh 6-decimal SPL mint — a stand-in "USDC" we fully control,
 *      so there is no dependency on Circle's web faucet. The relay verifier and
 *      the harness both point `SOLANA_USDC_MINT` at THIS mint; the verifier only
 *      walks transfers of the configured mint, it never checks the mint is the
 *      canonical USDC.
 *   4. Mint test-USDC to the delegator's ATA.
 *
 * Idempotent: persists generated keys + the mint to `.devnet-rehearsal/state.json`
 * (gitignored) and reuses them on re-run, topping up SOL/USDC if low.
 *
 * Env (all optional):
 *   SOLANA_RPC_URL   devnet RPC (default https://api.devnet.solana.com)
 *   DELEGATOR_SEED_HEX  32-byte hex seed; generated + persisted if absent
 *   USDC_AMOUNT      test-USDC to ensure in the delegator wallet (default 10)
 *   AIRDROP_SOL      SOL to ensure in the delegator wallet (default 1)
 *
 * Run:  pnpm exec tsx scripts/devnet-rehearsal-setup.ts
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

const STATE_PATH = resolve(".devnet-rehearsal/state.json");
const DECIMALS = 6;
const log = (m: string) => console.log(`[devnet-setup] ${m}`);

interface State {
  delegatorSeedHex: string;
  delegatorAddress: string;
  mint?: string;
}

function loadState(): State | undefined {
  if (!existsSync(STATE_PATH)) return undefined;
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}
function saveState(s: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureSol(conn: Connection, kp: Keypair, targetSol: number): Promise<void> {
  const target = targetSol * LAMPORTS_PER_SOL;
  let bal = await conn.getBalance(kp.publicKey);
  if (bal >= target) {
    log(`SOL ok: ${(bal / LAMPORTS_PER_SOL).toFixed(4)}`);
    return;
  }
  for (let attempt = 1; attempt <= 5 && bal < target; attempt++) {
    try {
      log(`airdrop attempt ${attempt} (have ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL)…`);
      const sig = await conn.requestAirdrop(kp.publicKey, target - bal);
      const bh = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    } catch (err) {
      log(
        `  airdrop failed: ${err instanceof Error ? err.message : String(err)} (devnet faucet is rate-limited; retrying)`,
      );
      await sleep(2000 * attempt);
    }
    bal = await conn.getBalance(kp.publicKey);
  }
  if (bal < target) {
    throw new Error(
      `could not airdrop enough SOL (have ${(bal / LAMPORTS_PER_SOL).toFixed(4)}, need ${targetSol}). ` +
        `The public devnet faucet is heavily rate-limited — fund ${kp.publicKey.toBase58()} from https://faucet.solana.com and re-run.`,
    );
  }
  log(`SOL ok: ${(bal / LAMPORTS_PER_SOL).toFixed(4)}`);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const usdcAmount = Number(process.env.USDC_AMOUNT ?? "10");
  const airdropSol = Number(process.env.AIRDROP_SOL ?? "1");
  const conn = new Connection(rpcUrl, "confirmed");
  log(`rpc=${rpcUrl}`);

  const prior = loadState();
  const seedHex =
    process.env.DELEGATOR_SEED_HEX?.replace(/^0x/, "") ??
    prior?.delegatorSeedHex ??
    randomBytes(32).toString("hex");
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32)
    throw new Error(`DELEGATOR_SEED_HEX must be 32 bytes, got ${seed.length}`);
  const delegator = Keypair.fromSeed(new Uint8Array(seed));
  log(`delegator address: ${delegator.publicKey.toBase58()}`);

  const state: State = {
    delegatorSeedHex: seedHex,
    delegatorAddress: delegator.publicKey.toBase58(),
    ...(prior?.mint ? { mint: prior.mint } : {}),
  };
  saveState(state);

  // 1. SOL for gas + ATA rents + mint/ATA creation.
  await ensureSol(conn, delegator, airdropSol);

  // 2. Test mint (delegator is payer + mint authority).
  let mint: PublicKey;
  if (state.mint) {
    mint = new PublicKey(state.mint);
    log(`reusing mint ${mint.toBase58()}`);
  } else {
    mint = await createMint(conn, delegator, delegator.publicKey, null, DECIMALS);
    state.mint = mint.toBase58();
    saveState(state);
    log(`created ${DECIMALS}-decimal test mint ${mint.toBase58()}`);
  }

  // 3. Delegator ATA + ensure test-USDC balance.
  const ata = await getOrCreateAssociatedTokenAccount(conn, delegator, mint, delegator.publicKey);
  const have = (await getAccount(conn, ata.address)).amount;
  const target = BigInt(Math.round(usdcAmount * 10 ** DECIMALS));
  if (have < target) {
    await mintTo(conn, delegator, mint, ata.address, delegator, target - have);
    log(`minted ${usdcAmount} test-USDC → delegator ATA ${ata.address.toBase58()}`);
  } else {
    log(`test-USDC ok: ${(Number(have) / 10 ** DECIMALS).toFixed(6)}`);
  }

  // 4. Print the env block for the rest of the rehearsal.
  log("");
  log("════════ DEVNET REHEARSAL ENV ════════");
  console.log(`# relay + worker + harness all share these:`);
  console.log(`export SOLANA_RPC_URL='${rpcUrl}'`);
  console.log(`export SOLANA_USDC_MINT='${mint.toBase58()}'`);
  console.log(`# harness (the delegator) — funded wallet above:`);
  console.log(`export DELEGATOR_SEED_HEX='${seedHex}'`);
  console.log(`# delegator address (funded): ${delegator.publicKey.toBase58()}`);
  log("══════════════════════════════════════");
}

main().catch((err: unknown) => {
  console.error(`[devnet-setup] FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

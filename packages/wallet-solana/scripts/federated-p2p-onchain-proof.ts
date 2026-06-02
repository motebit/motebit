/**
 * Federated cross-operator P2P — REAL onchain proof (Solana devnet).
 *
 * This is a MANUAL proof script, not a CI test. It broadcasts a real,
 * confirmed, atomic 3-leg SPL transfer to Solana devnet and proves the
 * delegator-funded federated settlement money-path end to end:
 *
 *   $1.00 task  →  worker $0.9025  +  origin-relay (A) fee $0.05
 *                                  +  executor-relay (B) fee $0.0475
 *
 * per `relay-federation-v1` §7.1 (fee-from-budget). All three legs land
 * in ONE signed transaction — exactly the proof shape the two relays'
 * p2p-verifiers each walk for the legs that land in their OWN treasury.
 *
 * Funding is fully self-contained: we create a fresh 6-decimal SPL mint
 * on devnet (this script's delegator holds the mint authority), airdrop
 * devnet SOL for gas + ATA rent, and mint our own "test-USDC". No faucet,
 * no real money, no staging reconfiguration. The verifier-mint fix
 * (`SOLANA_USDC_MINT` → p2p-verifier) is what lets both the proof builder
 * AND the relay verifier operate against this non-mainnet mint.
 *
 * Run from the package directory so `@solana/*` + the source resolve:
 *
 *   cd packages/wallet-solana
 *   pnpm exec tsx scripts/federated-p2p-onchain-proof.ts
 *
 * On success it prints the confirmed tx signature, a devnet explorer
 * link, and an `export …` block to feed the gated relay verifier test
 * (`federated-p2p-onchain-devnet.test.ts`), which runs the ACTUAL
 * production verifier loop against this real transaction.
 *
 * Optional env:
 *   SOLANA_RPC_URL                   default https://api.devnet.solana.com
 *   MOTEBIT_DEVNET_DELEGATOR_SECRET  hex 32-byte seed to REUSE a funded
 *                                    delegator across runs (skips airdrop)
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { randomBytes } from "node:crypto";
import { Web3JsRpcAdapter, buildP2pPaymentProof, SOLANA_DEVNET_CAIP2 } from "../src/index.js";

// Spec §7.1 fee-from-budget split for a $1.00 task (micro-units; USDC and
// our 6-decimal test mint share the 6-decimal = micro convention).
const WORKER_MICRO = 902_500; // worker net  ($0.9025)
const ORIGIN_FEE_MICRO = 50_000; // origin relay A fee  ($0.05  = 5% of $1.00)
const EXECUTOR_FEE_MICRO = 47_500; // executor relay B fee ($0.0475 = 5% of remainder)
const TOTAL_MICRO = WORKER_MICRO + ORIGIN_FEE_MICRO + EXECUTOR_FEE_MICRO; // 1_000_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  console.log(`[proof] RPC: ${rpcUrl}`);

  // --- Keys ---
  // Delegator: deterministic from a 32-byte seed (reusable across runs so a
  // funded wallet survives devnet airdrop rate limits). The Web3JsRpcAdapter
  // derives the same keypair via Keypair.fromSeed(seed), so the adapter's
  // address == this delegator.
  const seed = process.env.MOTEBIT_DEVNET_DELEGATOR_SECRET
    ? Uint8Array.from(Buffer.from(process.env.MOTEBIT_DEVNET_DELEGATOR_SECRET, "hex"))
    : randomBytes(32);
  if (seed.length !== 32) throw new Error(`delegator seed must be 32 bytes, got ${seed.length}`);
  const delegator = Keypair.fromSeed(seed);
  // Receive-only counterparties (ephemeral). ATAs are auto-created by the
  // atomic batch (payer = delegator).
  const worker = Keypair.generate();
  const treasuryA = Keypair.generate(); // origin-relay treasury (A)
  const treasuryB = Keypair.generate(); // executor-relay treasury (B)

  console.log(`[proof] delegator:  ${delegator.publicKey.toBase58()}`);
  console.log(`[proof] worker:     ${worker.publicKey.toBase58()}`);
  console.log(`[proof] treasuryA:  ${treasuryA.publicKey.toBase58()}`);
  console.log(`[proof] treasuryB:  ${treasuryB.publicKey.toBase58()}`);

  // --- Fund delegator SOL (gas + ~5 ATA rents) ---
  let lamports = await connection.getBalance(delegator.publicKey);
  if (lamports < LAMPORTS_PER_SOL / 2) {
    console.log(`[proof] balance ${lamports} lamports — requesting 1 SOL airdrop…`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const sig = await connection.requestAirdrop(delegator.publicKey, LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
        break;
      } catch (err) {
        console.warn(`[proof] airdrop attempt ${attempt} failed: ${(err as Error).message}`);
        if (attempt === 5) {
          throw new Error(
            "devnet airdrop exhausted — reuse a funded wallet via MOTEBIT_DEVNET_DELEGATOR_SECRET, " +
              "or fund the delegator address above from https://faucet.solana.com",
          );
        }
        await sleep(2000 * attempt);
      }
    }
    lamports = await connection.getBalance(delegator.publicKey);
  }
  console.log(`[proof] delegator SOL balance: ${lamports / LAMPORTS_PER_SOL} SOL`);

  // --- Create a 6-decimal "test-USDC" mint (delegator = authority + payer) ---
  console.log(`[proof] creating 6-decimal test mint…`);
  const mint = await createMint(connection, delegator, delegator.publicKey, null, 6);
  console.log(`[proof] mint: ${mint.toBase58()}`);

  // --- Mint 10 test-USDC to the delegator ---
  const delegatorAta = await getOrCreateAssociatedTokenAccount(
    connection,
    delegator,
    mint,
    delegator.publicKey,
  );
  await mintTo(connection, delegator, mint, delegatorAta.address, delegator, 10_000_000n);
  console.log(`[proof] minted 10 test-USDC to delegator ATA ${delegatorAta.address.toBase58()}`);

  // --- Broadcast the REAL atomic 3-leg federated proof ---
  const delegatorAdapter = new Web3JsRpcAdapter({
    rpcUrl,
    identitySeed: seed,
    usdcMint: mint.toBase58(),
  });
  console.log(`[proof] broadcasting atomic 3-leg tx (total ${TOTAL_MICRO} micro = $1.00)…`);
  const proof = await buildP2pPaymentProof(delegatorAdapter, {
    workerAddress: worker.publicKey.toBase58(),
    treasuryAddress: treasuryA.publicKey.toBase58(),
    amountMicro: WORKER_MICRO,
    feeAmountMicro: ORIGIN_FEE_MICRO,
    executorTreasuryAddress: treasuryB.publicKey.toBase58(),
    executorFeeAmountMicro: EXECUTOR_FEE_MICRO,
    network: SOLANA_DEVNET_CAIP2,
  });
  console.log(`[proof] ✅ confirmed tx: ${proof.tx_hash}`);
  // Public explorer only resolves the tx on the public clusters. A local
  // test-validator (the faucet's recommended programmatic method — unlimited
  // SOL, no rate limits) is a real Solana runtime but its ledger is local, so
  // the tx is not externally viewable; say so rather than print a dead link.
  const cluster = /devnet/.test(rpcUrl)
    ? "devnet"
    : /mainnet|api\.mainnet/.test(rpcUrl)
      ? "mainnet-beta"
      : null;
  if (cluster) {
    console.log(
      `[proof] explorer: https://explorer.solana.com/tx/${proof.tx_hash}?cluster=${cluster}`,
    );
  } else {
    console.log(`[proof] (local validator ${rpcUrl} — tx is real but not on a public explorer)`);
  }

  // --- Read it back through a fresh READ-ONLY adapter (origin-relay view:
  //     zero seed, configured mint) — the exact path the verifier uses. ---
  const reader = new Web3JsRpcAdapter({
    rpcUrl,
    identitySeed: new Uint8Array(32),
    usdcMint: mint.toBase58(),
  });
  let result = await reader.getTransaction(proof.tx_hash);
  for (let i = 0; i < 20 && result.status !== "confirmed"; i++) {
    await sleep(3000);
    result = await reader.getTransaction(proof.tx_hash);
  }
  if (result.status !== "confirmed") {
    throw new Error(`tx did not become retrievable as 'confirmed' (status=${result.status})`);
  }

  // --- Assert all three legs parse with correct address + amount ---
  const leg = (to: string, micro: number) =>
    result.transfers.find((t) => t.to === to && t.amountMicro === BigInt(micro));
  const checks: Array<[string, ReturnType<typeof leg>]> = [
    [`worker  ${WORKER_MICRO}`, leg(worker.publicKey.toBase58(), WORKER_MICRO)],
    [`A-fee   ${ORIGIN_FEE_MICRO}`, leg(treasuryA.publicKey.toBase58(), ORIGIN_FEE_MICRO)],
    [`B-fee   ${EXECUTOR_FEE_MICRO}`, leg(treasuryB.publicKey.toBase58(), EXECUTOR_FEE_MICRO)],
  ];
  console.log(`[proof] onchain transfers parsed by Web3JsRpcAdapter.getTransaction:`);
  for (const t of result.transfers) {
    console.log(`         → ${t.to}  ${t.amountMicro.toString()}`);
  }
  const missing = checks.filter(([, found]) => found == null).map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(`MISSING legs in confirmed tx: ${missing.join(", ")}`);
  }
  console.log(`[proof] ✅ all 3 legs verified onchain (worker + origin-fee + executor-fee)`);

  // --- Hand-off to the gated relay verifier test (real production loop) ---
  console.log(`\n[proof] Feed the production relay verifier loop with:\n`);
  console.log(`export MOTEBIT_DEVNET_PROOF=1`);
  console.log(`export SOLANA_RPC_URL=${rpcUrl}`);
  console.log(`export MOTEBIT_PROOF_TX=${proof.tx_hash}`);
  console.log(`export MOTEBIT_PROOF_MINT=${mint.toBase58()}`);
  console.log(`export MOTEBIT_PROOF_WORKER=${worker.publicKey.toBase58()}`);
  console.log(`export MOTEBIT_PROOF_TREASURY_A=${treasuryA.publicKey.toBase58()}`);
  console.log(`export MOTEBIT_PROOF_TREASURY_B=${treasuryB.publicKey.toBase58()}`);
  console.log(
    `\n[proof] then: pnpm --filter @motebit/relay test -- federated-p2p-onchain-devnet\n`,
  );
}

main().catch((err) => {
  console.error(`[proof] FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

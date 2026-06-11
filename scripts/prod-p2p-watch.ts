/**
 * Watch a single-operator P2P delegation settle onchain, in real time.
 *
 * Resolves the three parties live (no hardcoding that can drift):
 *   - delegator : your sovereign wallet (env DELEGATOR, default below)
 *   - worker    : the P2P-capable worker for CAPABILITY, from /discover
 *   - treasury  : deriveSolanaAddress(relay public_key from /.well-known) —
 *                 the same derivation the relay + verifier use, so the fee
 *                 leg can't be mis-attributed
 *
 * Snapshots all three USDC balances, then polls until the delegator balance
 * drops (the payment broadcast) and prints the per-leg deltas. A correct
 * single-op P2P settlement is fee-on-top:
 *     delegator −$0.052632 · worker +$0.050000 · treasury +$0.002632 (5%)
 *
 * RPC: defaults to the public mainnet endpoint (works from node/CLI, unlike
 * the browser). Override with a Helius/Triton URL via RPC_URL if rate-limited.
 *
 * Run (before you approve the delegation in the browser):
 *   pnpm exec tsx scripts/prod-p2p-watch.ts
 */
import { Buffer } from "node:buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { deriveSolanaAddress } from "@motebit/wallet-solana";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const RELAY = (process.env.RELAY_URL ?? "https://relay.motebit.com").replace(/\/$/, "");
const DELEGATOR = process.env.DELEGATOR ?? "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5ULLfh";
const CAPABILITY = process.env.CAPABILITY ?? "web_search";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function usdcBalance(owner: string): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(USDC, new PublicKey(owner));
    const acct = await getAccount(conn, ata);
    return Number(acct.amount) / 1_000_000;
  } catch {
    return 0; // no token account yet → zero
  }
}

type Snap = { delegator: number; worker: number; treasury: number };

async function snapshot(parties: {
  delegator: string;
  worker: string;
  treasury: string;
}): Promise<Snap> {
  const [delegator, worker, treasury] = await Promise.all([
    usdcBalance(parties.delegator),
    usdcBalance(parties.worker),
    usdcBalance(parties.treasury),
  ]);
  return { delegator, worker, treasury };
}

function row(label: string, s: Snap): void {
  console.log(
    `  ${label.padEnd(9)} delegator ${s.delegator.toFixed(6)}  worker ${s.worker.toFixed(6)}  treasury ${s.treasury.toFixed(6)}`,
  );
}

async function main(): Promise<void> {
  console.log(`[watch] rpc=${RPC.split("?")[0]}  relay=${RELAY}  capability=${CAPABILITY}`);

  // Treasury = derived from the relay's pinned identity key (same as the verifier).
  const wk = (await (await fetch(`${RELAY}/.well-known/motebit.json`)).json()) as {
    public_key?: string;
  };
  if (!wk.public_key) throw new Error("relay /.well-known has no public_key");
  const treasury = deriveSolanaAddress(new Uint8Array(Buffer.from(wk.public_key, "hex")));

  // Worker = the P2P-capable provider for this capability.
  const disc = (await (
    await fetch(`${RELAY}/api/v1/agents/discover?capability=${encodeURIComponent(CAPABILITY)}`)
  ).json()) as {
    agents?: Array<{ settlement_address?: string | null; settlement_modes?: string | null }>;
  };
  const worker = (disc.agents ?? []).find(
    (a) => a.settlement_address != null && String(a.settlement_modes ?? "").includes("p2p"),
  );
  if (!worker?.settlement_address) {
    console.error(`[watch] ✗ no P2P worker advertises "${CAPABILITY}" on ${RELAY}`);
    process.exit(1);
  }

  const parties = { delegator: DELEGATOR, worker: worker.settlement_address, treasury };
  console.log(`[watch] delegator ${parties.delegator}`);
  console.log(`[watch] worker    ${parties.worker}`);
  console.log(`[watch] treasury  ${parties.treasury}`);
  console.log("");

  const base = await snapshot(parties);
  row("baseline", base);
  console.log("[watch] approve the ~$0.0526 payment in the browser — polling for the settlement…");

  for (let i = 0; i < 60; i++) {
    await sleep(4000);
    const now = await snapshot(parties);
    if (now.delegator < base.delegator - 1e-9 || now.worker > base.worker + 1e-9) {
      console.log("");
      row("after", now);
      const d = {
        delegator: now.delegator - base.delegator,
        worker: now.worker - base.worker,
        treasury: now.treasury - base.treasury,
      };
      console.log("");
      console.log("  ── SETTLED ─────────────────────────────────────");
      console.log(`  delegator  ${d.delegator >= 0 ? "+" : ""}${d.delegator.toFixed(6)} USDC`);
      console.log(`  worker     ${d.worker >= 0 ? "+" : ""}${d.worker.toFixed(6)} USDC  (net)`);
      console.log(
        `  treasury   ${d.treasury >= 0 ? "+" : ""}${d.treasury.toFixed(6)} USDC  (5% fee)`,
      );
      const conserved = Math.abs(d.delegator + d.worker + d.treasury) < 1e-6;
      console.log(
        `  conservation: ${conserved ? "✓ balances" : "⚠ check — legs don't sum to zero"}`,
      );
      console.log("  ────────────────────────────────────────────────");
      return;
    }
    process.stdout.write(".");
  }
  console.log("\n[watch] no balance change within ~4min. Either the payment wasn't approved,");
  console.log("[watch] it fell back to relay-mode (check the receipt), or the RPC is lagging.");
}

main().catch((err: unknown) => {
  console.error(`[watch] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

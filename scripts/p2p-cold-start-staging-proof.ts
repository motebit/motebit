/**
 * Single-operator cold-start P2P — staging proof harness.
 *
 * Drives the REAL delegator client (`resolveAndSubmitP2pDelegation` from
 * `@motebit/runtime`) against a STAGING relay to prove the paid P2P loop end to
 * end BEFORE risking prod:
 *
 *   discover a P2P-capable worker → confirm /p2p-eligibility (cold-start, with
 *   the ack) → price from the listing → broadcast ONE atomic Solana tx (worker
 *   net + relay fee) → submit the proof → poll the signed receipt.
 *
 * SAFETY — dry-run by DEFAULT. The harness prints the full plan (worker,
 * eligibility verdict, the exact $ legs, your USDC balance) and STOPS before the
 * irreversible broadcast. Only `DRY_RUN=0` moves funds. Use a worker with the
 * smallest positive unit_cost and fund the delegator with exactly one task's
 * worth (+ a little SOL for gas) so worst-case exposure is a single task.
 *
 * This is the "smallest-amount test on staging" the prod-delegation playbook
 * names. Run it green on staging, then the prod run is the identical invocation
 * pointed at relay.motebit.com once a real prod worker is P2P-enabled.
 *
 * Required env:
 *   STAGING_RELAY_URL     e.g. https://motebit-sync-stg.fly.dev
 *   STAGING_AUTH_TOKEN    a signed task:submit / market:listing token for the
 *                         delegator, OR the relay master token
 *   DELEGATOR_MOTEBIT_ID  the delegator's motebit id (the task's submitted_by)
 *   DELEGATOR_SEED_HEX    32-byte hex seed for the delegator's Solana wallet
 *                         (funded with USDC + a little SOL on the staging chain)
 *   SOLANA_RPC_URL        the chain RPC the staging relay's verifier uses
 *   CAPABILITY            capability to delegate, e.g. web_search
 * Optional:
 *   DRY_RUN               "0" to actually broadcast; anything else / unset = dry run
 *   PROMPT                task prompt (default a fixed string)
 *   TIMEOUT_MS            poll budget for the real run (default 60000)
 *
 * Run:  pnpm exec tsx scripts/p2p-cold-start-staging-proof.ts
 */
import { Buffer } from "node:buffer";
import { resolveAndSubmitP2pDelegation } from "@motebit/runtime";
import { createSolanaWalletRail } from "@motebit/wallet-solana";
import { toMicro, fromMicro, computeP2pFeeMicro, PLATFORM_FEE_RATE } from "@motebit/protocol";

const REQUIRED = [
  "STAGING_RELAY_URL",
  "STAGING_AUTH_TOKEN",
  "DELEGATOR_MOTEBIT_ID",
  "DELEGATOR_SEED_HEX",
  "SOLANA_RPC_URL",
  "CAPABILITY",
] as const;

function usage(missing: string): never {
  console.error(`\n[staging-proof] missing required env: ${missing}\n`);
  console.error("Required:");
  for (const k of REQUIRED) console.error(`  ${k}`);
  console.error("\nOptional: DRY_RUN (=0 to broadcast), PROMPT, TIMEOUT_MS\n");
  console.error("Safety: dry-run by default — prints the plan and stops before any broadcast.\n");
  process.exit(2);
}

const log = (msg: string) => console.log(`[staging-proof] ${msg}`);

async function main(): Promise<void> {
  for (const k of REQUIRED) if (!process.env[k]) usage(k);
  const relayUrl = process.env.STAGING_RELAY_URL!.replace(/\/$/, "");
  const token = process.env.STAGING_AUTH_TOKEN!;
  const motebitId = process.env.DELEGATOR_MOTEBIT_ID!;
  const seedHex = process.env.DELEGATOR_SEED_HEX!.replace(/^0x/, "");
  const rpcUrl = process.env.SOLANA_RPC_URL!;
  const capability = process.env.CAPABILITY!;
  const dryRun = process.env.DRY_RUN !== "0";
  const prompt = process.env.PROMPT ?? `staging cold-start P2P proof for "${capability}"`;
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? "60000");

  log(`relay=${relayUrl}  capability=${capability}  DRY_RUN=${dryRun}`);
  const authToken = async (): Promise<string> => token;
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Treasury trust root: pin the relay's key from /.well-known (TOFU, as the
  // surfaces' getOrPinRelayKey does) — the fee leg pays an address derived from
  // THIS, never a fetched-then-trusted value.
  const wk = (await (await fetch(`${relayUrl}/.well-known/motebit.json`)).json()) as {
    public_key?: string;
  };
  if (!wk.public_key) throw new Error("relay /.well-known/motebit.json has no public_key");
  const relayPublicKeyHex = wk.public_key;
  log(`pinned relay key ${relayPublicKeyHex.slice(0, 12)}…`);

  // ── PLAN (read-only; no funds move) ──────────────────────────────────────
  // 1. discover a payable P2P worker
  const disc = (await (
    await fetch(`${relayUrl}/api/v1/agents/discover?capability=${encodeURIComponent(capability)}`)
  ).json()) as {
    agents?: Array<{
      motebit_id: string;
      settlement_address?: string | null;
      settlement_modes?: string | null;
    }>;
  };
  const worker = (disc.agents ?? []).find(
    (a) =>
      a.motebit_id !== motebitId &&
      a.settlement_address != null &&
      String(a.settlement_modes ?? "").includes("p2p"),
  );
  if (!worker) {
    log(`✗ no P2P-capable worker advertises "${capability}" on ${relayUrl}.`);
    log(`  Enable one: fly secrets set MOTEBIT_SETTLEMENT_MODES=relay,p2p on a staging worker.`);
    process.exit(1);
  }
  log(
    `worker ${worker.motebit_id}  pays→ ${worker.settlement_address}  modes=${worker.settlement_modes}`,
  );

  // 2. pre-flight eligibility (cold-start, WITH the ack — mirrors the client)
  const elig = (await (
    await fetch(
      `${relayUrl}/api/v1/agents/${worker.motebit_id}/p2p-eligibility?acknowledge_no_history_risk=true`,
      { headers: authHeaders },
    )
  ).json()) as { allowed?: boolean; reason?: string };
  log(`eligibility: allowed=${elig.allowed} (${elig.reason ?? "—"})`);
  if (elig.allowed !== true) {
    log(`✗ relay says ineligible even WITH the ack — the real client would refuse to broadcast.`);
    process.exit(1);
  }

  // 3. price + compute the exact legs (same primitives the client + relay use)
  const listing = (await (
    await fetch(`${relayUrl}/api/v1/agents/${worker.motebit_id}/listing`, { headers: authHeaders })
  ).json()) as { pricing?: Array<{ capability?: string; unit_cost?: number }> };
  const priced =
    (listing.pricing ?? []).find((p) => p.capability === capability) ?? (listing.pricing ?? [])[0];
  if (priced?.unit_cost == null || priced.unit_cost <= 0) {
    log(`✗ worker has no positive price for "${capability}".`);
    process.exit(1);
  }
  const amountMicro = toMicro(priced.unit_cost);
  const feeMicro = computeP2pFeeMicro(amountMicro, PLATFORM_FEE_RATE);
  const grossMicro = amountMicro + feeMicro;

  // 4. balance check
  const rail = createSolanaWalletRail({ rpcUrl, identitySeed: Buffer.from(seedHex, "hex") });
  const balanceMicro = await rail.getBalance();

  log("");
  log("── PLAN ─────────────────────────────────────────────");
  log(`  worker net   : ${amountMicro} micro  ($${fromMicro(amountMicro).toFixed(6)})`);
  log(
    `  relay fee    : ${feeMicro} micro  ($${fromMicro(feeMicro).toFixed(6)})  @ ${PLATFORM_FEE_RATE * 100}%`,
  );
  log(`  you pay      : ${grossMicro} micro  ($${fromMicro(grossMicro).toFixed(6)})  + Solana gas`);
  log(
    `  your balance : ${balanceMicro} micro  ($${fromMicro(Number(balanceMicro)).toFixed(6)} USDC)`,
  );
  log("─────────────────────────────────────────────────────");
  if (balanceMicro < BigInt(grossMicro)) {
    log(
      `✗ insufficient USDC: need ${grossMicro} micro, have ${balanceMicro}. Fund the delegator wallet.`,
    );
    process.exit(1);
  }

  if (dryRun) {
    log("");
    log("✓ DRY RUN — plan is valid, eligibility confirmed, funds sufficient. NO broadcast.");
    log("  Re-run with DRY_RUN=0 to execute the real onchain delegation.");
    return;
  }

  // ── REAL run — the actual client, the irreversible broadcast, the receipt ──
  log("");
  log("DRY_RUN=0 → executing the REAL delegation via resolveAndSubmitP2pDelegation …");
  const result = await resolveAndSubmitP2pDelegation({
    motebitId,
    syncUrl: relayUrl,
    authToken,
    prompt,
    capability,
    relayPublicKeyHex,
    buildP2pPayment: (req) => rail.buildP2pPayment!(req),
    acknowledgeNoHistoryRisk: true,
    timeoutMs,
    logger: { warn: (m, ctx) => console.warn(`[staging-proof] warn: ${m}`, ctx ?? "") },
  });

  if (result.ok) {
    log(`✓ SETTLED. task=${result.taskId}  receipt.status=${result.receipt.status}`);
    log(`  result: ${(result.receipt.result ?? "").slice(0, 200)}`);
    log(
      `  The paid P2P loop ran end to end on staging. Prod is the same call → relay.motebit.com.`,
    );
  } else {
    log(`✗ ${result.error.code}: ${result.error.message}`);
    if (result.error.code === "timeout") {
      log(
        `  (submission was ACCEPTED — no receipt within ${timeoutMs}ms; the worker may be slow.)`,
      );
    } else {
      log(`  Funds moved only if the code is post-broadcast; pre-broadcast codes (p2p_ineligible,`);
      log(`  no_routing, worker_not_payable) mean nothing was paid.`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`[staging-proof] FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

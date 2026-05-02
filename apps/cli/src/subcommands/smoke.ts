/**
 * `motebit smoke ...` — operator-runnable end-to-end probes.
 *
 * The smoke family validates load-bearing infrastructure end-to-end on
 * a live relay, complementing the static drift gates (`pnpm check`)
 * and the read-only `motebit doctor` probes. Where `doctor` answers
 * "is this configured correctly?", smoke answers "did the full loop
 * actually run?".
 *
 * Today: one subcommand, `motebit smoke reconciliation`. Two future
 * siblings are anchored in doctrine but not yet implemented:
 *
 *   - `motebit smoke x402` — paid task settlement on Base mainnet (the
 *     buyer-and-worker companion that gives `smoke reconciliation`
 *     something to observe).
 *   - `motebit smoke deposit` — agent-wallet deposit observation
 *     (would mirror reconciliation against the per-agent path).
 *
 * Sibling-but-distinct primitives — canonical doctrine in
 * `packages/treasury-reconciliation/CLAUDE.md` Rule 1.
 */

import type { CliConfig } from "../args.js";
import { fetchRelayJson, getRelayUrl } from "./_helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stale threshold = 2× the loop's default 15-min cadence, generous enough
 * to absorb a single missed tick without flagging a healthy loop. The same
 * value drives the `motebit doctor` probe — both surfaces share this
 * contract so an operator's mental model is "if the loop missed >2 ticks,
 * something is wrong." Changing this number means updating both places +
 * the doctrine in `docs/doctrine/treasury-custody.md` § Phase 1 step 7.
 */
export const SMOKE_STALE_THRESHOLD_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Public entry point — branched dispatch
// ---------------------------------------------------------------------------

export async function handleSmokeReconciliation(config: CliConfig): Promise<void> {
  const relayUrl = getRelayUrl(config);

  // The admin endpoint is gated by master token. The probe accepts the
  // token from --sync-token / MOTEBIT_API_TOKEN / MOTEBIT_SYNC_TOKEN, in
  // that order — same precedence chain as `getRelayAuthHeaders` in
  // `_helpers.ts`. Signed device tokens (the "no master token" fallback
  // there) deliberately don't apply: this is an operator-side probe
  // against the operator's own relay, not an agent-side action.
  const masterToken =
    config.syncToken ?? process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"];
  if (masterToken == null || masterToken === "") {
    console.error(
      "Error: motebit smoke reconciliation requires a master token.\n" +
        "  Set MOTEBIT_API_TOKEN (or MOTEBIT_SYNC_TOKEN, or pass --sync-token <token>)\n" +
        "  with the relay's admin token. This subcommand probes the relay's\n" +
        "  master-token-gated /api/v1/admin/treasury-reconciliation surface\n" +
        "  and exits non-zero on failure (suitable for CI / cron).",
    );
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${masterToken}` };
  const result = await fetchRelayJson(`${relayUrl}/api/v1/admin/treasury-reconciliation`, headers);
  if (!result.ok) {
    console.error(`Error: relay probe failed: ${result.error}`);
    process.exit(1);
  }

  // Type-narrow via runtime check rather than `as` cast — the admin
  // endpoint is part of motebit's own contract, but this subcommand
  // also runs against third-party operators' relays which may lag
  // versions. A shape mismatch is a real failure mode worth surfacing
  // honestly rather than swallowing into a TS cast.
  const body = result.data;
  if (typeof body !== "object" || body == null) {
    console.error("Error: relay returned non-object body");
    process.exit(1);
  }
  const obj = body as Record<string, unknown>;
  const stats = obj["stats"];
  const loopEnabled = obj["loop_enabled"];
  const chain = typeof obj["chain"] === "string" ? obj["chain"] : "";
  const treasuryAddress =
    typeof obj["treasury_address"] === "string" ? obj["treasury_address"] : "";
  if (typeof stats !== "object" || stats == null || typeof loopEnabled !== "boolean") {
    console.error(
      "Error: response shape unrecognized — relay may be older than the reconciliation primitive (need v23 migration + admin route).",
    );
    process.exit(1);
  }
  const s = stats as Record<string, unknown>;
  const lastRunAt = typeof s["last_run_at"] === "number" ? s["last_run_at"] : null;
  const totalRuns = typeof s["total_runs"] === "number" ? s["total_runs"] : 0;
  const currentConsistent =
    typeof s["current_consistent"] === "boolean" ? s["current_consistent"] : null;
  const currentDriftMicro =
    typeof s["current_drift_micro"] === "string" ? s["current_drift_micro"] : null;
  const inconsistentRuns24h =
    typeof s["inconsistent_runs_24h"] === "number" ? s["inconsistent_runs_24h"] : 0;

  // ── Branched assertions ────────────────────────────────────────────
  //
  // Tests in __tests__/subcommands/smoke.test.ts pin every branch.
  // Adding a new branch means adding a test case; the order here
  // matches the test file's case order to keep them in lockstep.

  // 1. Loop disabled. Honest outcome on a testnet relay or on a
  //    mainnet relay that was deployed without X402_PAY_TO_ADDRESS.
  //    Operators running this in CI against a testnet relay should
  //    treat this as success — the loop is correctly skipped.
  if (!loopEnabled) {
    printReceipt({
      verdict: "loop_disabled",
      relay: relayUrl,
      chain,
      treasury: treasuryAddress,
      detail:
        "loop disabled — testnet mode (X402_TESTNET=true) or X402_PAY_TO_ADDRESS unset on the target relay",
    });
    return;
  }

  // 2. Loop enabled, no cycles yet. Recent boot — operator should
  //    rerun after the configured interval (default 15min) elapses.
  //    Not a failure, but the smoke can't yet make a positive
  //    statement about the loop's behavior.
  if (lastRunAt == null) {
    printReceipt({
      verdict: "no_cycles_yet",
      relay: relayUrl,
      chain,
      treasury: treasuryAddress,
      detail:
        "loop enabled but no reconciliation cycles have run yet — relay was recently deployed; rerun after the configured interval (default 15 min)",
    });
    return;
  }

  const ageMs = Date.now() - lastRunAt;
  const ageMin = Math.round(ageMs / 60_000);

  // 3. Stale cycle. Loop is enabled and HAS run before, but the most
  //    recent run is older than the threshold. Loop has likely stopped
  //    firing — silent failure mode that the loop itself can't surface
  //    (a dead loop emits no logs).
  if (ageMs > SMOKE_STALE_THRESHOLD_MS) {
    printReceipt({
      verdict: "stale",
      relay: relayUrl,
      chain,
      treasury: treasuryAddress,
      detail: `loop stale — last run ${ageMin}m ago (expected within 30m); check relay logs for treasury-reconciliation.cycle_uncaught`,
    });
    process.exit(1);
  }

  // 4. Negative drift detected. Worker payouts owe more onchain than
  //    the treasury holds — silent fee leakage OR a manual sweep
  //    (known false positive, documented in
  //    docs/doctrine/treasury-custody.md § Phase 1 step 6).
  if (currentConsistent === false) {
    printReceipt({
      verdict: "drift",
      relay: relayUrl,
      chain,
      treasury: treasuryAddress,
      detail: `negative drift on last cycle — current_drift_micro=${currentDriftMicro ?? "?"}, ${inconsistentRuns24h} inconsistent run(s) in last 24h. Manual sweeps cause known false positives; investigate via GET /api/v1/admin/treasury-reconciliation`,
    });
    process.exit(1);
  }

  // 5. Healthy. Last cycle observed consistent state.
  printReceipt({
    verdict: "healthy",
    relay: relayUrl,
    chain,
    treasury: treasuryAddress,
    detail: `loop healthy — last run ${ageMin}m ago, ${totalRuns} run(s) total, current_drift_micro=${currentDriftMicro ?? "0"}`,
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface SmokeReceipt {
  /** Verdict tag — one of the five branched outcomes. */
  verdict: "healthy" | "stale" | "drift" | "no_cycles_yet" | "loop_disabled";
  relay: string;
  chain: string;
  treasury: string;
  detail: string;
}

/**
 * Canonical operator-facing output. Stable lines so CI / cron jobs
 * can grep for `verdict=` if they want a single line of state.
 */
function printReceipt(r: SmokeReceipt): void {
  console.log(`motebit smoke reconciliation`);
  console.log(`  verdict=${r.verdict}`);
  console.log(`  relay=${r.relay}`);
  console.log(`  chain=${r.chain || "(none)"}`);
  console.log(`  treasury=${r.treasury || "(none)"}`);
  console.log(`  ${r.detail}`);
}

/**
 * `motebit doctor` — environment self-check for CLI installations.
 *
 * Validates Node version, config directory writability, SQLite driver,
 * optional embeddings availability, and whether an identity has been
 * created. Prints a per-check status line and exits non-zero if any
 * required check fails.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { openMotebitDatabase } from "@motebit/persistence";
import { CONFIG_DIR, loadFullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * Optional one-line remedy to print on failure. Each P0 first-run gap
   * (no sync_url, identity not registered, key unloadable, key/public
   * mismatch) carries a concrete next-action so the user doesn't have
   * to read source to know what to do.
   */
  remedy?: string;
}

export async function handleDoctor(): Promise<void> {
  const checks: DoctorCheck[] = [];

  // Node version
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split(".")[0]!, 10);
  checks.push({
    name: "Node.js",
    ok: major >= 20,
    detail: major >= 20 ? `v${nodeVer}` : `v${nodeVer} (requires >=20)`,
  });

  // Config directory writable
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const testFile = path.join(CONFIG_DIR, ".doctor-test");
    fs.writeFileSync(testFile, "ok", "utf-8");
    fs.unlinkSync(testFile);
    checks.push({ name: "Config dir", ok: true, detail: CONFIG_DIR });
  } catch {
    checks.push({ name: "Config dir", ok: false, detail: `Cannot write to ${CONFIG_DIR}` });
  }

  // SQLite driver (sql.js)
  try {
    const tmpDbPath = path.join(CONFIG_DIR, ".doctor-test.db");
    const db = await openMotebitDatabase(tmpDbPath);
    const driverName = db.db.driverName;
    db.close();
    fs.unlinkSync(tmpDbPath);
    try {
      fs.unlinkSync(tmpDbPath + "-wal");
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmpDbPath + "-shm");
    } catch {
      /* ignore */
    }
    checks.push({ name: "SQLite", ok: true, detail: `${driverName} loaded and functional` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "SQLite", ok: false, detail: msg });
  }

  // @xenova/transformers (optional)
  try {
    await import("@xenova/transformers");
    checks.push({
      name: "Embeddings",
      ok: true,
      detail: "@xenova/transformers available (local embeddings)",
    });
  } catch {
    checks.push({
      name: "Embeddings",
      ok: true,
      detail: "not installed (optional — hash-based fallback active)",
    });
  }

  // Existing identity
  const fullCfg = loadFullConfig();
  if (fullCfg.motebit_id != null && fullCfg.motebit_id !== "") {
    checks.push({ name: "Identity", ok: true, detail: `${fullCfg.motebit_id.slice(0, 8)}...` });
  } else {
    checks.push({ name: "Identity", ok: true, detail: "not created yet (run motebit to create)" });
  }

  // ── First-run economic-path probes ──────────────────────────────────
  //
  // These six probes catch the gaps that block fund/delegate/settle for
  // a fresh user. Pre-1.0 doctor only checked structural readiness (Node,
  // sqlite, identity-id-present); a user with all green could still hit
  // "no relay URL" the moment they ran `motebit balance`. Each probe
  // surfaces an actionable remedy when it fails so the user doesn't
  // have to read source to know what to do next.
  //
  // Order matches dependency: identity → key loadable → public match →
  // sync_url → relay reachable → identity registered → balance reachable.
  // Earlier failures don't block later checks; doctor reports every gap
  // in one pass so the user sees the full picture.

  // Identity-key loadable. Probe the resolver structurally — no
  // passphrase prompt — so doctor stays unattended-friendly.
  const haveIdentity = fullCfg.motebit_id != null && fullCfg.motebit_id !== "";
  if (haveIdentity) {
    if (fullCfg.cli_encrypted_key) {
      checks.push({
        name: "Identity key",
        ok: true,
        detail: "cli_encrypted_key present (passphrase-protected)",
      });
    } else if (fullCfg.cli_private_key != null && fullCfg.cli_private_key !== "") {
      checks.push({
        name: "Identity key",
        ok: true,
        detail: "cli_private_key (plaintext, deprecated — re-encrypt at next run)",
      });
    } else {
      const clobberedBackups = fs
        .readdirSync(CONFIG_DIR)
        .filter((f) => f.startsWith("config.json.clobbered-"));
      const restoreHint =
        clobberedBackups.length > 0
          ? `restore from ~/.motebit/${clobberedBackups[0]} (a clobbered backup is present)`
          : "run `motebit init` to create or import an identity key";
      checks.push({
        name: "Identity key",
        ok: false,
        detail: "no cli_encrypted_key in config",
        remedy: restoreHint,
      });
    }

    // Derived-public check. Pre-checks the structural shape; the
    // private bytes themselves are only readable after passphrase
    // decrypt, so we can't actually re-derive without a prompt — but
    // we can at least confirm device_public_key is well-formed and
    // present for loadActiveSigningKey to verify against.
    if (fullCfg.device_public_key == null || fullCfg.device_public_key === "") {
      checks.push({
        name: "Public key",
        ok: false,
        detail: "device_public_key missing from config",
        remedy: "config is partial — run `motebit init` to re-bootstrap identity",
      });
    } else if (!/^[0-9a-f]{64}$/i.test(fullCfg.device_public_key)) {
      checks.push({
        name: "Public key",
        ok: false,
        detail: "device_public_key is not 32-byte hex",
        remedy: "config is corrupted — restore from backup or re-run `motebit init`",
      });
    } else {
      checks.push({
        name: "Public key",
        ok: true,
        detail: `${fullCfg.device_public_key.slice(0, 12)}...`,
      });
    }
  }

  // sync_url configured.
  const syncUrl = fullCfg.sync_url ?? process.env["MOTEBIT_SYNC_URL"];
  if (syncUrl == null || syncUrl === "") {
    checks.push({
      name: "Sync URL",
      ok: false,
      detail: "not set in config or env",
      remedy:
        "run `motebit register` to register with the default relay (https://relay.motebit.com) and persist the URL",
    });
  } else {
    checks.push({ name: "Sync URL", ok: true, detail: syncUrl });
  }

  // Relay reachable + identity registered + balance reachable. These
  // three only run if sync_url is set (otherwise nothing to probe).
  // Each is best-effort with a 5-second timeout so the doctor doesn't
  // hang on a misconfigured URL or a flaky network.
  if (syncUrl != null && syncUrl !== "") {
    const probeTimeout = (signal: AbortSignal, ms: number): NodeJS.Timeout =>
      setTimeout(() => (signal as unknown as { abort(): void }).abort?.(), ms);

    // Relay reachable
    let relayReachable = false;
    try {
      const ac = new AbortController();
      const t = probeTimeout(ac.signal, 5000);
      const res = await fetch(`${syncUrl.replace(/\/+$/, "")}/health/ready`, {
        signal: ac.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        relayReachable = true;
        checks.push({
          name: "Relay reachable",
          ok: true,
          detail: `${syncUrl} (${res.status})`,
        });
      } else {
        checks.push({
          name: "Relay reachable",
          ok: false,
          detail: `${syncUrl} returned HTTP ${res.status}`,
          remedy: "check sync_url value and that the relay is up",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "Relay reachable",
        ok: false,
        detail: `cannot reach ${syncUrl}: ${msg}`,
        remedy: "check network and sync_url value",
      });
    }

    // Identity registered (only meaningful if both relay and identity exist)
    if (relayReachable && haveIdentity) {
      try {
        const ac = new AbortController();
        const t = probeTimeout(ac.signal, 5000);
        const res = await fetch(
          `${syncUrl.replace(/\/+$/, "")}/agent/${encodeURIComponent(fullCfg.motebit_id!)}/capabilities`,
          { signal: ac.signal },
        );
        clearTimeout(t);
        if (res.status === 200) {
          checks.push({
            name: "Identity registered",
            ok: true,
            detail: `motebit_id ${fullCfg.motebit_id!.slice(0, 8)}... resolved on relay`,
          });
        } else if (res.status === 404) {
          checks.push({
            name: "Identity registered",
            ok: false,
            detail: "motebit_id not found on relay",
            remedy: "run `motebit register` to publish your identity to the relay",
          });
        } else {
          checks.push({
            name: "Identity registered",
            ok: false,
            detail: `relay returned HTTP ${res.status}`,
            remedy: "see relay logs for context",
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          name: "Identity registered",
          ok: false,
          detail: `probe failed: ${msg}`,
        });
      }
    }

    // Treasury reconciliation loop liveness (operator-side; gracefully
    // degrades for non-operators). Catches "loop quietly stopped firing" —
    // the silent failure mode the loop itself can't surface, since a dead
    // loop emits no logs. Read-only, no money cost.
    //
    // Probe runs whenever the relay is reachable; auth posture branches:
    //  - master token present → real probe with healthy/stale/disabled detail
    //  - no master token → "skipped — operator-only check" (informational)
    //  - 404 → older relay without the endpoint
    //
    // Sibling-but-distinct primitive vs the deposit-detector — canonical
    // doctrine in `packages/treasury-reconciliation/CLAUDE.md` Rule 1.
    if (relayReachable) {
      const masterToken = process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"];
      const reqHeaders: Record<string, string> = {};
      if (masterToken != null && masterToken !== "") {
        reqHeaders["Authorization"] = `Bearer ${masterToken}`;
      }
      try {
        const ac = new AbortController();
        const t = probeTimeout(ac.signal, 5000);
        const res = await fetch(
          `${syncUrl.replace(/\/+$/, "")}/api/v1/admin/treasury-reconciliation`,
          { signal: ac.signal, headers: reqHeaders },
        );
        clearTimeout(t);
        if (res.status === 401) {
          checks.push({
            name: "Treasury reconciliation",
            ok: true,
            detail: "skipped — operator-only check (set MOTEBIT_API_TOKEN to enable)",
          });
        } else if (res.status === 404) {
          checks.push({
            name: "Treasury reconciliation",
            ok: true,
            detail: "endpoint not exposed (older relay)",
          });
        } else if (res.ok) {
          const body = (await res.json()) as {
            stats: {
              total_runs: number;
              last_run_at: number | null;
              current_consistent: boolean | null;
            };
            loop_enabled: boolean;
            chain: string;
          };
          if (!body.loop_enabled) {
            checks.push({
              name: "Treasury reconciliation",
              ok: true,
              detail: "loop disabled (testnet mode or X402_PAY_TO_ADDRESS unset)",
            });
          } else if (body.stats.last_run_at == null) {
            checks.push({
              name: "Treasury reconciliation",
              ok: true,
              detail: `loop enabled (${body.chain}), no cycles yet (recent boot)`,
            });
          } else {
            const ageMs = Date.now() - body.stats.last_run_at;
            // 2× default 15-min cadence — generous enough to absorb a
            // single missed tick without flagging a healthy loop.
            const STALE_THRESHOLD_MS = 30 * 60_000;
            if (ageMs > STALE_THRESHOLD_MS) {
              checks.push({
                name: "Treasury reconciliation",
                ok: false,
                detail: `loop stale — last run ${Math.round(ageMs / 60_000)}m ago (expected within 30m)`,
                remedy: "check relay logs for `treasury-reconciliation.cycle_uncaught`",
              });
            } else if (body.stats.current_consistent === false) {
              checks.push({
                name: "Treasury reconciliation",
                ok: false,
                detail: `negative drift on last cycle (${body.stats.total_runs} runs total)`,
                remedy:
                  "inspect via GET /api/v1/admin/treasury-reconciliation; manual sweeps cause known false positives",
              });
            } else {
              checks.push({
                name: "Treasury reconciliation",
                ok: true,
                detail: `healthy — last run ${Math.round(ageMs / 60_000)}m ago, ${body.stats.total_runs} runs total`,
              });
            }
          }
        } else {
          checks.push({
            name: "Treasury reconciliation",
            ok: true,
            detail: `relay returned HTTP ${res.status} (skipping)`,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          name: "Treasury reconciliation",
          ok: true,
          detail: `probe failed: ${msg}`,
        });
      }
    }
  }

  // Secure Enclave availability (hardware-attestation channel).
  // Platform heuristic — the CLI doesn't itself mint attestations (the
  // desktop Tauri app does, via security-framework), so this check
  // reports structural capability rather than a live round-trip. On
  // Apple Silicon macOS the SE is always present; on Intel Macs
  // pre-T2 or non-macOS hosts it's absent. The check never fails —
  // hardware attestation is optional, software-custody is a truthful
  // fallback (`HardwareAttestationSemiring` scores software at 0.1).
  checks.push({
    name: "Secure Enclave",
    ok: true,
    detail: detectSecureEnclaveAvailability(),
  });

  // Print results
  console.log("\nmotebit doctor\n");
  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? "ok" : "FAIL";
    console.log(`  ${icon.padEnd(6)} ${check.name.padEnd(20)} ${check.detail}`);
    if (check.remedy != null && check.remedy !== "") {
      console.log(`         ${" ".repeat(20)} → ${check.remedy}`);
    }
    if (!check.ok) allOk = false;
  }
  console.log();

  // Recent turn-failure summary. Surfaces what the stage-timeout telemetry
  // and scheduler failures would otherwise only log to stderr. Turns silent
  // "it failed sometime" into "here's which stage failed and when." Opt-in
  // on existing identity — no motebit_id means no DB to read.
  if (fullCfg.motebit_id != null && fullCfg.motebit_id !== "") {
    try {
      const db = await openMotebitDatabase(getDbPath(undefined));
      try {
        const recent = db.goalOutcomeStore.listRecent(fullCfg.motebit_id, 50);
        const failed = recent.filter((o) => o.status === "failed");
        if (failed.length === 0) {
          console.log("Recent scheduled runs: no failures.\n");
        } else {
          console.log(
            `Recent scheduled runs: ${failed.length} failure(s) in last ${recent.length} outcomes`,
          );
          // Group by a coarse bucket derived from the error message. Stage
          // timeouts carry "stage \"<name>\"" which we extract; everything
          // else clusters under "other" with its first line as summary.
          const byBucket = new Map<string, number>();
          for (const o of failed) {
            const bucket = extractStageBucket(o.error_message) ?? "other";
            byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
          }
          for (const [bucket, count] of [...byBucket.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(count).padStart(3)}× ${bucket}`);
          }
          // Most recent failure gets a detailed print so the user can act.
          const newest = failed[0]!;
          console.log();
          console.log(`Most recent: ${new Date(newest.ran_at).toISOString()}`);
          if (newest.error_message) {
            console.log(`  ${newest.error_message.split("\n")[0]!.slice(0, 200)}`);
          }
          console.log();
        }
      } finally {
        db.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`(could not read recent outcomes: ${msg})\n`);
    }
  }

  if (!allOk) {
    console.log("Some checks failed. See https://docs.motebit.com for troubleshooting.\n");
    process.exit(1);
  } else {
    console.log("All checks passed.\n");
  }
}

/**
 * Extract a coarse failure bucket from an error message. Stage-timeout
 * errors carry `stage "<name>" timed out …`; we surface the stage name so
 * doctor groups them correctly. Everything else returns null (caller labels
 * as "other").
 */
function extractStageBucket(errMsg: string | null): string | null {
  if (errMsg == null || errMsg === "") return null;
  const stageMatch = errMsg.match(/stage\s+"([^"]+)"/);
  if (stageMatch) return `stage_timeout:${stageMatch[1]}`;
  const connMatch = errMsg.match(/connection timeout after \d+ms/);
  if (connMatch) return "connection_timeout";
  return null;
}

/**
 * Best-effort Secure Enclave availability description. The CLI runs
 * outside the Tauri app process and can't invoke the Rust
 * `se_available()` command directly; this heuristic reads the host
 * platform to report structural capability. A real round-trip probe
 * lives in the desktop app's diagnostics surface.
 *
 *   - macOS + Apple Silicon (arm64) → "available on this host (Apple
 *     Silicon)"
 *   - macOS + x86_64 → "unknown — requires T2 chip (Mac 2018+) or
 *     Apple Silicon"
 *   - non-macOS → "not available (macOS-only)"
 *
 * Every branch returns `ok: true` — SE is optional; its absence is
 * honest, not a failure.
 */
function detectSecureEnclaveAvailability(): string {
  if (process.platform !== "darwin") {
    return "not available (macOS-only; desktop-app feature)";
  }
  if (process.arch === "arm64") {
    return "available on this host (Apple Silicon)";
  }
  return "unknown — requires T2 chip (Mac 2018+) or Apple Silicon";
}

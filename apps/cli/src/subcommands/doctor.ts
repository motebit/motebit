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

export async function handleDoctor(): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

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
    console.log(`  ${icon.padEnd(6)} ${check.name.padEnd(14)} ${check.detail}`);
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

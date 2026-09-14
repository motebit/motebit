/**
 * Worker containers never hold the relay master token.
 *
 * `MOTEBIT_API_TOKEN` is the relay operator's master credential: it bypasses
 * rate limits and unlocks identity/device registration, every admin route,
 * sync, state, execution. Until 2026-09-13 every first-party worker (research,
 * code-review, the atoms) read it from its environment and presented it as the
 * bearer on register / heartbeat / listing / deregister / caller-key lookups —
 * so a compromised worker container was a compromised relay. Workers now
 * authenticate to their relay as THEMSELVES: short-lived audience-bound tokens
 * signed by the worker's own identity key (`RelayAuth` in `@motebit/mcp-server`,
 * wired by `molecule-runner` from the bootstrapped identity). The relay
 * introduces a fresh identity through the public, rate-limited
 * `POST /api/v1/agents/bootstrap`; no operator secret is involved anywhere.
 *
 * This gate keeps the secret out for good. It fails on:
 *
 *   1. any read of `MOTEBIT_API_TOKEN` in non-test source under `services/*`
 *      (the relay itself excepted — it OWNS the secret). browser-sandbox was
 *      allowlisted at first for a same-named but different secret (its own v1
 *      inbound shared bearer); that bearer was retired 2026-09-14 and the
 *      allowlist entry with it — the trigger written into it fired;
 *   2. any read of `MOTEBIT_API_TOKEN` in the two packages that host workers
 *      (`molecule-runner`, `mcp-server`) other than molecule-runner's boot
 *      warning that tells an operator to remove a stale secret;
 *   3. an `apiToken` field on the worker-side config surfaces
 *      (`MoleculeConfig`, `McpServiceConfig`, `WireServerDepsOptions`) — the
 *      plumbing through which a master token would travel again.
 *
 * Why a gate and not a code review: the secret's presence was never a
 * failing test. Every worker was green with it; the relay accepted it; the
 * only thing wrong was blast radius, which no unit test measures. Same class
 * as `check-credit-caller-allowlist` — a permanent structural lock behind a
 * hole that was closed once.
 *
 * Exit 1 on any violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();

/**
 * Services allowed to read `MOTEBIT_API_TOKEN`, each with the reason the read
 * is not a worker holding the relay's secret. Adding a service here is the
 * doctrine moment — say why its token is not the relay master token.
 */
const ALLOWED_SERVICES: ReadonlyMap<string, string> = new Map([
  ["relay", "the relay OWNS the master token — this is the one legitimate reader"],
]);

/** The one permitted mention inside the worker-hosting packages: the boot warning. */
const BOOT_WARNING_MARKER = "is NOT used";

const WORKER_PACKAGES = ["packages/molecule-runner", "packages/mcp-server"];

/**
 * A READ of the variable, not a mention: `process.env["MOTEBIT_API_TOKEN"]`,
 * `process.env.MOTEBIT_API_TOKEN`, `env.MOTEBIT_API_TOKEN`, or a bracket
 * lookup on any env-shaped object. Prose in a comment that names the variable
 * to say it is refused is not a read.
 */
const ENV_READ =
  /(?:process\.env|\benv)\s*(?:\.\s*MOTEBIT_API_TOKEN\b|\[\s*["']MOTEBIT_API_TOKEN["']\s*\])/;
const CONFIG_FIELD = /^\s*apiToken\??:\s*string/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === "coverage" ||
        entry === "__tests__"
      )
        continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

function serviceDirs(): string[] {
  const base = join(ROOT, "services");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => existsSync(join(base, d, "src")))
    .sort();
}

function main(): void {
  const violations: string[] = [];
  let filesScanned = 0;
  const services = serviceDirs();
  const scannedServices: string[] = [];

  for (const svc of services) {
    if (ALLOWED_SERVICES.has(svc)) continue;
    scannedServices.push(svc);
    const files: string[] = [];
    walk(join(ROOT, "services", svc, "src"), files);
    for (const file of files) {
      filesScanned++;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (ENV_READ.test(line)) {
          violations.push(`${relative(ROOT, file)}:${i + 1}: reads MOTEBIT_API_TOKEN`);
        }
      });
    }
  }

  for (const pkg of WORKER_PACKAGES) {
    const files: string[] = [];
    walk(join(ROOT, pkg, "src"), files);
    for (const file of files) {
      filesScanned++;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (ENV_READ.test(line) && !line.includes(BOOT_WARNING_MARKER)) {
          // The boot warning spans two lines: the env check and the message.
          // Allow the check line when the message follows within 5 lines.
          const window = lines.slice(i, i + 6).join("\n");
          if (!window.includes(BOOT_WARNING_MARKER)) {
            violations.push(`${relative(ROOT, file)}:${i + 1}: reads MOTEBIT_API_TOKEN`);
          }
        }
        if (CONFIG_FIELD.test(line)) {
          violations.push(
            `${relative(ROOT, file)}:${i + 1}: \`apiToken\` config field — the plumbing a master token would travel through`,
          );
        }
      });
    }
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "a worker never holds the relay master token: no service outside the relay reads MOTEBIT_API_TOKEN, and no worker-side config carries an `apiToken` field (a compromised worker container must not be a compromised relay — 2026-09-13)",
      sites: violations,
      canonical:
        "packages/mcp-server/src/service.ts (`RelayAuth`: the worker signs per-audience tokens with its OWN key; `POST /api/v1/agents/bootstrap` introduces a fresh key publicly)",
      fix: "Remove the MOTEBIT_API_TOKEN read / `apiToken` field. If the call needs a relay bearer, mint one with `makeAuthTokenMinter(identity)` from @motebit/molecule-runner (audience per spec/auth-token-v1.md §5: `admin:query` for register/heartbeat/deregister, `market:listing` for the listing, `task:submit` to open a task). A same-named secret that is NOT the relay's master token belongs in ALLOWED_SERVICES with its reason.",
      doctrine: "docs/doctrine/task-admission.md § The worker authenticates as itself",
    });
  }

  console.log(
    `✓ No worker holds the relay master token: ${filesScanned} source file(s) scanned across ${scannedServices.length} service(s) (${scannedServices.join(", ")}) + ${WORKER_PACKAGES.length} worker package(s); ${ALLOWED_SERVICES.size} allowlisted reader(s): ${[...ALLOWED_SERVICES.keys()].join(", ")}.`,
  );
}

main();

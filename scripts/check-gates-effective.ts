/**
 * Gate effectiveness probe — every registered gate must actually fire.
 *
 * The drift-defense system has a subtle failure mode: a check script can sit
 * in `GATES` (scripts/check.ts), run during CI, exit 0 on every run, and
 * appear green — yet check nothing. That happened with `check-memory`, which
 * always exits 0 by design and silently no-ops on CI runners where its
 * user-local target path doesn't exist. Category error: advisory tool in a
 * hard-gate slot.
 *
 * Registry completeness (accounted for or not) doesn't catch this — a
 * misrouted entry looks identical to a correct one. The invariant we need
 * is stronger: *when the invariant a gate claims to defend is violated,
 * the gate must exit non-zero*.
 *
 * This probe runs each gate against a deliberately-broken fixture and
 * asserts it fails with a non-zero exit code. If a gate doesn't fail
 * under a known-bad input, it isn't a gate — it's decoration.
 *
 * ── How probes work ─────────────────────────────────────────────────────
 *
 * Each probe declares a `perturb()` function that:
 *   1. Writes a small known-violating fixture file into the repo.
 *   2. Returns a cleanup function that reverts the perturbation.
 *
 * The probe runner:
 *   1. Applies the perturbation.
 *   2. Runs the gate via `pnpm <script>`.
 *   3. Asserts the gate exited non-zero.
 *   4. Calls cleanup.
 *
 * Cleanup also runs on process exit / signal, so an interrupted probe
 * doesn't leave fixture files behind.
 *
 * ── Adding a new gate ───────────────────────────────────────────────────
 *
 * Add an entry to PROBES with a perturbation that is minimal, distinctive,
 * and reversible. Prefer creating a single fixture file with a clearly-
 * invalid shape over mutating existing code — fixtures are easier to clean
 * up and leave a cleaner git diff if anything goes wrong.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Distinctive prefix — any stray fixture file is easy to find and remove. */
const PROBE_PREFIX = "__gate_probe__";

interface Probe {
  /** Matches the `script` field of an entry in scripts/check.ts GATES. */
  script: string;
  /**
   * Extra args to forward. Must match the GATES entry's `args` so the probe
   * runs the gate in the same mode CI does (e.g. check-specs --strict).
   */
  args?: string[];
  /** What invariant this probe proves the gate enforces. */
  proves: string;
  /** Apply a violation; return a cleanup function that reverts it. */
  perturb: () => () => void;
}

/**
 * Write a fixture file and return a cleanup that removes it. If the file
 * already exists (unlikely — prefix guards against this), refuse to
 * clobber.
 */
function writeFixture(relativePath: string, content: string): () => void {
  const absolute = resolve(ROOT, relativePath);
  if (existsSync(absolute)) {
    throw new Error(
      `probe refused to clobber existing file: ${relativePath}. Is a prior probe not cleaned up?`,
    );
  }
  writeFileSync(absolute, content);
  return () => {
    if (existsSync(absolute)) unlinkSync(absolute);
  };
}

/**
 * Mutate an existing file and return a cleanup that restores the original
 * content. Used when a probe must modify a real config file (e.g. package.json)
 * rather than create a new file.
 */
function mutateFile(relativePath: string, mutate: (src: string) => string): () => void {
  const absolute = resolve(ROOT, relativePath);
  const original = readFileSync(absolute, "utf-8");
  writeFileSync(absolute, mutate(original));
  return () => writeFileSync(absolute, original);
}

const PROBES: ReadonlyArray<Probe> = [
  {
    script: "check-service-primitives",
    proves: "flags a forbidden @motebit/encryption import inside a service",
    perturb: () =>
      writeFixture(
        `services/code-review/src/${PROBE_PREFIX}forbidden_import.ts`,
        // A forbidden package import. The gate scans service src/ recursively
        // and treats any non-test file's @motebit/encryption import as a
        // violation.
        `import { verifySignedToken } from "@motebit/encryption";\nvoid verifySignedToken;\n`,
      ),
  },
  {
    script: "check-app-primitives",
    proves: "flags a forbidden @motebit/protocol import inside an app",
    perturb: () =>
      writeFixture(
        `apps/admin/src/${PROBE_PREFIX}forbidden_import.ts`,
        // Apps must consume the product vocabulary (@motebit/sdk), not the
        // protocol primitive directly.
        `import type { MotebitId } from "@motebit/protocol";\nexport type _Probe = MotebitId;\n`,
      ),
  },
  {
    script: "check-deploy-parity",
    proves: "flags an env var in .env.example that no source reads",
    perturb: () =>
      mutateFile(
        "services/code-review/.env.example",
        // Append an obviously-unused env var. The gate's env-name regex is
        // /^[A-Z][A-Z0-9_]*\s*=/ (conventional shell env vars) — so the name
        // MUST start with a capital letter or the line is ignored entirely,
        // which means no "stale declared var" violation would fire.
        // Distinctive middle-token for easy grep-and-grep-out if something
        // goes wrong.
        (src) => `${src}\nGATE_PROBE_UNUSED_VAR=never_read\n`,
      ),
  },
  {
    script: "check-deps",
    proves: "flags tsconfig references out of sync with package.json deps",
    perturb: () =>
      mutateFile(
        "packages/mcp-server/tsconfig.json",
        // Drop the @motebit/sdk tsconfig reference while keeping the
        // dependency in package.json. check-deps' "tsconfig references must
        // match production deps" rule should fire.
        (src) => src.replace(/\{\s*"path":\s*"\.\.\/sdk"\s*\},?\s*/, ""),
      ),
  },
  {
    script: "check-specs",
    // --strict flips check-specs from advisory to hard-fail. This must match
    // the `args` in the corresponding GATES entry (scripts/check.ts) — probe
    // and CI must run the gate in the same mode, or we're proving the wrong
    // thing. The category error we're defending against is: a soft-exit-0
    // script sitting in GATES pretending to be a gate.
    args: ["--strict"],
    proves: "flags a spec file that has zero implementation references (under --strict)",
    perturb: () =>
      writeFixture(
        `spec/${PROBE_PREFIX}orphan-v1.md`,
        // A spec file with a plausible schema identifier but no matching
        // implementation references anywhere in the tree.
        `# motebit/${PROBE_PREFIX}orphan@1.0\n\nOrphan spec — no implementation references.\n`,
      ),
  },
];

interface ProbeResult {
  probe: Probe;
  gateExitCode: number | null;
  ok: boolean;
  error?: string;
}

function runProbe(probe: Probe): ProbeResult {
  let cleanup: (() => void) | null = null;
  try {
    cleanup = probe.perturb();

    const result = spawnSync("pnpm", ["--silent", "run", probe.script], {
      stdio: "pipe",
      encoding: "utf-8",
    });

    const gateExitCode = result.status;
    // A gate that "works" MUST exit non-zero when given a known violation.
    // Zero = the gate didn't catch the injected drift = the gate is
    // decoration, not defense.
    const ok = gateExitCode !== null && gateExitCode !== 0;

    return { probe, gateExitCode, ok };
  } catch (err) {
    return {
      probe,
      gateExitCode: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(`  cleanup failed for ${probe.script}: ${String(err)}`);
      }
    }
  }
}

/**
 * Assert every entry in scripts/check.ts's GATES list has a matching probe.
 * The drift this defends against: someone adds a new gate to GATES but
 * forgets to add a probe here — the new gate would be accepted into CI
 * without any proof it actually fires.
 */
function assertProbeCoverage(): void {
  const checkTs = readFileSync(resolve(ROOT, "scripts/check.ts"), "utf-8");
  const gateScripts = new Set(
    [...checkTs.matchAll(/script:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]),
  );
  const probedScripts = new Set(PROBES.map((p) => p.script));

  const uncovered = [...gateScripts].filter((g) => !probedScripts.has(g));
  const stale = [...probedScripts].filter((p) => !gateScripts.has(p));

  const problems: string[] = [];
  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} gate(s) in scripts/check.ts have no probe here:\n` +
        uncovered.map((s) => `    - ${s}`).join("\n") +
        `\n  Add a probe with a minimal perturbation that the gate should catch.`,
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${stale.length} probe(s) target scripts that are no longer in GATES:\n` +
        stale.map((s) => `    - ${s}`).join("\n") +
        `\n  Remove the stale probe or add the gate back.`,
    );
  }

  if (problems.length > 0) {
    console.error(`\nProbe/gate registry out of sync:\n`);
    for (const msg of problems) console.error(`  ${msg}\n`);
    console.error(
      `A gate without a probe cannot be proven effective. A probe without a gate is dead code.\n`,
    );
    process.exit(2);
  }
}

function main(): void {
  assertProbeCoverage();

  const results: ProbeResult[] = [];
  // Install one-shot cleanup guards so interrupted runs don't leave probe
  // fixtures in the tree.
  let activeCleanup: (() => void) | null = null;
  const onExit = (): void => {
    if (activeCleanup) {
      try {
        activeCleanup();
      } catch {
        /* best-effort */
      }
    }
  };
  process.on("SIGINT", () => {
    onExit();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    onExit();
    process.exit(143);
  });

  for (const probe of PROBES) {
    process.stderr.write(`\n▸ ${probe.script} — ${probe.proves}\n`);
    // Patch runProbe's cleanup into activeCleanup so the signal handler sees it.
    // (Small duplication of runProbe's logic for this reason.)
    let cleanup: (() => void) | null = null;
    let gateExitCode: number | null = null;
    let ok = false;
    let error: string | undefined;
    try {
      cleanup = probe.perturb();
      activeCleanup = cleanup;
      const cmdArgs = ["--silent", "run", probe.script];
      if (probe.args && probe.args.length > 0) {
        cmdArgs.push("--", ...probe.args);
      }
      const result = spawnSync("pnpm", cmdArgs, {
        stdio: "pipe",
        encoding: "utf-8",
      });
      gateExitCode = result.status;
      ok = gateExitCode !== null && gateExitCode !== 0;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (cleanup) {
        try {
          cleanup();
        } catch (err) {
          console.error(`  cleanup failed: ${String(err)}`);
        }
      }
      activeCleanup = null;
    }
    results.push({ probe, gateExitCode, ok, error });
  }

  // Summary
  process.stderr.write("\n─── Gate effectiveness summary ───\n");
  let anyFailed = false;
  for (const { probe, gateExitCode, ok, error } of results) {
    const status = ok ? "✓" : "✗";
    const detail = error
      ? `error: ${error}`
      : ok
        ? `gate exited ${gateExitCode} (non-zero) as expected`
        : `gate exited ${gateExitCode} — did NOT catch the perturbation`;
    process.stderr.write(`  ${status} ${probe.script.padEnd(32)} ${detail}\n`);
    if (!ok) anyFailed = true;
  }

  if (anyFailed) {
    process.stderr.write(
      `\nOne or more gates failed to catch a known violation. Either the gate is wrong, the probe is wrong, or the gate is decoration masquerading as defense.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`\nAll ${PROBES.length} gates proven effective.\n`);
}

main();

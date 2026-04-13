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
import { writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync } from "node:fs";
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
  /**
   * Predicate: `true` means "the probe's gate has an escape hatch that is
   * currently active, so running the probe would test the escape rather than
   * the detection." When it returns `true`, the probe is skipped with an
   * explicit note — the caller sees `⚠ skipped (escape hatch active)` rather
   * than a silent pass. Used for check-api-surface during a pass where every
   * published package has a pending `major` changeset (the gate's intended
   * design: major changesets authorize API breaks).
   */
  skipWhen?: () => { skip: boolean; reason: string };
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
  {
    script: "check-changeset-discipline",
    proves: "flags a `major` changeset that lacks a non-empty ## Migration section",
    perturb: () =>
      writeFixture(
        // The gate reads .changeset/*.md, skipping README.md and CHANGELOG.md
        // only — our prefixed fixture is picked up like any pending changeset.
        `.changeset/${PROBE_PREFIX}major-no-migration.md`,
        // Frontmatter declares a `major` bump on a tracked published package.
        // Body contains nothing that looks like a ## Migration section, so the
        // gate's "every major must teach upgraders" invariant is violated.
        `---\n"@motebit/protocol": major\n---\n\nProbe-only major bump with no migration guide.\n`,
      ),
  },
  {
    script: "check-spec-coverage",
    // --strict is the gate's production mode (scripts/check.ts GATES). Probe
    // must match or we'd be proving the wrong mode.
    args: ["--strict"],
    proves:
      "flags a spec whose Wire format block names a type that @motebit/protocol does not export",
    perturb: () =>
      writeFixture(
        // A fixture spec with a `#### Wire format (foundation law)` block under
        // a `### X.Y — TypeName` heading whose identifier (`ProbeOnlyNonExported`)
        // does not appear in packages/protocol. The probe relies on the gate's
        // regex: the section heading declares the type; check-spec-coverage
        // asserts the protocol package exports it.
        `spec/${PROBE_PREFIX}coverage-v1.md`,
        `# motebit/${PROBE_PREFIX}coverage@1.0

## 1. ProbeArtifact

### 1.1 — ProbeOnlyNonExportedSymbol

#### Wire format (foundation law)

Probe-only artifact — \`ProbeOnlyNonExportedSymbol\` is not exported from \`@motebit/protocol\` by design so \`check-spec-coverage\` fails on this file.
`,
      ),
  },
  {
    script: "check-suite-declared",
    proves: "flags a Wire format block that declares `signature` but no `suite` field",
    perturb: () =>
      writeFixture(
        // A signed wire-format artifact in pseudo-TypeScript inside a code
        // block — the gate detects `signature` / `suite` field declarations in
        // both markdown tables and code blocks. By declaring `signature`
        // without `suite`, the gate's invariant-#11 rule fires.
        `spec/${PROBE_PREFIX}suite-declared-v1.md`,
        `# motebit/${PROBE_PREFIX}suite-declared@1.0

## 1. ProbeArtifact

#### Wire format (foundation law)

\`\`\`
ProbeArtifact {
  probe_id:   string      // arbitrary
  signature:  string      // signed but no suite — drift gate should catch this
}
\`\`\`
`,
      ),
  },
  {
    script: "check-suite-dispatch",
    proves:
      "flags a direct @noble/ed25519 primitive call outside packages/crypto/src/suite-dispatch.ts (scope: packages/crypto/src/, services/, apps/)",
    perturb: () =>
      writeFixture(
        // Any .ts under packages/crypto/src/ (outside suite-dispatch.ts) that
        // contains the forbidden pattern `ed.verifyAsync` is a violation.
        // Use a non-top-level directory so it's picked up by the recursive
        // walk — `scan-dir/__probe.ts` would also work, but a top-level file
        // mirrors the way a real drift would appear in code review.
        `packages/crypto/src/${PROBE_PREFIX}primitive-leak.ts`,
        `// Probe-only file that leaks a primitive verify call.
// If check-suite-dispatch is working, it refuses to accept this file.
declare const ed: { verifyAsync(a: Uint8Array, b: Uint8Array, c: Uint8Array): Promise<boolean> };
declare const sig: Uint8Array;
declare const msg: Uint8Array;
declare const pub: Uint8Array;
export async function probeLeak(): Promise<boolean> {
  return ed.verifyAsync(sig, msg, pub);
}
`,
      ),
  },
  {
    script: "check-dist-smoke",
    proves:
      "flags a dist binary that fails to boot (bundling regression class: CJS-in-ESM, missing exports subpath, wrong runtime dep version)",
    perturb: () =>
      // Swap the CLI's real dist entry with a known-crashing one.
      // `process.exit(2)` is deterministic and distinct from the
      // accepted exit code (0) — the gate should flag exit 2 as a
      // non-match and fail. Cleanup restores the original dist on the
      // next tick so subsequent probes and tests see the real binary.
      mutateFile(
        "apps/cli/dist/index.js",
        () =>
          `#!/usr/bin/env node\nconsole.error("${PROBE_PREFIX}intentional crash for dist-smoke probe");\nprocess.exit(2);\n`,
      ),
  },
  {
    script: "check-api-surface",
    // Requires packages/{protocol,crypto,sdk}/dist to exist so api-extractor
    // can read the .d.ts and produce etc/temp/*.api.md to diff against the
    // (mutated) baseline. Pre-push and the CI gate-effectiveness job run
    // `pnpm build` before this probe for exactly that reason — without dist/,
    // api-extractor errors on missing input and the probe would "pass" for
    // the wrong reason (non-zero exit without actually proving drift
    // detection).
    proves: "flags a committed baseline that diverges from the extracted API surface",
    perturb: () =>
      mutateFile(
        // Mutating the baseline (not the source) gives us a deterministic
        // divergence without a rebuild: dist/ is unchanged, so extractor
        // produces the current surface in etc/temp/, which now differs from
        // the doctored baseline. Assumes no pending `major` changeset for
        // @motebit/protocol — otherwise the gate would accept the diff as
        // declared-breaking and exit 0 (see check-api-surface.ts escape
        // hatch). If a real major is ever pending while this probe runs,
        // we skip the probe (see skipWhen below) rather than test the wrong
        // thing; returning ok=true on a skipped probe would be a false
        // positive ("gate is effective" when we proved nothing).
        "packages/protocol/etc/protocol.api.md",
        (src) => `// ${PROBE_PREFIX}injected drift marker\n${src}`,
      ),
    skipWhen: () => scanChangesetsForMajor("@motebit/protocol"),
  },
];

/**
 * Return `{ skip: true, reason }` if a pending changeset declares a `major`
 * bump on `pkgName`. The caller uses this to skip probes whose gate has a
 * documented escape hatch keyed to pending majors (e.g. check-api-surface).
 */
function scanChangesetsForMajor(pkgName: string): { skip: boolean; reason: string } {
  const dir = resolve(ROOT, ".changeset");
  if (!existsSync(dir)) return { skip: false, reason: "" };
  const entries = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && f !== "CHANGELOG.md",
  );
  for (const name of entries) {
    const body = readFileSync(resolve(dir, name), "utf-8");
    const front = body.match(/^---\n([\s\S]*?)\n---/);
    if (!front) continue;
    const line = new RegExp(`^"${pkgName.replace("/", "/")}":\\s*major\\s*$`, "m");
    if (line.test(front[1]!)) {
      return {
        skip: true,
        reason: `pending \`major\` changeset for ${pkgName} activates the gate's escape hatch — probe would test the escape, not the detection`,
      };
    }
  }
  return { skip: false, reason: "" };
}

interface ProbeResult {
  probe: Probe;
  gateExitCode: number | null;
  ok: boolean;
  error?: string;
  skipped?: { reason: string };
}

function runProbe(probe: Probe): ProbeResult {
  // Escape-hatch check — run before perturbation so we don't touch the tree
  // for a probe we're going to skip.
  if (probe.skipWhen) {
    const decision = probe.skipWhen();
    if (decision.skip) {
      return { probe, gateExitCode: null, ok: true, skipped: { reason: decision.reason } };
    }
  }

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
    // Escape-hatch check. If a gate has a documented escape hatch currently
    // active (e.g. check-api-surface during a release with a pending major
    // changeset), the probe would test the escape rather than the detection.
    // Skip explicitly — an ok=true on skipped probes is a false positive.
    if (probe.skipWhen) {
      const decision = probe.skipWhen();
      if (decision.skip) {
        process.stderr.write(`  ⚠ skipped: ${decision.reason}\n`);
        results.push({
          probe,
          gateExitCode: null,
          ok: true,
          skipped: { reason: decision.reason },
        });
        continue;
      }
    }
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
  let skippedCount = 0;
  for (const { probe, gateExitCode, ok, error, skipped } of results) {
    if (skipped) {
      process.stderr.write(`  ⚠ ${probe.script.padEnd(32)} skipped — ${skipped.reason}\n`);
      skippedCount++;
      continue;
    }
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

  const provenCount = PROBES.length - skippedCount;
  const skipNote = skippedCount > 0 ? ` (${skippedCount} skipped — see ⚠ above)` : "";
  process.stderr.write(`\n${provenCount} of ${PROBES.length} gates proven effective${skipNote}.\n`);
}

main();

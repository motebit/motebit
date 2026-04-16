/**
 * Meta-check runner — one command that runs every hard-fail drift defense.
 *
 * The monorepo's synchronization invariants are enforced by a collection of
 * small, focused check-* scripts (see CLAUDE.md § "Synchronization
 * invariants are the meta-principle"). Each one owns a specific invariant:
 *
 *   check-deps              — architectural layers, MIT purity, cycles
 *   check-specs             — spec ↔ implementation references
 *   check-service-primitives — services must not inline protocol plumbing
 *   check-app-primitives    — apps must not bypass the product vocabulary
 *
 * Before this runner existed, CI invoked each check individually —
 * meaning a new check that was only added to package.json (but not to
 * ci.yml) would run locally but stay silent in PRs. That is the exact
 * drift shape the checks themselves are designed to prevent.
 *
 * This runner is the single source of truth for which defenses run.
 * CI calls `pnpm check` once; adding a new gate means appending an
 * entry here. Adversarially tested: if any gate fails, this process
 * exits non-zero with a summary of which one(s).
 *
 * Soft/advisory checks are intentionally excluded from this runner:
 *   check-unused (knip)              — soft signal, CI uses continue-on-error
 *   check-sibling-boundaries         — PR-diff scoped, runs separately
 *   check-secrets.sh                 — pre-commit hook, not a CI gate
 *
 * Each exclusion must be named in EXCLUDED_CHECKS below so this runner
 * can assert that every `check-*` script in root package.json is either
 * listed as a gate or explicitly excluded — closing the sibling-drift
 * gap in the drift-defense system itself.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Gate {
  name: string;
  /** What this gate defends. Shown when the gate fails so operators see the intent, not just the failure. */
  defends: string;
  /** npm/pnpm script name — must exist in root package.json. */
  script: string;
  /**
   * Extra args passed to the script. Used when a script has a soft default
   * but exposes a strict mode via flag (e.g. check-specs --strict). The gate
   * list is the policy layer; the script is the mechanism.
   */
  args?: string[];
}

/**
 * Explicitly excluded check-* scripts. Anything in root package.json that
 * starts with `check-` and is not in GATES must appear here, with a
 * one-line reason. This defends against the exact drift this runner exists
 * to prevent: a new check-* added to package.json but silently omitted
 * from CI.
 */
const EXCLUDED_CHECKS: Record<string, string> = {
  "check-unused": "soft signal (knip) — CI uses continue-on-error, not a hard gate",
  "check-sibling-boundaries": "PR-diff scoped advisory — runs as a separate CI job",
  "check-gates-effective":
    "meta-probe that runs every GATES entry under a deliberate perturbation — would invoke each gate a second time per PR. Runs as a separate CI job scoped to scripts/* changes.",
};

// Order matters: run fastest first so CI fails loudly on the cheapest signal.
const GATES: ReadonlyArray<Gate> = [
  {
    name: "check-deps",
    defends: "architectural layers, MIT purity, cycles, tsconfig refs",
    script: "check-deps",
  },
  {
    name: "check-specs",
    defends: "every spec/*.md is referenced by implementation code",
    script: "check-specs",
    // --strict promotes the script from advisory to hard-fail: exit 1 if any
    // spec has zero references. The doctrine (CLAUDE.md § "Never let divergence
    // persist") makes this invariant right for the project even though the
    // script defaults to advisory for direct invocation.
    args: ["--strict"],
  },
  {
    name: "check-spec-coverage",
    defends:
      "types named in spec Wire format (foundation law) sections are exported from @motebit/protocol; every spec has adopted the wire-vs-storage split",
    script: "check-spec-coverage",
    // --strict promotes the grace-period warning (unstructured specs) into a
    // hard fail. Flipped on 2026-04-13 after all twelve specs adopted the
    // wire-vs-storage doctrine. The tenth synchronization invariant is now
    // locked at category 2 — a new spec MUST ship with at least one
    // "#### Wire format (foundation law)" subsection or CI fails.
    args: ["--strict"],
  },
  {
    name: "check-suite-declared",
    defends:
      "every signed wire-format artifact declares a `suite` field naming a @motebit/protocol-registered SuiteId (invariant #10)",
    script: "check-suite-declared",
  },
  {
    name: "check-suite-dispatch",
    defends:
      "every signature primitive call in @motebit/crypto, services/, and apps/ routes through suite-dispatch.ts — no implicit Ed25519 defaults (invariant #11; scope widened from packages/crypto/src/ only on 2026-04-13)",
    script: "check-suite-dispatch",
  },
  {
    name: "check-dist-smoke",
    defends:
      "every published binary (apps/cli, packages/create-motebit) boots cleanly — catches bundling regressions before publish (invariant #12, added 2026-04-13 after @noble/hashes × @solana/web3.js slipped into apps/cli/dist/)",
    script: "check-dist-smoke",
  },
  {
    name: "check-service-primitives",
    defends: "services must route protocol plumbing through @motebit/mcp-server",
    script: "check-service-primitives",
  },
  {
    name: "check-app-primitives",
    defends: "apps must consume product vocabulary, not protocol primitives",
    script: "check-app-primitives",
  },
  {
    name: "check-affordance-routing",
    defends:
      "UI affordances (chips, buttons, slash commands, scene clicks) must invoke capabilities via `invokeCapability`, never by constructing natural-language prompts routed through the AI loop (invariant #15, added 2026-04-14 after the PR-URL chip showcase exposed the ambiguity of model-mediated routing)",
    script: "check-affordance-routing",
  },
  {
    name: "check-deploy-parity",
    defends: "fly.toml ↔ deploy workflow ↔ .env.example ↔ source env reads",
    script: "check-deploy-parity",
  },
  {
    name: "check-changeset-discipline",
    defends: "every `major` changeset must ship a non-empty ## Migration section",
    script: "check-changeset-discipline",
  },
  {
    name: "check-api-surface",
    defends:
      "@motebit/{protocol,crypto,sdk} public API must match committed baseline unless a `major` changeset is pending",
    script: "check-api-surface",
  },
  {
    name: "check-docs-tree",
    defends:
      "apps/docs/content/docs/operator/architecture.mdx directory tree mirrors the filesystem and scripts/check-deps.ts LAYER/MIT_PACKAGES (invariant #13, added 2026-04-14 after the architecture page was rewritten and 9 packages were previously misplaced across invented tiers)",
    script: "check-docs-tree",
  },
  {
    name: "check-spec-mit-boundary",
    defends:
      "every backticked callable referenced in spec/*.md is exported from an MIT package (protocol/crypto/sdk) or explicitly waived with a reason (invariant #14, added 2026-04-14 after an external review asked whether protocol-only algorithms could leak into BSL; the probe caught deriveSyncEncryptionKey as a real leak and forced the spec to inline the HKDF recipe)",
    script: "check-spec-mit-boundary",
  },
  {
    name: "check-privacy-ring",
    defends:
      "every surface app (web/cli/desktop/mobile/spatial) declares and imports @motebit/event-log + @motebit/privacy-layer — the Ring 2 fail-closed privacy substrate the root CLAUDE.md claims as doctrine (invariant #16, added 2026-04-16 after the birds-eye audit caught web/spatial/cli missing one or both declarations)",
    script: "check-privacy-ring",
  },
];

interface Result {
  gate: Gate;
  ok: boolean;
  durationMs: number;
}

function runGate(gate: Gate): Result {
  const started = Date.now();
  const cmdArgs = ["--silent", "run", gate.script];
  if (gate.args && gate.args.length > 0) {
    // pnpm forwards anything after `--` to the underlying script.
    cmdArgs.push("--", ...gate.args);
  }
  const result = spawnSync("pnpm", cmdArgs, {
    stdio: "inherit",
    encoding: "utf-8",
  });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  return { gate, ok, durationMs };
}

/**
 * Assert every `check-*` script in root package.json is either a gate or
 * explicitly excluded. Catches the drift where a new defense is added
 * to package.json but forgotten here (and therefore in CI).
 */
function assertRegistryCompleteness(): void {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  };
  const declared = new Set(Object.keys(pkg.scripts).filter((k) => k.startsWith("check-")));
  const accounted = new Set<string>([
    ...GATES.map((g) => g.script),
    ...Object.keys(EXCLUDED_CHECKS),
  ]);

  const unaccounted = [...declared].filter((c) => !accounted.has(c));
  if (unaccounted.length > 0) {
    process.stderr.write(
      `\nerror: ${unaccounted.length} check-* script(s) in package.json are neither registered as gates nor explicitly excluded:\n`,
    );
    for (const script of unaccounted) {
      process.stderr.write(`  - ${script}\n`);
    }
    process.stderr.write(
      `\nAdd each to GATES (if hard-fail CI) or to EXCLUDED_CHECKS with a reason (if soft/context-scoped).\n`,
    );
    process.exit(2);
  }
}

function main(): void {
  assertRegistryCompleteness();

  const results: Result[] = [];
  let failed = false;

  for (const gate of GATES) {
    process.stderr.write(`\n▸ ${gate.name} — ${gate.defends}\n`);
    const result = runGate(gate);
    results.push(result);
    if (!result.ok) failed = true;
  }

  // Summary
  process.stderr.write("\n─── Drift defense summary ───\n");
  for (const { gate, ok, durationMs } of results) {
    const status = ok ? "✓" : "✗";
    process.stderr.write(`  ${status} ${gate.name.padEnd(30)} ${durationMs}ms\n`);
  }

  if (failed) {
    const failures = results.filter((r) => !r.ok).map((r) => r.gate.name);
    process.stderr.write(`\nFailed: ${failures.join(", ")}\n`);
    process.exit(1);
  }

  process.stderr.write(`\nAll ${GATES.length} drift defenses passed.\n`);
}

main();

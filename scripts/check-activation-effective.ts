/**
 * Activation-conformance effectiveness — the durability net for the booted
 * behavioral-severing suites (docs/doctrine/composition-preserves-enforcement.md).
 *
 * `check-gates-effective` proves every STATIC GATE reds on a broken fixture:
 * *when the invariant a gate defends is violated, the gate must fail.* This is
 * its sibling for the BOOTED ACTIVATION suites. Those suites boot the compiled
 * relay artifact and assert a deployed-system guarantee (a receipt is verified,
 * a settlement is recorded with the right fee, a settlement drives a trust
 * update, self-dealing mints no trust). Each was shown to DISCRIMINATE — to
 * red when its production wiring is severed — but only by a MANUAL severing run
 * recorded in the PR. Nothing re-applied it, so a later refactor could make a
 * suite vacuously green (always passing regardless of the guarantee) and no CI
 * signal would notice. That undercuts the arc's own bar: the class approaches
 * closed only on "hostile production-path evidence — the activation-conformance
 * suite catching REINTRODUCED severings against the real deployable." This gate
 * makes that reintroduction CONTINUOUS instead of a human, once.
 *
 * For each probe: reintroduce a real severing into the relay SOURCE, rebuild
 * the compiled artifact (`pnpm --filter @motebit/relay build`), run the booted
 * suite it defends, and REQUIRE the suite to FAIL. A suite that stays green
 * under its own severing is VACUOUS — it no longer guards the guarantee — and
 * this meta-gate reds with a repair instruction. The perturbation is reverted
 * and a clean rebuild restores dist at the end.
 *
 * Each probe's mutation must build CLEANLY (so the suite reds on its assertion,
 * not on a broken build). The runner enforces this: a perturbation that breaks
 * the build is a probe-authoring error, reported distinctly from a vacuous
 * suite — it never masquerades as "the suite discriminated."
 *
 * Heavier than `check-gates-effective` (a dist rebuild per probe), so it runs
 * as its OWN CI job, never in the fast `pnpm check` path. It mutates a real
 * source file in place → it MUST run in isolation (same discipline, and same
 * drain/abort guards, as `check-gates-effective`).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RELAY = resolve(ROOT, "services/relay");
const TESTS_DIR = resolve(RELAY, "src/__tests__");
const TASKS = "services/relay/src/tasks.ts";

interface Probe {
  /** The booted suite this probe defends (basename, used as the vitest filter). */
  suite: string;
  /** Which link's guarantee the suite carries. */
  guards: string;
  /** The production file the severing mutates. */
  target: string;
  /** Reintroduce the severing. Must produce a CLEAN build. */
  mutate: (src: string) => string;
  /** The observable the suite asserts — surfaced in the repair instruction. */
  observable: string;
}

/**
 * One representative, individually-run severing per booted behavioral suite.
 * Every mutation here is a real defect shape and was confirmed (in its PR) to
 * turn exactly one half of its suite red. Each is chosen to build cleanly:
 * conditions are weakened (`false &&`) rather than deleted, and where a value
 * is forced, the now-unreferenced bindings are `void`-marked so `tsc` stays
 * happy and the suite reds on its ASSERTION.
 */
const PROBES: readonly Probe[] = [
  {
    suite: "booted-receipt-activation",
    guards: "action→receipt — settlement gated on a valid Ed25519 receipt",
    target: TASKS,
    // Force the receipt-verify result true (the #375 forgery-half severing).
    mutate: (src) =>
      replaceOnce(
        src,
        "let receiptValid = await verifyExecutionReceipt(receipt, hexToBytes(pubKeyHex));",
        "let receiptValid = true;\n  void verifyExecutionReceipt;\n  void hexToBytes;\n  void pubKeyHex;",
      ),
    observable: "a byte-tampered signature must yield 403 at POST /agent/:id/task/:taskId/result",
  },
  {
    suite: "booted-settlement-activation",
    guards: "receipt→settlement — P2P fee-destination binding",
    target: TASKS,
    // Short-circuit the fee-leg treasury-address check (the #376 reject-half severing).
    mutate: (src) =>
      replaceOnce(
        src,
        "if (proof.fee_to_address !== relayTreasuryAddress) {",
        "if (false && proof.fee_to_address !== relayTreasuryAddress) {",
      ),
    observable:
      "a fee leg routed to a non-treasury address must be refused (400 TASK_P2P_FEE_ADDRESS_MISMATCH)",
  },
  {
    suite: "booted-trust-activation",
    guards: "settlement→trust — the anti-sybil self-dealing guard",
    target: TASKS,
    // Drop the self-delegation guard (the #377 self-dealing-half severing).
    mutate: (src) =>
      replaceOnce(
        src,
        "if (!isSelfDelegation && newlyArchived) {",
        "if (newlyArchived) {\n      void isSelfDelegation;",
      ),
    observable: "a self-delegated settlement must move NO trust (empty agent-trust records)",
  },
  {
    suite: "booted-pipeline-activation",
    guards: "whole pipeline — authz gates the composed cascade",
    target: TASKS,
    // Weaken the /result device-token audience check (the #378 reject-half
    // severing). Anchored on the "task:result" preamble so it hits the /result
    // block, not the sibling "task:query" verify.
    mutate: (src) =>
      replaceOnce(
        src,
        '          "task:result",\n          isTokenBlacklisted,\n          isAgentRevoked,\n        );\n        if (!verified) {',
        '          "task:result",\n          isTokenBlacklisted,\n          isAgentRevoked,\n        );\n        if (false && !verified) {',
      ),
    observable:
      "a wrong-audience token must be refused (403) and settle/trust nothing across the cascade",
  },
];

/**
 * Booted activation suites this gate deliberately does NOT probe, each with a
 * reason. `assertCoverage` requires every booted-*-activation suite to be in
 * PROBES or here — so a new suite added without a discrimination probe fails
 * this gate rather than silently escaping the net.
 */
const EXEMPT: Record<string, string> = {
  "booted-entry-activation":
    "its severing is the #359 config-shadow (requireDiscoverSignature), whose reintroduction is already probed at the needle layer by check-security-default-wiring in check-gates-effective; the booted rung is a bonus proof, not the only net.",
  "booted-authz-activation":
    "its severing lives in services/relay/src/middleware.ts (the market-candidates dualAuth carve-out), not tasks.ts; PR #372 proved discrimination in both directions. Candidate to add a probe when the carve-out next changes (the two-site fail-open desync recorded in the doctrine).",
};

function replaceOnce(src: string, needle: string, replacement: string): string {
  const idx = src.indexOf(needle);
  if (idx === -1) {
    throw new Error(
      `activation-effective: anchor not found in source — a probe's severing target moved:\n  ${needle.split("\n")[0]}\nUpdate the probe in scripts/check-activation-effective.ts to the current source shape.`,
    );
  }
  if (src.indexOf(needle, idx + needle.length) !== -1) {
    throw new Error(
      `activation-effective: anchor is not unique — refine the probe's needle:\n  ${needle.split("\n")[0]}`,
    );
  }
  return src.slice(0, idx) + replacement + src.slice(idx + needle.length);
}

function run(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function buildRelay(): { code: number; out: string } {
  return run("pnpm", ["--filter", "@motebit/relay", "build"]);
}

function runSuite(suite: string): { code: number; out: string } {
  return run("pnpm", ["--filter", "@motebit/relay", "test", suite]);
}

/** A new booted-*-activation suite must be probed or explicitly exempted. */
function assertCoverage(): void {
  const suites = readdirSync(TESTS_DIR)
    .filter((f) => /^booted-.*-activation\.test\.ts$/.test(f))
    .map((f) => f.replace(/\.test\.ts$/, ""));
  const probed = new Set(PROBES.map((p) => p.suite));
  const uncovered = suites.filter((s) => !probed.has(s) && !(s in EXEMPT));
  if (uncovered.length > 0) {
    failWithRepair({
      invariant:
        "every booted-*-activation suite must have a discrimination probe (or a documented exemption) so it cannot go vacuous unnoticed",
      canonical: "scripts/check-activation-effective.ts (PROBES / EXEMPT)",
      fix:
        `these booted activation suites have no discrimination probe:\n` +
        uncovered.map((s) => `    • ${s}`).join("\n") +
        `\nAdd a probe to PROBES (a buildable severing that reds the suite) or an entry to EXEMPT with the reason its discrimination is covered elsewhere.`,
    });
  }
}

function main(): void {
  // Refuse to run on a dirty tasks.ts — this gate mutates it in place, and a
  // pre-existing edit would be indistinguishable from a probe (or clobbered by
  // the revert). Same isolation discipline as check-gates-effective.
  const dirty = run("git", ["status", "--porcelain", "--", TASKS]).out.trim();
  if (dirty) {
    failWithRepair({
      invariant:
        "check-activation-effective mutates services/relay/src/tasks.ts in place and must run on a clean copy of it",
      canonical: TASKS,
      fix: `commit or stash your changes to ${TASKS} before running this gate (it reverts its own mutation, which would clobber yours).`,
    });
  }

  assertCoverage();

  process.stderr.write(
    "Activation-conformance effectiveness — reintroducing severings against the booted artifact\n",
  );

  // Clean baseline so the first suite runs against un-mutated dist.
  const base = buildRelay();
  if (base.code !== 0) {
    process.stderr.write(base.out);
    throw new Error("baseline relay build failed — cannot probe");
  }

  interface Result {
    suite: string;
    guards: string;
    discriminated: boolean;
    buildBroke: boolean;
    observable: string;
  }
  const results: Result[] = [];
  const originals = new Map<string, string>();

  for (const probe of PROBES) {
    process.stderr.write(`\n▸ ${probe.suite} — reintroduce: ${probe.guards}\n`);
    const abs = resolve(ROOT, probe.target);
    const original = originals.get(probe.target) ?? readFileSync(abs, "utf-8");
    originals.set(probe.target, original);
    let discriminated = false;
    let buildBroke = false;
    try {
      writeFileSync(abs, probe.mutate(original));
      const build = buildRelay();
      if (build.code !== 0) {
        buildBroke = true;
        process.stderr.write("  ✗ perturbation broke the build (probe-authoring error)\n");
      } else {
        const suite = runSuite(probe.suite);
        // The suite is EXPECTED to fail — a non-zero exit means the severing
        // was caught (the suite discriminates). Exit 0 = vacuous.
        discriminated = suite.code !== 0;
        process.stderr.write(
          discriminated
            ? "  ✓ suite red under severing (discriminates)\n"
            : "  ✗ suite GREEN under severing (VACUOUS)\n",
        );
      }
    } finally {
      writeFileSync(abs, original);
    }
    results.push({
      suite: probe.suite,
      guards: probe.guards,
      discriminated,
      buildBroke,
      observable: probe.observable,
    });
  }

  // Restore clean dist so the tree is left as found.
  const restore = buildRelay();
  if (restore.code !== 0) {
    process.stderr.write(restore.out);
    throw new Error(
      "final clean rebuild failed — dist may be left mutated; run `pnpm --filter @motebit/relay build`",
    );
  }

  const unbuildable = results.filter((r) => r.buildBroke);
  if (unbuildable.length > 0) {
    failWithRepair({
      invariant:
        "each activation-effective probe's severing must build cleanly, so its suite reds on the guarantee assertion (not on a broken build)",
      canonical: "scripts/check-activation-effective.ts (PROBES)",
      fix:
        `these probes' mutations no longer build:\n` +
        unbuildable.map((r) => `    • ${r.suite}`).join("\n") +
        `\nThe source shape likely moved. Update the probe's mutate() to a buildable severing of the same guarantee.`,
    });
  }

  const vacuous = results.filter((r) => !r.discriminated);
  if (vacuous.length > 0) {
    failWithRepair({
      invariant:
        "every booted activation suite must RED when its guarantee is severed in the deployed artifact — a suite that stays green is vacuous and no longer guards composition-preserves-enforcement",
      canonical:
        "docs/doctrine/composition-preserves-enforcement.md + the suite under services/relay/src/__tests__/",
      fix:
        `these booted suites stayed GREEN while their guarantee was severed:\n` +
        vacuous
          .map((r) => `    • ${r.suite} — ${r.guards}\n        assert: ${r.observable}`)
          .join("\n") +
        `\nThe suite no longer discriminates. Restore an assertion that depends on the severed observable (see the suite's header for the original severing run).`,
    });
  }

  process.stderr.write(
    `\n✓ all ${results.length} booted activation suites discriminate their severing\n`,
  );
}

main();

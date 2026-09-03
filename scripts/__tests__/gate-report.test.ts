/**
 * gate-report — the repair-instruction contract.
 *
 * Locks the floor `check-gates-effective` enforces on every gate's failure
 * output: a canonical-source pointer + an actionable directive. The cases below
 * are real shapes seen in gate output (BARE = pre-contract laggards; GOOD =
 * the house standard), so a regression in either matcher half is caught here
 * before the slow probe run.
 */
import { describe, it, expect } from "vitest";

import {
  hasApertureDisclosure,
  hasRepairInstruction,
  failWithRepair,
  formatRepair,
} from "../lib/gate-report.ts";

describe("hasRepairInstruction — rejects bare output", () => {
  const bare: Array<[string, string]> = [
    ["pure count", "12 problems detected.\n"],
    ["count + raw strings, no fix", "\n  3 violation(s) found:\n  ERROR something is wrong\n"],
    ["disagreement flags, no source/fix", "verifier=true crypto=false sec=true python=null\n"],
    ["empty", ""],
    ["version is not a path", "bumped to v1.0 today\n"],
  ];
  for (const [name, output] of bare) {
    it(`rejects: ${name}`, () => {
      expect(hasRepairInstruction(output).ok).toBe(false);
    });
  }
});

describe("hasRepairInstruction — accepts genuine repair instructions", () => {
  const good: Array<[string, string]> = [
    [
      "pnpm command + @motebit symbol",
      "Add the export: run `pnpm --filter @motebit/wire-schemas build-schemas`.",
    ],
    [
      "Fix: label + import",
      "Fix: import propagateTrust from @motebit/market and route through it.",
    ],
    [
      "nested-path file + snippet",
      'in services/relay/src/state-export.ts import { getStoredReceiptJson } from "./receipts-store.js";',
    ],
    [
      "top-level file + Fix verb",
      "README.md:42 claims 50 packages; actual is 52. Fix the doc claim.",
    ],
    [
      "CLAUDE.md + add",
      "CLAUDE.md is missing the index line; add it under 'Per-directory doctrine'.",
    ],
    [
      "dir path (no ext) + document",
      "services/relay/src reads FOO but .env.example doesn't — document the var",
    ],
    [
      "html file + mirror",
      "apps/web/x.html input missing attrs — mirror the `#chat-input` element",
    ],
    [
      "change directive + two paths",
      "architecture.mdx:50 disagrees with check-deps.ts — change the others in the same PR",
    ],
  ];
  for (const [name, output] of good) {
    it(`accepts: ${name}`, () => {
      expect(hasRepairInstruction(output).ok).toBe(true);
    });
  }

  it("strips ANSI color before matching", () => {
    const colored = "[31mFix: import X from @motebit/y[0m";
    expect(hasRepairInstruction(colored).ok).toBe(true);
  });
});

describe("failWithRepair / formatRepair — emit contract-satisfying output", () => {
  it("formatRepair output passes its own contract", () => {
    const block = formatRepair({
      invariant: "thing drifted",
      canonical: "packages/protocol/src/index.ts",
      fix: "export the FooSchema type",
      sites: ["packages/x/src/y.ts:10"],
      doctrine: "docs/doctrine/gate-repair-instructions.md",
    });
    expect(hasRepairInstruction(block).ok).toBe(true);
    expect(block).toContain("Canonical source:");
    expect(block).toContain("Fix:");
  });

  it("failWithRepair is a never-returning exit", () => {
    // Type-level guarantee — the signature is `never`; we don't invoke it here
    // (it calls process.exit). Presence + shape is asserted via formatRepair above.
    expect(typeof failWithRepair).toBe("function");
  });
});

describe("hasApertureDisclosure — what a PASSING scanning gate owes its reader", () => {
  // The inverse surface to the repair contract. A green gate's claim is only as
  // wide as the set it examined, and aperture drift is invisible by
  // construction: a narrow gate never goes red, so nothing prompts a check.
  // check-affordance-routing scanned 57 of 322 app files while printing
  // "9 apps clean" (#545).

  it.each([
    "Affordance routing check passed — 322 file(s) scanned across 9 apps",
    "Wire-schema usage check passed — 14 required pair(s) validated, 0 waived",
    "✓ 17 `/api/v1/admin/*` route(s) covered by 15 bearerAuth pattern(s)",
    "check-spec-permissive-boundary: OK (943 permissive-floor exports, 10 waivers)",
    "✓ check-cli-surface: 36 subcommand(s), 63 flag(s), 4 exit code(s)",
    "✓ check-docs-cli-claims: 108 doc(s) scanned",
  ])("accepts a stated count: %j", (output) => {
    expect(hasApertureDisclosure(output).ok).toBe(true);
  });

  it("accepts ZERO — an honest and alarming statement", () => {
    // What the contract forbids is silence, not emptiness. "0 files scanned" is
    // exactly the disclosure that would have surfaced #545 years earlier.
    expect(hasApertureDisclosure("check passed — 0 file(s) scanned").ok).toBe(true);
  });

  it.each([
    "✓ check-solana-treasury-reconciliation",
    "✓ check-liquescent-ontology — no glass-as-ontology drift found",
    "All architectural checks passed.",
    "Deploy parity check passed — fly.toml ↔ deploy workflow all aligned",
  ])("rejects silence about scope: %j", (output) => {
    expect(hasApertureDisclosure(output).ok).toBe(false);
  });

  it("does NOT count a duration as an aperture", () => {
    // Nearly every gate prints a timing, and "738ms" is a number beside a word
    // ending in `s`. Matching it would make the contract vacuous by passing any
    // gate that reports how long it took — the exact false-green this exists to
    // prevent, reintroduced through the back door.
    expect(hasApertureDisclosure("✓ motebit exit 0 738ms").ok).toBe(false);
    expect(hasApertureDisclosure("done in 1200ms").ok).toBe(false);
    expect(hasApertureDisclosure("completed in 45 seconds").ok).toBe(false);
  });

  it("explains what is missing, so the fix is self-serviceable", () => {
    const r = hasApertureDisclosure("check passed");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("examined nothing");
    expect(r.reason).toMatch(/scanned|checked/);
  });
});

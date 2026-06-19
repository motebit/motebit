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

import { hasRepairInstruction, failWithRepair, formatRepair } from "../lib/gate-report.ts";

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

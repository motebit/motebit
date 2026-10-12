/**
 * check-codeowners-authority — the CODEOWNERS matcher (GitHub semantics), the
 * derivations from the existing authority gates, and the verdict. Tamper
 * cases run against the committed CODEOWNERS text in memory; nothing on disk
 * is mutated.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  deriveAuthorityWriterFiles,
  deriveMoneyAuthorityFiles,
  deriveRequirements,
  evaluate,
  type Requirement,
} from "../check-codeowners-authority.js";
import { isCatchAll, ownersOf, parseCodeowners, patternToRegex } from "../lib/codeowners.js";
import { hasApertureDisclosure } from "../lib/gate-report.js";

const ROOT = resolve(__dirname, "..", "..");
const COMMITTED = readFileSync(resolve(ROOT, ".github/CODEOWNERS"), "utf-8");

const req = (path: string): Requirement => ({ path, source: "test" });

describe("patternToRegex — GitHub CODEOWNERS matching", () => {
  const m = (pattern: string, path: string): boolean => patternToRegex(pattern).test(path);

  it("anchors a leading-slash directory pattern to the root and covers everything under it", () => {
    expect(m("/packages/a/src/", "packages/a/src/x.ts")).toBe(true);
    expect(m("/packages/a/src/", "packages/a/src/deep/y.ts")).toBe(true);
    expect(m("/packages/a/src/", "vendor/packages/a/src/x.ts")).toBe(false);
    expect(m("/packages/a/src/", "packages/a/srcx/x.ts")).toBe(false);
  });

  it("matches an anchored file exactly", () => {
    expect(m("/CLAUDE.md", "CLAUDE.md")).toBe(true);
    expect(m("/CLAUDE.md", "packages/x/CLAUDE.md")).toBe(false);
  });

  it("matches an unanchored name at any depth", () => {
    expect(m("*.test.ts", "packages/a/src/x.test.ts")).toBe(true);
    expect(m("**/__tests__/", "packages/a/src/__tests__/x.ts")).toBe(true);
    expect(m("**/__tests__/", "packages/a/src/x.ts")).toBe(false);
  });

  it("keeps `*` within one segment and does not descend through a trailing single `*`", () => {
    expect(m("/scripts/check-money-*.ts", "scripts/check-money-authority.ts")).toBe(true);
    expect(m("/scripts/check-money-*.ts", "scripts/lib/check-money-x.ts")).toBe(false);
    expect(m("/docs/*", "docs/a.md")).toBe(true);
    expect(m("/docs/*", "docs/sub/b.md")).toBe(false);
  });
});

describe("ownersOf — last match wins", () => {
  const { rules } = parseCodeowners(
    ["/packages/a/src/ @owner", "**/__tests__/", "/packages/a/src/__tests__/keep.ts @other"].join(
      "\n",
    ),
  );

  it("an owned directory owns its files", () => {
    expect(ownersOf(rules, "packages/a/src/x.ts")).toEqual(["@owner"]);
  });
  it("a later owner-less rule un-owns", () => {
    expect(ownersOf(rules, "packages/a/src/__tests__/x.test.ts")).toEqual([]);
  });
  it("a still-later rule overrides again", () => {
    expect(ownersOf(rules, "packages/a/src/__tests__/keep.ts")).toEqual(["@other"]);
  });
  it("an unmatched path has no owner", () => {
    expect(ownersOf(rules, "README.md")).toEqual([]);
  });
});

describe("parseCodeowners", () => {
  it("ignores comments and refuses syntax CODEOWNERS does not support", () => {
    const { rules, errors } = parseCodeowners("# c\n\n/a/ @o\n!/b/ @o\n/c[ab]/ @o\n");
    expect(rules.map((r) => r.pattern)).toEqual(["/a/"]);
    expect(errors).toHaveLength(2);
  });
  it("recognises catch-alls", () => {
    for (const p of ["*", "**", "/**", "**/*"]) {
      expect(isCatchAll(parseCodeowners(`${p} @o`).rules[0]!)).toBe(true);
    }
    for (const p of ["/packages/", "*.ts", "/.github/"]) {
      expect(isCatchAll(parseCodeowners(`${p} @o`).rules[0]!)).toBe(false);
    }
  });
});

describe("evaluate", () => {
  it("passes a covered requirement", () => {
    const { rules } = parseCodeowners("/packages/a/src/ @hakimlabs\n");
    expect(evaluate(rules, [req("packages/a/src/x.ts")]).violations).toEqual([]);
  });
  it("flags an uncovered requirement", () => {
    const { rules } = parseCodeowners("/packages/a/src/ @hakimlabs\n");
    expect(evaluate(rules, [req("packages/b/src/x.ts")]).violations).toHaveLength(1);
  });
  it("flags a requirement a later rule un-owns or hands to someone else", () => {
    const { rules } = parseCodeowners("/packages/a/src/ @hakimlabs\n/packages/a/src/x.ts @else\n");
    expect(evaluate(rules, [req("packages/a/src/x.ts")]).violations[0]).toMatch(/@else/);
  });
  it("refuses a catch-all even when every requirement is covered", () => {
    const { rules } = parseCodeowners("* @hakimlabs\n");
    const v = evaluate(rules, [req("packages/a/src/x.ts")]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/catch-all/);
  });
});

describe("derivations read the existing gates, not a list of their own", () => {
  it("writers gate: files writing AUTHORITY_TABLES only", () => {
    const src = [
      'const R = "services/relay/src/";',
      'const AUTHORITY_TABLES = ["agent_registry"] as const;',
      "const WRITERS = [",
      '  { file: R + "a.ts", verb: "INSERT", table: "agent_registry", count: 1, principal: "x" },',
      '  { file: R + "b.ts", verb: "INSERT", table: "events", count: 1, principal: "x" },',
      "];",
    ].join("\n");
    expect(deriveAuthorityWriterFiles(src)).toEqual(["services/relay/src/a.ts"]);
  });
  it("writers gate: fails closed when the shape it reads is gone", () => {
    expect(() => deriveAuthorityWriterFiles("const X = 1;")).toThrow(/AUTHORITY_TABLES/);
  });
  it("money gate: the workspace source paths it reads", () => {
    const src =
      'readFile("packages/policy/src/policy-gate.ts"); const P = "packages/runtime/src/g.ts"; "docs/x.md";';
    expect(deriveMoneyAuthorityFiles(src)).toEqual([
      "packages/policy/src/policy-gate.ts",
      "packages/runtime/src/g.ts",
    ]);
    expect(() => deriveMoneyAuthorityFiles("const x = 1;")).toThrow();
  });
  it("the live derivation covers all three sources", () => {
    const paths = deriveRequirements().map((r) => r.path);
    expect(paths).toContain("packages/virtual-accounts/package.json");
    expect(paths).toContain("services/relay/src/identity-keys.ts");
    expect(paths).toContain("packages/policy/src/policy-gate.ts");
    expect(paths.some((p) => p.includes("__tests__"))).toBe(false);
  });
});

describe("committed CODEOWNERS", () => {
  const reqs = deriveRequirements();

  it("is green", () => {
    expect(evaluate(parseCodeowners(COMMITTED).rules, reqs).violations).toEqual([]);
  });

  it("tamper: removing one registry package line turns the gate red", () => {
    const tampered = COMMITTED.split("\n")
      .filter((l) => !l.startsWith("/packages/virtual-accounts/src/ "))
      .join("\n");
    expect(tampered).not.toBe(COMMITTED);
    const v = evaluate(parseCodeowners(tampered).rules, reqs).violations;
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((s) => s.startsWith("packages/virtual-accounts/src/"))).toBe(true);
  });

  it("tamper: adding a catch-all turns the gate red", () => {
    const v = evaluate(parseCodeowners(`${COMMITTED}\n* @hakimlabs\n`).rules, reqs).violations;
    expect(v.some((s) => /catch-all/.test(s))).toBe(true);
  });

  it("leaves tests unowned", () => {
    const { rules } = parseCodeowners(COMMITTED);
    expect(ownersOf(rules, "packages/virtual-accounts/src/__tests__/x.test.ts")).toEqual([]);
    expect(ownersOf(rules, "README.md")).toEqual([]);
  });

  it("the live run passes and states its aperture", () => {
    const r = spawnSync(
      resolve(ROOT, "node_modules/.bin/tsx"),
      [resolve(ROOT, "scripts/check-codeowners-authority.ts")],
      { cwd: ROOT, encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    expect(hasApertureDisclosure(r.stdout).ok).toBe(true);
  });
});

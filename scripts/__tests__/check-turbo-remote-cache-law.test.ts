/**
 * check-turbo-remote-cache — THE LAW (#997 round 2). Deny-by-default over a
 * copy of this repository: every row of the mutation table (the shapes the
 * round-2 cold review reproduced passing the gate, and their siblings) must
 * turn the gate RED, and the unmutated copy must stay green. Then the
 * gate-mutation table: switching OFF any one rule of the law must let at
 * least one row through — no rule is dead weight, and no row is caught only
 * by accident.
 */
import { rmSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runTurboRemoteCacheGate } from "../check-turbo-remote-cache.js";
import { judgeSecretExpression, LAW_RULES, type LawRule } from "../lib/turbo-remote-cache.js";
import { copyRepo, MUTATIONS } from "./turbo-remote-cache-mutations.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = (): string => {
  const d = copyRepo();
  dirs.push(d);
  return d;
};

describe("the law, on a copy of this repository", () => {
  it("control: the unmutated copy is green", () => {
    expect(runTurboRemoteCacheGate(fresh()).violations).toEqual([]);
  });

  it.each(MUTATIONS.map((m) => [m.id, m] as const))("%s turns the gate RED", (_id, m) => {
    const d = fresh();
    m.apply(d);
    expect(runTurboRemoteCacheGate(d).violations, m.shape).not.toEqual([]);
  });
});

describe("gate mutation: every rule of the law is load-bearing", () => {
  // Apply every row once; re-run the gate per disabled rule on the same copies.
  const applied = MUTATIONS.map((m) => {
    const d = fresh();
    m.apply(d);
    return { m, d };
  });
  /** The rows each rule, when switched off, lets through (should be non-empty). */
  const memo = new Map<LawRule, string[]>();
  const escapes = (rule: LawRule): string[] => {
    const hit = memo.get(rule);
    if (hit) return hit;
    const out = applied
      .filter(
        ({ d }) =>
          runTurboRemoteCacheGate(d, { disabled: new Set([rule]) }).violations.length === 0,
      )
      .map(({ m }) => m.id);
    memo.set(rule, out);
    return out;
  };

  it.each(LAW_RULES.map((r) => [r]))(
    "without `%s` some row goes green",
    (rule) => {
      expect(escapes(rule)).not.toEqual([]);
    },
    60_000,
  );

  it("the table the report quotes", () => {
    const table = Object.fromEntries(LAW_RULES.map((r) => [r, escapes(r)]));
    expect(table).toEqual({
      "secret-shape": [
        "C2a secrets[format()]",
        "C2b toJSON(secrets)",
        "C2c secrets: inherit",
        "C2d secrets: inherit (clean callee)",
        "C2e format(secrets.X)",
      ],
      "secret-allowlist": [
        "A2 local action reads a secret",
        "S1 unknown secret name",
        "S2 known secret, wrong job",
        "S3 secret in if:",
      ],
      "writer-secret-placement": [
        "P1 writer env job-level",
        "P2 writer secret on non-turbo step",
        "P3 writer secret in run text",
      ],
      "environment-allowlist": [
        "C1a env-format-expr",
        "C1b env-concat-expr",
        "E1 environment from vars",
        "E2 environment object from vars",
        "E3 literal env, wrong job",
      ],
      "cache-state": [
        "C3a cache .turbo (PR)",
        "C3b cache turbo (release)",
        "C3c cache **/dist",
        "C3d cache path expr",
        "A1 local action caches .turbo",
      ],
      "tracked-turbo-state": ["C4 committed .turbo/config.json"],
    });
  }, 60_000);
});

describe("secret expression shapes", () => {
  it("admits only a bare literal secrets.NAME", () => {
    expect(judgeSecretExpression(" secrets.FLY_API_TOKEN ")).toEqual({
      names: ["FLY_API_TOKEN"],
      bad: null,
    });
    // Property access is case-insensitive in GitHub expressions.
    expect(judgeSecretExpression(" SECRETS.turbo_writer_token ").names).toEqual([
      "TURBO_WRITER_TOKEN",
    ]);
    expect(
      judgeSecretExpression(" steps.app-token.outputs.token || secrets.GITHUB_TOKEN ").bad,
    ).toBeNull();
  });
  it.each([
    " toJSON(secrets) ",
    " secrets['TURBO_WRITER_TOKEN'] ",
    " secrets[format('TURBO_{0}','TOKEN')] ",
    " format('{0}', secrets.X) ",
    " join(secrets.*, ',') ",
    " secrets ",
    " secrets.X.y ",
    " fromJSON('[1]')[0] && secrets.X ",
  ])("refuses %s", (expr) => {
    expect(judgeSecretExpression(expr).bad).not.toBeNull();
  });
});

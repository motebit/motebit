/**
 * check-turbo-remote-cache — THE LAW (#997 round 2). Deny-by-default over a
 * copy of this repository: every row of the mutation table (the shapes the
 * round-2 cold review reproduced passing the gate, and their siblings) must
 * turn the gate RED, and the unmutated copy must stay green. Then the
 * gate-mutation table: switching OFF any one rule of the law must let at
 * least one row through — no rule is dead weight, and no row is caught only
 * by accident.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runTurboRemoteCacheGate } from "../check-turbo-remote-cache.js";
import {
  judgeSecretExpression,
  LAW_RULES,
  scanExpressions,
  type LawRule,
  WRITER_ENVIRONMENT,
  WRITER_ENVIRONMENT_EXPR,
} from "../lib/turbo-remote-cache.js";
import { copyRepo, MUTATIONS, REPO_ROOT } from "./turbo-remote-cache-mutations.js";

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

  // Round 5: a row that names its refusal must be refused FOR THAT reason
  // (so deleting the one push site that emits it turns this test red, even
  // when the row also cascades into other violations).
  it.each(MUTATIONS.filter((m) => m.expect != null).map((m) => [m.id, m] as const))(
    "%s is refused for its named reason",
    (_id, m) => {
      const d = fresh();
      m.apply(d);
      const v = runTurboRemoteCacheGate(d).violations;
      for (const re of m.expect!)
        expect(
          v.some((x) => re.test(x)),
          `${m.shape}: ${re}`,
        ).toBe(true);
    },
  );

  // Round 4: each R4 row is refused by ONE sub-rule alone, so deleting that
  // sub-rule turns the row's "turns the gate RED" test red. Exactly one
  // violation keeps a second rule from silently covering for a deleted one.
  it.each(MUTATIONS.filter((m) => m.id.startsWith("R4-")).map((m) => [m.id, m] as const))(
    "%s is refused by exactly one violation",
    (_id, m) => {
      const d = fresh();
      m.apply(d);
      expect(runTurboRemoteCacheGate(d).violations, m.shape).toHaveLength(1);
    },
  );
});

describe("gate mutation: every rule of the law is load-bearing", () => {
  // Apply every row once; re-run the gate per disabled rule on the same copies.
  const applied = MUTATIONS.map((m) => {
    const d = fresh();
    m.apply(d);
    return { m, d };
  });
  /**
   * The rows each rule, when switched off, lets through (should be non-empty).
   * Round 5: the raw-text census is a SECOND, parse-independent layer that
   * re-catches most parser-rule rows, so a parser rule is measured with the
   * census off too (is it load-bearing in the parser layer?), and the census
   * alone (is it load-bearing at all — the rows the parser cannot see?).
   */
  const memo = new Map<LawRule, string[]>();
  const escapes = (rule: LawRule): string[] => {
    const hit = memo.get(rule);
    if (hit) return hit;
    const disabled = new Set<LawRule>(rule === "raw-census" ? [rule] : [rule, "raw-census"]);
    const censusOnly = rule === "raw-census" ? [] : escapes("raw-census");
    const out = applied
      .filter(({ d }) => runTurboRemoteCacheGate(d, { disabled }).violations.length === 0)
      .map(({ m }) => m.id)
      .filter((id) => !censusOnly.includes(id));
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

  it("the census alone (every parser rule off) still refuses both C1 probes", () => {
    const parserOff = new Set<LawRule>(LAW_RULES.filter((r) => r !== "raw-census"));
    for (const id of [
      "R5-C1a '}}' literal hides the writer key",
      "R5-C1b '}}' literal hides toJSON(secrets)",
    ]) {
      const d = applied.find((a) => a.m.id === id)!.d;
      expect(runTurboRemoteCacheGate(d, { disabled: parserOff }).violations, id).not.toEqual([]);
    }
  }, 60_000);

  it("R3-C1 and R3-C2 are refused by more than one rule (defence in depth)", () => {
    for (const id of ["R3-C1 GITHUB_ENV leak in Build", "R3-C2 outputs chain to e2e"]) {
      const d = applied.find((a) => a.m.id === id)!.d;
      const rules = LAW_RULES.filter(
        (r) =>
          runTurboRemoteCacheGate(d, { disabled: new Set(LAW_RULES.filter((x) => x !== r)) })
            .violations.length > 0,
      );
      expect(rules.length, id).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);

  it("the table the report quotes", () => {
    const table = Object.fromEntries(LAW_RULES.map((r) => [r, escapes(r)]));
    expect(table).toEqual({
      "secret-shape": [
        "C2a secrets[format()]",
        "C2b toJSON(secrets)",
        "C2c secrets: inherit",
        "C2d secrets: inherit (clean callee)",
        "C2e format(secrets.X)",
        // #997 round 5: with the runner's boundary scan the `'}}'` literal no
        // longer hides `toJSON(secrets)`; an unterminated `${{` fails closed.
        "R5-C1b '}}' literal hides toJSON(secrets)",
        "R5-C1c unterminated expression",
      ],
      "secret-allowlist": [
        "A2 local action reads a secret",
        "S1 unknown secret name",
        "S2 known secret, wrong job",
        "S3 secret in if:",
      ],
      // P2 is now ALSO caught by writer-exact-run (a credential-env step
      // must run an exact turbo command), so it is no longer placement-only.
      "writer-secret-placement": ["P1 writer env job-level", "P3 writer secret in run text"],
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
        "R4-L1 download-artifact run-id (PR)",
        "R4-L2 cache apps/web/dist (PR)",
        "R4-L3 cache ~/work (PR)",
      ],
      "tracked-turbo-state": ["C4 committed .turbo/config.json", "R5-F6 not a git tree"],
      // #997 round 3. R3-C1 (Build >> $GITHUB_ENV) and R3-C2 (outputs chain)
      // are caught by two or three of these at once, so neither is listed.
      "writer-exact-run": [
        "R3-C3 printenv into uploaded artifact",
        "R3-P2 the word turbo",
        "R3-X1 writer step working-directory",
        "R3-X2 writer step extra env",
        "R4-W1 writer job env NODE_OPTIONS",
        "R4-W2 writer job defaults",
      ],
      "writer-job-outputs": ["R3-C2b job outputs"],
      "writer-env-files": [
        "R3-C1b GITHUB_ENV write, no writer env",
        "R3-C1c GITHUB_PATH write",
        "R4-W3 GITHUB_STATE write",
        "R4-W4 legacy ::set-env",
        "R4-W5 legacy ::add-path",
      ],
      "publish-artifact-fetch": [
        "R3-P3 gh run download (publish)",
        "R3-P3b gh api artifacts (release)",
        "R3-P3c curl artifacts URL (release)",
        "R3-P3d download-artifact (publish)",
      ],
      // Round 5: shapes only the raw-text census sees (the parser reads them
      // as comments; a YAML 1.1 scanner would not).
      "raw-census": [
        "R5-K1 toJSON(secrets) after U+2028 in a comment",
        "R5-K2 writer secret in a comment",
        "R5-K3 environment from vars after U+2028",
      ],
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

/**
 * WRITER_ENVIRONMENT_EXPR under GitHub expression semantics: `==` compares
 * strings case-insensitively, `&&` / `||` return an OPERAND (not a boolean),
 * and `''` is falsy. Enough of the grammar to evaluate the one expression —
 * identifiers (context lookups), string literals, `==`, `&&`, `||`, parens.
 */
function evalGithubExpr(src: string, ctx: Record<string, string>): unknown {
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(src.trim());
  if (!m) throw new Error(`not an expression: ${src}`);
  const toks = m[1]!.match(/'(?:[^']|'')*'|==|&&|\|\||[()]|[A-Za-z_][\w.-]*|\S/g) ?? [];
  let i = 0;
  const falsy = (v: unknown): boolean => v === false || v === "" || v === 0 || v == null;
  const primary = (): unknown => {
    const t = toks[i++];
    if (t === "(") {
      const v = or();
      if (toks[i++] !== ")") throw new Error("expected )");
      return v;
    }
    if (t?.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t != null && /^[A-Za-z_]/.test(t)) {
      if (!(t in ctx)) throw new Error(`unknown context ${t}`);
      return ctx[t];
    }
    throw new Error(`unexpected token ${t}`);
  };
  const eq = (): unknown => {
    let l = primary();
    while (toks[i] === "==") {
      i++;
      const r = primary();
      l = String(l).toLowerCase() === String(r).toLowerCase();
    }
    return l;
  };
  const and = (): unknown => {
    let l = eq();
    while (toks[i] === "&&") {
      i++;
      const r = eq();
      l = falsy(l) ? l : r;
    }
    return l;
  };
  const or = (): unknown => {
    let l = and();
    while (toks[i] === "||") {
      i++;
      const r = and();
      l = falsy(l) ? r : l;
    }
    return l;
  };
  const v = or();
  if (i !== toks.length) throw new Error(`trailing tokens in ${src}`);
  return v;
}

describe("WRITER_ENVIRONMENT_EXPR (GitHub expression semantics)", () => {
  const at = (event_name: string, ref: string): unknown =>
    evalGithubExpr(WRITER_ENVIRONMENT_EXPR, {
      "github.event_name": event_name,
      "github.ref": ref,
    });

  it("resolves to the writer environment only on a push to main", () => {
    expect(at("push", "refs/heads/main")).toBe(WRITER_ENVIRONMENT);
    expect(WRITER_ENVIRONMENT).toBe("turbo-cache-writer");
  });

  it.each([
    ["pull_request", "refs/pull/1/merge"],
    ["pull_request", "refs/heads/main"],
    ["pull_request_target", "refs/heads/main"],
    ["merge_group", "refs/heads/gh-readonly-queue/main/pr-1-abc"],
    ["push", "refs/heads/feature"],
    ["push", "refs/heads/main-x"],
    ["push", "refs/tags/v1.0.0"],
    ["workflow_dispatch", "refs/heads/main"],
    ["schedule", "refs/heads/main"],
  ])("resolves to '' (no environment) for %s on %s", (event, ref) => {
    expect(at(event, ref)).toBe("");
  });
});

/**
 * #997 round 5 — the expression-boundary scan must equal the runner's
 * (TemplateReader.ParseScalar): a single quote toggles "in a string literal"
 * (`''` toggles twice), and only a `}}` OUTSIDE a literal closes. The
 * expected bodies are what GitHub hands its expression parser.
 */
describe("scanExpressions (GitHub's TemplateReader boundaries)", () => {
  it.each<[string, string[], boolean]>([
    ["no expression", [], false],
    ["${{ a }}", [" a "], false],
    ["${{}}", [""], false],
    ["${{ '}}' != '' && secrets.X }}", [" '}}' != '' && secrets.X "], false],
    ["echo '${{ '}}' && toJSON(secrets) }}'", [" '}}' && toJSON(secrets) "], false],
    ["${{ 'it''s }} here' }}", [" 'it''s }} here' "], false],
    ["${{ '''}}''' }}", [" '''}}''' "], false],
    ["${{ a }} and ${{ b }}", [" a ", " b "], false],
    ["${{ a }}${{ b }}", [" a ", " b "], false],
    ["x ${{ 'a' }} y ${{ '}}' }} z", [" 'a' ", " '}}' "], false],
    ["${{ a }}}", [" a "], false],
    ["${{ a }}}}", [" a "], false],
    ["${{ '${{' }} ${{ b }}", [" '${{' ", " b "], false],
    ["${{ a }", [" a }"], true],
    ["${{ 'unterminated }}", [" 'unterminated }}"], true],
    ["${{ a }} ${{ 'b }}", [" a ", " 'b }}"], true],
    ["${{ secrets.X }}: key", [" secrets.X "], false],
  ])("%j", (text, exprs, unterminated) => {
    expect(scanExpressions(text)).toEqual({ exprs, unterminated });
  });

  it("the round-4 shapes now reach the judge whole", () => {
    expect(
      judgeSecretExpression(scanExpressions("${{ '}}' && toJSON(secrets) }}").exprs[0]!).bad,
    ).not.toBeNull();
    expect(
      judgeSecretExpression(
        scanExpressions("${{ '}}' != '' && secrets.TURBO_WRITER_SIGNATURE_KEY }}").exprs[0]!,
      ).names,
    ).toEqual(["TURBO_WRITER_SIGNATURE_KEY"]);
  });
});

describe("the CLI exits red on a root script that writes the remote (C2)", () => {
  it("package.json scripts.build: turbo run build --cache=local:rw,remote:rw", () => {
    const d = fresh();
    MUTATIONS.find((m) => m.id === "R5-F1 root build script writes remote")!.apply(d);
    const out = spawnSync("npx", ["tsx", "scripts/check-turbo-remote-cache.ts", "--root", d], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/package\.json scripts\.build: turbo invoked with --cache=/);
  }, 60_000);
});

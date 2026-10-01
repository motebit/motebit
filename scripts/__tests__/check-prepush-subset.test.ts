/**
 * check-prepush-subset — deny by default. The real hook / ci.yml / package
 * scripts are GREEN; every MUTANT in the permanent table (the ten shapes the
 * first, regex version let through, plus siblings) is RED; every CONTROL
 * (an edit the invariant is not about) stays GREEN. See prepush-subset-mutants.ts.
 */
import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, readInputs, canonHash } from "../check-prepush-subset.js";
import { parseSh, walk } from "../lib/posix-sh.js";
import { MUTANTS, CONTROLS } from "./prepush-subset-mutants.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = readInputs(ROOT);

describe("check-prepush-subset over the real hook and ci.yml", () => {
  it("is green, and maps every phase to its CI counterpart", () => {
    const e = evaluate(REAL);
    expect(e.violations).toEqual([]);
    expect(e.keys).toEqual(
      expect.arrayContaining(["build", "check", "typecheck", "lint", "test", "format", "audit"]),
    );
    expect(e.phases).toBeGreaterThanOrEqual(10);
  });
});

describe("mutation table — every mutant RED", () => {
  for (const mu of MUTANTS) {
    it(`${mu.id}: ${mu.what}`, () => {
      const v = evaluate(mu.apply(REAL)).violations;
      expect(v.length, `mutant ${mu.id} survived`).toBeGreaterThan(0);
    });
  }
});

describe("controls — every control GREEN", () => {
  for (const c of CONTROLS) {
    it(`${c.id}: ${c.what}`, () => {
      expect(evaluate(c.apply(REAL)).violations).toEqual([]);
    });
  }
});

describe("the POSIX-sh reader", () => {
  const commands = (src: string) => {
    const out: string[] = [];
    walk(parseSh(src), {
      simple: (c, ctx) =>
        out.push(`${ctx.forked ? "F:" : ""}${c.words.map((w) => w.raw).join(" ")}`),
    });
    return out;
  };

  it("sees commands inside $( ), $(( $( ) )), ${ } and double quotes", () => {
    expect(commands('x="$(a 1 | b)"; echo $(( $(c) + 1 )) "${y:-$(d)}"')).toEqual([
      "",
      "F:a 1",
      "F:b",
      'echo $(( $(c) + 1 )) "${y:-$(d)}"',
      "F:c",
      "F:d",
    ]);
  });

  it("refuses what it cannot read (fail closed)", () => {
    expect(() => parseSh("echo `a`")).toThrow(/backtick/);
    expect(() => parseSh("cat <<EOF\nx\nEOF\n")).toThrow(/here-document/);
    expect(() => parseSh("echo 'open")).toThrow(/single quote/);
    expect(() => parseSh("if a; then b")).toThrow();
  });

  it("canonical function hashes ignore comments and layout, not tokens", () => {
    const fn = (body: string) => {
      let canon = "";
      walk(parseSh(body), { func: (f) => (canon = f.canon) });
      return canonHash(canon);
    };
    expect(fn("f() {\n  # c\n  a  b\n}\n")).toBe(fn("f() { a b; }"));
    expect(fn("f() { a b; }")).not.toBe(fn("f() { a c; }"));
  });
});

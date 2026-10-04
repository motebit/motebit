/**
 * tamper-runner — the shared parallel runner every TAMPER file delegates to.
 * This file: the verdicts and the EVIDENCE LAW (a RED is positive evidence,
 * never the absence of a pass). Isolation lives in
 * tamper-runner.isolation.test.ts, signals and stale copies in
 * tamper-runner.lifecycle.test.ts; the harness is tamper-runner.harness.ts.
 * tamper-runner.mutations.ts proves each of these tests bites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BREAK_SUB,
  BREAK_SUM,
  COMMENT_ONLY,
  FX,
  SUM_FILE,
  SYNTAX_ERROR,
  SUM_TEST,
  drive,
  setupFixture,
  snapshot,
  teardownFixture,
  verdicts,
} from "./tamper-runner.harness";
import type { Fx } from "./tamper-runner.harness";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let fx: Fx | undefined;
beforeEach(async () => {
  fx = await setupFixture();
});
afterEach(() => {
  teardownFixture(fx);
  fx = undefined;
});

/** Adds a test that fails: it did not exist, so it cannot have passed before the edit. */
const ADD_FAILING_TEST = {
  file: "packages/fx/sum.fx.mjs",
  from: 'describe("sum", () => {',
  to: 'describe("sum", () => {\n  it("fresh", () => {\n    throw new Error("a test the edit adds");\n  });',
};

const SUM_CHECK = { command: ["node", "sum.check.mjs"], redMarker: "SUM CHECK FAILED" };
/** Parses, but throws when sum() runs: a crash that is not a syntax error. */
const THROWS = {
  file: SUM_FILE,
  from: "return a + b;",
  to: 'throw new Error("fx crash");',
};

describe("tamper-runner verdicts", () => {
  it("a tamper the test catches goes RED; the run exits 0", () => {
    const before = snapshot(fx!);
    const d = drive(fx!, [{ name: "sum subtracts", ...SUM_TEST, edits: [BREAK_SUM] }], 1);
    expect(verdicts(d)).toEqual(["RED"]);
    expect(d.out).toMatch(/^RED \(ok\) +sum subtracts$/m);
    expect(d.out).toContain("1/1 tampers turned their test red");
    expect(d.code).toBe(0);
    expect(snapshot(fx!)).toBe(before);
  });

  it("a tamper the test does not catch reports GREEN and exits 1", () => {
    const d = drive(fx!, [{ name: "comment edited", ...SUM_TEST, edits: [COMMENT_ONLY] }], 1);
    expect(verdicts(d)).toEqual(["GREEN"]);
    expect(d.out).toMatch(/^GREEN +comment edited$/m);
    expect(d.out).toContain("0/1 tampers turned their test red");
    expect(d.code).toBe(1);
  });

  it("a missing anchor reports COULD NOT APPLY and exits 1", () => {
    const d = drive(
      fx!,
      [
        {
          name: "stale anchor",
          ...SUM_TEST,
          edits: [{ file: SUM_FILE, from: "a * b", to: "a - b" }],
        },
      ],
      1,
    );
    expect(verdicts(d)).toEqual(["COULD NOT APPLY"]);
    expect(d.out).toMatch(
      /^COULD NOT APPLY +stale anchor +\(packages\/fx\/sum\.mjs: text found 0×\)$/m,
    );
    expect(d.code).toBe(1);
  });

  it("an anchor found twice is COULD NOT APPLY too (never an ambiguous edit)", () => {
    const d = drive(
      fx!,
      [{ name: "ambiguous", ...SUM_TEST, edits: [{ file: SUM_FILE, from: "return", to: "x" }] }],
      1,
    );
    expect(verdicts(d)).toEqual(["COULD NOT APPLY"]);
    expect(d.code).toBe(1);
  });
});

describe("tamper-runner evidence", () => {
  it("C2: a misspelled test file aborts at the baseline (exit 2), never RED", () => {
    const d = drive(fx!, [{ name: "typo", pkg: FX, test: "sum.fxx.mjs", edits: [BREAK_SUM] }], 1);
    expect(d.out).toMatch(/^BASELINE NOT GREEN: fx sum\.fxx\.mjs/m);
    expect(verdicts(d)).not.toContain("RED");
    expect(d.code).toBe(2);
  });

  it("C2: a tamper that breaks collection (a syntax error) is INCONCLUSIVE, never RED", () => {
    const d = drive(fx!, [{ name: "syntax", ...SUM_TEST, edits: [SYNTAX_ERROR] }], 1);
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(/INCONCLUSIVE +syntax +\((suite-level error|edit does not type-check)/);
    expect(d.code).toBe(1);
  });

  it("C2: an unhandled error with every test passing is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [
        {
          name: "unhandled",
          ...SUM_TEST,
          edits: [
            {
              file: SUM_FILE,
              from: "  return a + b;",
              to: '  Promise.reject(new Error("fx unhandled"));\n  return a + b;',
            },
          ],
        },
      ],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(/INCONCLUSIVE +unhandled +\(unhandled error/);
    expect(d.code).toBe(1);
  });

  it("C2: a suite-level error (a failing afterAll) next to a failing test is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [
        {
          name: "teardown trips",
          ...SUM_TEST,
          edits: [{ file: SUM_FILE, from: "return a + b;", to: "return a + b + 1;" }],
        },
      ],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +teardown trips +\(suite-level error: .*teardown: sum\(0, 0\) = 1/,
    );
    expect(d.code).toBe(1);
  });

  it("a command entry goes RED only with its red marker", () => {
    const d = drive(fx!, [{ name: "cmd", ...SUM_CHECK, edits: [BREAK_SUM] }], 1);
    expect(verdicts(d)).toEqual(["RED"]);
    expect(d.code).toBe(0);
  });

  it("C2: a command that crashes (non-zero exit, no red marker) is INCONCLUSIVE, never RED", () => {
    const d = drive(fx!, [{ name: "cmd crash", ...SUM_CHECK, edits: [THROWS] }], 1);
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +cmd crash +\(exited 1, red marker "SUM CHECK FAILED" absent\)/,
    );
    expect(d.code).toBe(1);
  });

  it("C2: a command entry that declares no redMarker is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [{ name: "cmd unmarked", command: ["node", "sum.check.mjs"], edits: [BREAK_SUM] }],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(/INCONCLUSIVE +cmd unmarked +\(a command entry must declare redMarker/);
    expect(d.code).toBe(1);
  });

  it("C3: red naming only the describe block does not count a failing sibling", () => {
    const d = drive(
      fx!,
      [{ name: "describe only", ...SUM_TEST, red: "sum", edits: [BREAK_SUB] }],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toContain('no test has the exact full name "sum"');
    expect(d.code).toBe(1);
  });

  it("C3: red naming a bare title (no describe path) is not an exact name", () => {
    const d = drive(
      fx!,
      [{ name: "bare title", ...SUM_TEST, red: "subtracts two numbers", edits: [BREAK_SUB] }],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.code).toBe(1);
  });

  it("C3: red naming the exact full name of the failing test goes RED", () => {
    const d = drive(
      fx!,
      [{ name: "exact", ...SUM_TEST, red: "sum subtracts two numbers", edits: [BREAK_SUB] }],
      1,
    );
    expect(verdicts(d)).toEqual(["RED"]);
    expect(d.code).toBe(0);
  });

  it("C3: red naming a test that stays green is GREEN even when a sibling fails", () => {
    const d = drive(
      fx!,
      [{ name: "sibling red", ...SUM_TEST, red: "sum adds two numbers", edits: [BREAK_SUB] }],
      1,
    );
    expect(verdicts(d)).toEqual(["GREEN"]);
    expect(d.out).toContain(
      '"sum adds two numbers" passed; other tests failed: sum subtracts two numbers',
    );
    expect(d.code).toBe(1);
  });

  it("X4: red naming a test that did not pass before the edit (one the edit adds) is never RED", () => {
    const d = drive(
      fx!,
      [{ name: "new test", ...SUM_TEST, red: "sum fresh", edits: [ADD_FAILING_TEST] }],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toContain('("sum fresh" did not pass in the pre-run)');
    expect(d.code).toBe(1);
  });

  it("X5: without red, only a test that passed before the edit can bite (a new failing test cannot)", () => {
    const d = drive(fx!, [{ name: "new test", ...SUM_TEST, edits: [ADD_FAILING_TEST] }], 1);
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toContain("(no test that passed in the pre-run failed inside a test");
    expect(d.code).toBe(1);
  });

  it("X6: red naming a full name two tests share is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [{ name: "dup", pkg: FX, test: "dup.fx.mjs", red: "dup same", edits: [BREAK_SUM] }],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toContain('(2 tests are named "dup same")');
    expect(d.code).toBe(1);
  });

  it("X7: a run that ended other than passed/failed (a bail: interrupted) is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [{ name: "bailed", pkg: "bail", test: "bail.fx.mjs", edits: [BREAK_SUM] }],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toContain('the run ended "interrupted"');
    expect(d.code).toBe(1);
  });

  it("X8: a failure in another file the filter also matched is not the target's", () => {
    // `vitest run inner.fx.mjs` also runs winner.fx.mjs, which fails.
    const d = drive(
      fx!,
      [{ name: "other file", pkg: FX, test: "inner.fx.mjs", edits: [BREAK_SUM] }],
      1,
    );
    expect(verdicts(d)).toEqual(["INCONCLUSIVE"]);
    expect(d.code).toBe(1);
  });

  it("X9: a baseline where every test passed but vitest exited non-zero aborts (exit 2)", () => {
    const d = drive(
      fx!,
      [{ name: "exit 7", pkg: "exit7", test: "ok.fx.mjs", edits: [BREAK_SUM] }],
      1,
    );
    expect(d.out).toMatch(
      /^BASELINE NOT GREEN: exit7 ok\.fx\.mjs +\(vitest exited [1-9]\d* with every test passing/m,
    );
    expect(verdicts(d)).not.toContain("RED");
    expect(d.code).toBe(2);
  });

  it("only: runs just the red test (a failing sibling is never run)", () => {
    const d = drive(
      fx!,
      [
        {
          name: "narrowed, sibling broken",
          ...SUM_TEST,
          red: "sum adds two numbers",
          only: true,
          edits: [BREAK_SUB],
        },
        {
          name: "narrowed, red broken",
          ...SUM_TEST,
          red: "sum subtracts two numbers",
          only: true,
          edits: [BREAK_SUB],
        },
      ],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["GREEN", "RED"]);
    expect(d.out).toMatch(/^GREEN +narrowed, sibling broken +\("sum adds two numbers" passed\)$/m);
    expect(d.code).toBe(1);
  });

  it("only without red aborts (exit 2)", () => {
    const d = drive(fx!, [{ name: "no red", ...SUM_TEST, only: true, edits: [BREAK_SUM] }], 1);
    expect(d.out).toContain('entry "no red" sets only without red');
    expect(d.code).toBe(2);
  });
});

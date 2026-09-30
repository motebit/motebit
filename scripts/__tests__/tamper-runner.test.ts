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

const SUM_CHECK = { command: ["node", "sum.check.mjs"], redMarker: "SUM CHECK FAILED" };
const SYNTAX_ERROR = { file: SUM_FILE, from: "return a + b;", to: "return a + ;" };

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
    expect(d.out).toMatch(/INCONCLUSIVE +syntax +\(suite-level error/);
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

  it("a command entry goes RED only with its red marker", () => {
    const d = drive(fx!, [{ name: "cmd", ...SUM_CHECK, edits: [BREAK_SUM] }], 1);
    expect(verdicts(d)).toEqual(["RED"]);
    expect(d.code).toBe(0);
  });

  it("C2: a command that crashes (non-zero exit, no red marker) is INCONCLUSIVE, never RED", () => {
    const d = drive(fx!, [{ name: "cmd crash", ...SUM_CHECK, edits: [SYNTAX_ERROR] }], 1);
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
});

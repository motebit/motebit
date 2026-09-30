/**
 * tamper-runner self-tests: CAUSATION. A RED is reproduced causation, never a
 * single observation: in one slot, unedited / edited / unedited / edited /
 * unedited must go green / red / green / red / green, both edited runs failing
 * the same test with the same error class. Every run's processes die with it
 * (its process group is killed and nothing may survive that), an edit must be
 * valid code by the compiler, and an entry that changes nothing aborts.
 * Each test here is a false RED a cold review of cb7268d79 reproduced.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BREAK_SUM,
  COMMENT_ONLY,
  FX,
  SUM_FILE,
  drive,
  setupFixture,
  teardownFixture,
  tokenEdit,
  verdicts,
} from "./tamper-runner.harness";
import type { Fx } from "./tamper-runner.harness";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

let fx: Fx | undefined;
beforeEach(async () => {
  fx = await setupFixture();
});
afterEach(() => {
  // A holder a failing run left must not outlive the test (it holds a port).
  for (const pid of orphans()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  teardownFixture(fx);
  fx = undefined;
});

/** Every holder orphan.fx.mjs spawned (their pids, from FX_STATE-orphans). */
function orphans(): number[] {
  const f = `${fx!.state}-orphans`;
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map(Number);
}

/** Alive and not a zombie (a killed orphan's parent is gone; init may be slow to reap it). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch {
    return !existsSync("/proc/self/stat");
  }
}

const ORPHAN = { pkg: FX, test: "orphan.fx.mjs" };
const COUNTED = { pkg: FX, test: "counted.fx.mjs" };

describe("tamper-runner causation", () => {
  it.each([1500, 2500, 60000])(
    "C1: a process a run leaves holding a port (FX_HOLD=%i ms) never turns a comment-only edit red, and dies with its run",
    (hold) => {
      const d = drive(
        fx!,
        [1, 2, 3].map((k) => ({
          name: `orphan: comment only ${k}`,
          ...ORPHAN,
          edits: [COMMENT_ONLY],
        })),
        1,
        { env: { FX_HOLD: String(hold) } },
      );
      expect(verdicts(d), d.out).toEqual(["GREEN", "GREEN", "GREEN"]);
      expect(d.code).toBe(1);
      expect(orphans().length, d.out).toBeGreaterThan(0);
      expect(orphans().filter(alive), d.out).toEqual([]);
    },
  );

  it("C1: a process that escapes its run's process group (own session) is an orphan: the run is not green, and it is killed", () => {
    const d = drive(fx!, [{ name: "orphan: comment only", ...ORPHAN, edits: [COMMENT_ONLY] }], 1, {
      env: { FX_HOLD: "60000", FX_DETACH: "1" },
    });
    expect(verdicts(d), d.out).not.toContain("RED");
    expect(d.out).toMatch(/BASELINE NOT GREEN: fx orphan\.fx\.mjs +\(orphan: pid \d+/);
    expect(d.code).toBe(2);
    expect(orphans().length, d.out).toBeGreaterThan(0);
    expect(orphans().filter(alive), d.out).toEqual([]);
  });

  it("C2: a 50% flaky test gives no RED over 12 comment-only entries", () => {
    const d = drive(
      fx!,
      Array.from({ length: 12 }, (_, k) => ({
        name: `flaky: comment only ${k}`,
        pkg: FX,
        test: "flaky.fx.mjs",
        edits: [COMMENT_ONLY],
      })),
      1,
      // The first seed whose run 0 (the baseline) is heads; cb7268d79 gives 2 REDs with it.
      { env: { FX_SEED: "0" } },
    );
    expect(verdicts(d), d.out).not.toContain("RED");
    expect(d.out).toContain("0/12 tampers turned their test red");
  });

  it("C2: a self-enforced timeout (vi.waitFor) that does not reproduce is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [
        {
          name: "wait once",
          pkg: FX,
          test: "waitfor.fx.mjs",
          edits: [tokenEdit("TOKEN_WAIT_ONCE")],
        },
      ],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +wait once +\(did not reproduce: edited run 1 RED, edited run 2 GREEN/,
    );
  });

  it("C3: an edit tsc rejects (TS2551) is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [
        {
          name: "addd",
          pkg: FX,
          test: "fold.fx.mjs",
          edits: [{ file: "packages/fx/fold.ts", from: "c.add(acc, x)", to: "c.addd(acc, x)" }],
        },
      ],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +addd +\(edit does not type-check: packages\/fx\/fold\.ts:\d+ TS2551/,
    );
  });

  it("C4: an edit that imports a module that does not exist is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [
        {
          name: "missing module",
          pkg: FX,
          test: "dynimport.fx.mjs",
          edits: [
            {
              file: SUM_FILE,
              from: "// marker: a comment",
              to: 'import "./missing-helper.mjs"; //',
            },
          ],
        },
      ],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +missing module +\(edit does not type-check: packages\/fx\/sum\.mjs:\d+ .*missing-helper\.mjs/,
    );
  });

  it.each([
    ["no edits", []],
    ["from === to", [{ file: SUM_FILE, from: "a + b", to: "a + b" }]],
    [
      "edits that cancel out",
      [COMMENT_ONLY, { file: SUM_FILE, from: "// changed: a comment", to: "// marker: a comment" }],
    ],
  ])("a no-op entry (%s) aborts the run (exit 2), never runs", (label, edits) => {
    const d = drive(
      fx!,
      [
        { name: "real", pkg: FX, test: "sum.fx.mjs", edits: [BREAK_SUM] },
        { name: `noop ${label}`, pkg: FX, test: "sum.fx.mjs", edits },
      ],
      1,
    );
    expect(d.out).toMatch(new RegExp(`ABORTED — entry "noop ${label}" changes nothing`));
    expect(verdicts(d)).toEqual([]);
    expect(d.code).toBe(2);
  });

  it("the unedited run BETWEEN the edited runs must be green (a failure no edit caused)", () => {
    const d = drive(fx!, [{ name: "mid", ...COUNTED, edits: [COMMENT_ONLY] }], 1, {
      env: { FX_FAIL_FIRST: "1,2" },
    });
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +mid +\(run 3\/5 \(unedited, between the edited runs\) not green/,
    );
  });

  it("both edited runs must fail the SAME test (without red:, the same set)", () => {
    const d = drive(fx!, [{ name: "moved", ...COUNTED, edits: [COMMENT_ONLY] }], 1, {
      env: { FX_FAIL_FIRST: "1", FX_FAIL_SECOND: "3" },
    });
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +moved +\(the edited runs failed differently: run 2 failed "first" \(AssertionError\); run 4 failed "second" \(AssertionError\)\)/,
    );
  });

  it("both edited runs must fail with the same error class", () => {
    const d = drive(fx!, [{ name: "class", ...COUNTED, red: "first", edits: [COMMENT_ONLY] }], 1, {
      env: { FX_FAIL_FIRST: "1", FX_THROW_TYPE: "3" },
    });
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +class +\(the edited runs failed differently: run 2 failed "first" \(AssertionError\); run 4 failed "first" \(TypeError\)\)/,
    );
  });

  it("the post-run (run 5/5) must be green: state the edit left fails it", () => {
    const d = drive(fx!, [{ name: "post", ...COUNTED, edits: [COMMENT_ONLY] }], 1, {
      env: { FX_FAIL_FIRST: "1,3,4" },
    });
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(/INCONCLUSIVE +post +\(post-run not green: slot state leaked/);
  });

  it("each test a RED rests on must PASS in the post-run (skipped is not passed)", () => {
    const d = drive(fx!, [{ name: "hidden", ...COUNTED, edits: [COMMENT_ONLY] }], 1, {
      env: { FX_FAIL_FIRST: "1,3", FX_SKIP_FIRST: "4" },
    });
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toContain('(post-run: "first" did not pass with the edit reverted)');
  });

  it("a test seen failing with no edit anywhere in the run voids every RED on it", () => {
    const d = drive(
      fx!,
      [
        { name: "looks red", ...COUNTED, edits: [COMMENT_ONLY] },
        { name: "shows the flake", ...COUNTED, edits: [tokenEdit("TOKEN_B")] },
      ],
      1,
      // runs 1 and 3 (entry 1's edited runs) fail; so does run 6 (entry 2's middle run, no edit)
      { env: { FX_FAIL_FIRST: "1,3,6" } },
    );
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE", "INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +looks red +\(the test failed with no edit in this run — "shows the flake", run 3\/5: failing: "first"/,
    );
  });

  it("a real tamper is RED under the full sequence, and costs four runs of its test", () => {
    const d = drive(fx!, [{ name: "counted fix reverted", ...COUNTED, edits: [BREAK_SUM] }], 1);
    expect(verdicts(d), d.out).toEqual(["RED"]);
    expect(d.code).toBe(0);
    // baseline (the entry's first unedited run) + edited + unedited + edited + unedited
    expect(readFileSync(`${fx!.state}-counted`, "utf8")).toBe("5");
  });
});

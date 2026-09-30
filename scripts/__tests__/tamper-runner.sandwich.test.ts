/**
 * tamper-runner self-tests: THE SANDWICH. An entry is RED only when, in the
 * same slot, its test is green immediately before the edit, red with it, and
 * green again after it is reverted — with the slot's TMPDIR emptied and a
 * fresh HOME for every run. State the tamper did not cause (a file a previous
 * run left, a flaky timeout, an edit that is not valid code) is never a RED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BREAK_SUM,
  COMMENT_ONLY,
  FX,
  SUM_TEST,
  SYNTAX_ERROR,
  UNDEFINED_NAME,
  drive,
  setupFixture,
  teardownFixture,
  tokenEdit,
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

const TMPLEAK = { pkg: FX, test: "tmpleak.fx.mjs" };
const HOMELEAK = { pkg: FX, test: "homeleak.fx.mjs" };
const GLOBALLEAK = { pkg: FX, test: "globalleak.fx.mjs" };
const DYNIMPORT = { pkg: FX, test: "dynimport.fx.mjs" };
const SLOWLOAD = { pkg: FX, test: "slowload.fx.mjs" };

describe("tamper-runner sandwich", () => {
  it("C1: a file a failing run left in TMPDIR does not turn the next entry red (same test file)", () => {
    const d = drive(
      fx!,
      [
        { name: "A1 fix reverted (leaves a file)", ...TMPLEAK, edits: [BREAK_SUM] },
        { name: "A2 comment only", ...TMPLEAK, edits: [COMMENT_ONLY] },
      ],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["RED", "GREEN"]);
    expect(d.code).toBe(1);
  });

  it("C1: a cache another test file left in TMPDIR does not turn later entries red (cross-file)", () => {
    const d = drive(
      fx!,
      [
        { name: "tmpwriter: fix reverted", pkg: FX, test: "tmpwriter.fx.mjs", edits: [BREAK_SUM] },
        { name: "tmpleak: comment A", ...TMPLEAK, edits: [tokenEdit("TOKEN_A")] },
        { name: "tmpleak: comment B", ...TMPLEAK, edits: [tokenEdit("TOKEN_B")] },
      ],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["RED", "GREEN", "GREEN"]);
    expect(d.out).toContain("1/3 tampers turned their test red");
    expect(d.code).toBe(1);
  });

  it("HOME: a file a failing run left in HOME (or XDG_CACHE_HOME) does not turn the next entry red", () => {
    const d = drive(
      fx!,
      [
        { name: "A1 fix reverted (leaves a file)", ...HOMELEAK, edits: [BREAK_SUM] },
        { name: "A2 comment only", ...HOMELEAK, edits: [COMMENT_ONLY] },
      ],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["RED", "GREEN"]);
    expect(d.code).toBe(1);
  });

  it("post: a RED whose post-run (edit reverted) is not green is INCONCLUSIVE — state leaked", () => {
    const d = drive(fx!, [{ name: "A1 leaks globally", ...GLOBALLEAK, edits: [BREAK_SUM] }], 1);
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +A1 leaks globally +\(post-run not green: slot state leaked/,
    );
    expect(d.code).toBe(1);
  });

  it("pre: an entry whose pre-run (no edit, same slot, just before) is not green is never RED", () => {
    const d = drive(
      fx!,
      [
        { name: "A1 leaks globally", ...GLOBALLEAK, edits: [BREAK_SUM] },
        { name: "A2 comment only", ...GLOBALLEAK, edits: [COMMENT_ONLY] },
      ],
      1,
    );
    expect(verdicts(d)[1], d.out).toBe("INCONCLUSIVE");
    expect(d.out).toMatch(/INCONCLUSIVE +A2 comment only +\(pre-run not green/);
    expect(d.code).toBe(1);
  });

  it("C2: an edit that does not parse is INCONCLUSIVE when the test imports it dynamically", () => {
    const d = drive(fx!, [{ name: "syntax (dynamic)", ...DYNIMPORT, edits: [SYNTAX_ERROR] }], 1);
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +syntax \(dynamic\) +\(edit is not valid code: packages\/fx\/sum\.mjs does not parse/,
    );
    expect(d.code).toBe(1);
  });

  it("C2: an edit that does not parse is INCONCLUSIVE when the test imports it statically", () => {
    const d = drive(fx!, [{ name: "syntax (static)", ...SUM_TEST, edits: [SYNTAX_ERROR] }], 1);
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +syntax \(static\) +\(edit is not valid code: packages\/fx\/sum\.mjs does not parse/,
    );
    expect(d.code).toBe(1);
  });

  it("C2: an edit that names an undefined variable (dynamic import) is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [{ name: "undefined (dynamic)", ...DYNIMPORT, edits: [UNDEFINED_NAME] }],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +undefined \(dynamic\) +\(edit is not valid code: ReferenceError: bb is not defined/,
    );
    expect(d.code).toBe(1);
  });

  it("C2: an edit that names an undefined variable (static import) is INCONCLUSIVE, never RED", () => {
    const d = drive(
      fx!,
      [{ name: "undefined (static)", pkg: FX, test: "winner.fx.mjs", edits: [UNDEFINED_NAME] }],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(
      /INCONCLUSIVE +undefined \(static\) +\(edit is not valid code: ReferenceError: bb is not defined/,
    );
    expect(d.code).toBe(1);
  });

  it("P-a: a timeout that does not reproduce on an immediate re-run with the edit is INCONCLUSIVE", () => {
    const d = drive(
      fx!,
      [{ name: "spike once", ...SLOWLOAD, edits: [tokenEdit("TOKEN_SPIKE_ONCE")] }],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["INCONCLUSIVE"]);
    expect(d.out).toMatch(/INCONCLUSIVE +spike once +\(a timeout that did not reproduce/);
    expect(d.code).toBe(1);
  });

  it("P-a: a timeout that reproduces on the re-run, with a green post-run, is RED", () => {
    const d = drive(
      fx!,
      [{ name: "spike always", ...SLOWLOAD, edits: [tokenEdit("TOKEN_SPIKE_ALWAYS")] }],
      1,
    );
    expect(verdicts(d), d.out).toEqual(["RED"]);
    expect(d.code).toBe(0);
  });
});

/**
 * tamper-runner self-tests: ISOLATION. Every tamper runs in a private copy of
 * the caller's tree; the copy is reused only when it is provably back to its
 * pristine state; entries on one test file never run at once (fixed ports);
 * workspace links in the copied pnpm store resolve to the copy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TamperEntry } from "../lib/tamper-runner";
import {
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
let held: Server | undefined;
beforeEach(async () => {
  fx = await setupFixture();
});
afterEach(async () => {
  if (held != null) await new Promise((r) => held!.close(r));
  held = undefined;
  teardownFixture(fx);
  fx = undefined;
});

const tokenEdit = (token: string) => ({
  file: SUM_FILE,
  from: "// marker: a comment",
  to: `// ${token}: a comment`,
});

describe("tamper-runner isolation", () => {
  it("never touches the caller's tree, including its uncommitted state — and tests that state", () => {
    // An uncommitted "fix" in the caller: the tamper must see it (it is what
    // gets tested) without the caller's copy ever changing.
    const sum = join(fx!.repo, SUM_FILE);
    writeFileSync(sum, readFileSync(sum, "utf8").replace("a + b", "b + a"));
    writeFileSync(join(fx!.repo, "untracked.txt"), "caller scratch\n");
    const before = snapshot(fx!);
    const d = drive(
      fx!,
      [
        {
          name: "dirty fix reverted",
          ...SUM_TEST,
          edits: [{ file: SUM_FILE, from: "b + a", to: "b - a" }],
        },
        { name: "HEAD text absent", ...SUM_TEST, edits: [BREAK_SUM] },
      ],
      2,
    );
    expect(verdicts(d)).toEqual(["RED", "COULD NOT APPLY"]);
    expect(d.code).toBe(1);
    expect(snapshot(fx!)).toBe(before);
  });

  it("two tampers on the same file run concurrently in separate copies without interfering", () => {
    const before = snapshot(fx!);
    const own = (mine: string, other: string): TamperEntry => ({
      name: `edit ${mine}`,
      command: ["node", "own-edit.check.mjs", mine, other],
      redMarker: `OWN COPY ${mine}`,
      edits: [tokenEdit(mine)],
    });
    const d = drive(fx!, [own("TOKEN_A", "TOKEN_B"), own("TOKEN_B", "TOKEN_A")], 2);
    expect(d.summary.concurrency).toBe(2);
    expect(verdicts(d)).toEqual(["RED", "RED"]);
    expect(new Set(d.summary.results.map((r) => r.slot)).size).toBe(2);
    // Output is in entry order whatever order they finished in.
    expect(d.out.indexOf("edit TOKEN_A")).toBeLessThan(d.out.indexOf("edit TOKEN_B"));
    expect(d.code).toBe(0);
    expect(snapshot(fx!)).toBe(before);
  });

  it("reuses a slot: a restored file carries no residue of the previous tamper", () => {
    const d = drive(
      fx!,
      [
        { name: "first", ...SUM_TEST, edits: [BREAK_SUM] },
        // Would be COULD NOT APPLY if "first" were left applied in the slot.
        { name: "second", ...SUM_TEST, edits: [{ file: SUM_FILE, from: "a + b", to: "a * b" }] },
        { name: "third (uncaught)", ...SUM_TEST, edits: [COMMENT_ONLY] },
      ],
      1,
    );
    expect(verdicts(d)).toEqual(["RED", "RED", "GREEN"]);
    expect(d.code).toBe(1);
  });

  it("each copy has a private TMPDIR", () => {
    const tmp = (mine: string): TamperEntry => ({
      name: `tmp ${mine}`,
      command: ["node", "tmp.check.mjs", mine],
      redMarker: `PRIVATE TMP ${mine}`,
      edits: [tokenEdit(mine)],
    });
    const d = drive(fx!, [tmp("TOKEN_A"), tmp("TOKEN_B")], 2);
    expect(verdicts(d)).toEqual(["RED", "RED"]);
    expect(d.code).toBe(0);
  });

  it("a check that writes into the caller's tree fails the run (exit 2)", () => {
    const d = drive(
      fx!,
      [
        {
          name: "writes the caller",
          command: ["node", "caller.check.mjs", "TOKEN_A", join(fx!.repo, "caller-scratch.txt")],
          redMarker: "CALLER WRITE",
          edits: [tokenEdit("TOKEN_A")],
        },
      ],
      1,
    );
    expect(d.out).toContain("the caller's working tree CHANGED during the run");
    expect(d.code).toBe(2);
  });

  it.each(["tracked", "untracked"])(
    "a copy a check left dirty (%s file) is never reused: exit 2",
    (mode) => {
      const d = drive(
        fx!,
        [
          {
            name: `dirties its copy (${mode})`,
            command: ["node", "dirty.check.mjs", "TOKEN_A", mode],
            redMarker: "DIRTY SLOT",
            edits: [tokenEdit("TOKEN_A")],
          },
          { name: "next in the same copy", ...SUM_TEST, edits: [BREAK_SUM] },
        ],
        1,
      );
      expect(d.out).toMatch(/ABORTED — tamper-runner: slot 0 did not restore/);
      expect(d.code).toBe(2);
    },
  );

  it("C4: an ignored output a rebuild changed (dist/ and a non-dist out/) is restored before the next tamper", () => {
    const GEN = { pkg: FX, test: "gen.fx.mjs" };
    const d = drive(
      fx!,
      [
        {
          name: "rebuilt with sum multiplying",
          ...GEN,
          rebuild: [FX],
          edits: [{ file: SUM_FILE, from: "a + b", to: "a * b" }],
        },
        // Same test file, same copy: sees the rebuilt outputs unless they were restored.
        { name: "comment only, after the rebuild", ...GEN, edits: [COMMENT_ONLY] },
      ],
      1,
    );
    expect(verdicts(d)).toEqual(["RED", "GREEN"]);
    expect(d.code).toBe(1);
  });

  it("a rebuild that fails reports BUILD FAILED", () => {
    const d = drive(
      fx!,
      [
        {
          name: "build broken",
          pkg: FX,
          test: "gen.fx.mjs",
          rebuild: [FX],
          edits: [
            {
              file: "packages/fx/build.mjs",
              from: "for (const dir of",
              to: "process.exit(3);\nfor (const dir of",
            },
          ],
        },
      ],
      1,
    );
    expect(verdicts(d)).toEqual(["BUILD FAILED"]);
    expect(d.out).toMatch(/BUILD FAILED +build broken +\(pnpm --filter fx build exited/);
    expect(d.code).toBe(1);
  });

  it("P1: a hoisted store link resolves to the copy's workspace package, not the caller's", () => {
    const d = drive(
      fx!,
      [
        {
          name: "lib value changed",
          pkg: FX,
          test: "link.fx.mjs",
          edits: [{ file: "packages/lib/value.txt", from: "ok", to: "bad" }],
        },
      ],
      1,
    );
    expect(verdicts(d)).toEqual(["RED"]);
    expect(d.code).toBe(0);
  });

  it("C1: entries on one test file run one after another in one copy (a fixed port never collides)", () => {
    const PORT = { pkg: FX, test: "port.fx.mjs" };
    const d = drive(
      fx!,
      [
        { name: "port: sum broken", ...PORT, edits: [BREAK_SUM] },
        { name: "port: comment only", ...PORT, edits: [COMMENT_ONLY] },
      ],
      2,
    );
    expect(verdicts(d)).toEqual(["RED", "GREEN"]);
    expect(new Set(d.summary.results.map((r) => r.slot)).size).toBe(1);
    expect(d.code).toBe(1);
  });

  it("C1: a fixed port held outside the run aborts it at the baseline, never a false RED", async () => {
    held = createServer();
    await new Promise<void>((r) => held!.listen(fx!.port, "127.0.0.1", () => r()));
    const d = drive(
      fx!,
      [{ name: "port: comment only", pkg: FX, test: "port.fx.mjs", edits: [COMMENT_ONLY] }],
      1,
    );
    expect(d.out).toMatch(/^BASELINE NOT GREEN: fx port\.fx\.mjs/m);
    expect(verdicts(d)).not.toContain("RED");
    expect(d.code).toBe(2);
  });
});

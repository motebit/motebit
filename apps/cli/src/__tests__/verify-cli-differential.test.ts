/**
 * Differential: `motebit verify receipt` and `motebit-verify` read the same
 * adversarial corpus to IDENTICAL exit codes, strict and `--lenient`. Both
 * CLIs consume one nested walk (`verifyReceipt` + `collectReceiptTreeErrors`
 * from @motebit/crypto), so a divergence here means one grew a second walker.
 * Includes the committed negative conformance fixtures.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adversarialCorpus, type CorpusEntry } from "./helpers/adversarial-receipts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const MOTEBIT_VERIFY_WIRE = resolve(HERE, "helpers", "run-verify-wire.ts");
const MOTEBIT_VERIFY_CLI = join(REPO, "packages", "verify", "src", "cli.ts");
const NEGATIVE_DIR = join(REPO, "examples", "python-receipt-verifier", "fixtures", "negative");

function exitOf(script: string, args: readonly string[]): number | null {
  const r = spawnSync("npx", ["--yes", "tsx", script, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    cwd: REPO,
  });
  return r.status;
}

describe("motebit verify receipt ≡ motebit-verify (exit codes)", () => {
  let dir: string;
  let corpus: CorpusEntry[];
  const files: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-differential-"));
    corpus = await adversarialCorpus();
    for (const e of corpus) {
      files[e.name] = join(dir, `${e.name}.json`);
      writeFileSync(files[e.name]!, JSON.stringify(e.receipt));
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("every corpus entry: identical exit codes, matching the expected verdict", async () => {
    const rows: string[] = [];
    for (const e of corpus) {
      const f = files[e.name]!;
      for (const lenient of [false, true]) {
        const flag = lenient ? ["--lenient"] : [];
        const a = exitOf(MOTEBIT_VERIFY_WIRE, ["receipt", f, ...flag]);
        const b = exitOf(MOTEBIT_VERIFY_CLI, [...flag, f]);
        const want = (lenient ? e.lenientOk : e.strictOk) ? 0 : 1;
        rows.push(
          `${e.name}${lenient ? " --lenient" : ""}: motebit=${a} motebit-verify=${b} want=${want}`,
        );
        expect({ name: e.name, lenient, motebit: a, motebitVerify: b }).toEqual({
          name: e.name,
          lenient,
          motebit: want,
          motebitVerify: want,
        });
      }
    }
    expect(rows.length).toBe(corpus.length * 2);
  }, 600_000);

  it("committed negative conformance fixtures: both CLIs exit 1, strict and --lenient", () => {
    const negatives = readdirSync(NEGATIVE_DIR).filter((f) => f.endsWith(".json"));
    expect(negatives.length).toBeGreaterThan(0);
    for (const n of negatives) {
      const f = join(NEGATIVE_DIR, n);
      for (const flag of [[], ["--lenient"]]) {
        expect([n, flag, exitOf(MOTEBIT_VERIFY_WIRE, ["receipt", f, ...flag])]).toEqual([
          n,
          flag,
          1,
        ]);
        expect([n, flag, exitOf(MOTEBIT_VERIFY_CLI, [...flag, f])]).toEqual([n, flag, 1]);
      }
    }
  }, 300_000);
});

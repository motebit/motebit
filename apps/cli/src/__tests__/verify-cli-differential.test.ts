/**
 * Differential: `motebit verify receipt` and `motebit-verify` read the same
 * adversarial corpus to IDENTICAL exit codes, strict and `--lenient`. Both
 * CLIs consume one nested walk (`verifyReceipt` + `collectReceiptTreeErrors`
 * from @motebit/crypto), so a divergence here means one grew a second walker.
 * Includes the committed negative conformance fixtures.
 */
import { spawn } from "node:child_process";
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

function exitOf(script: string, args: readonly string[]): Promise<number | null> {
  return new Promise((resolveExit) => {
    const child = spawn("npx", ["--yes", "tsx", script, ...args], { cwd: REPO, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
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
    const runs = corpus.flatMap((e) =>
      [false, true].map(async (lenient) => {
        const f = files[e.name]!;
        const flag = lenient ? ["--lenient"] : [];
        const [motebit, motebitVerify] = await Promise.all([
          exitOf(MOTEBIT_VERIFY_WIRE, ["receipt", f, ...flag]),
          exitOf(MOTEBIT_VERIFY_CLI, [...flag, f]),
        ]);
        const want = (lenient ? e.lenientOk : e.strictOk) ? 0 : 1;
        return { got: { name: e.name, lenient, motebit, motebitVerify }, want };
      }),
    );
    const results = await Promise.all(runs);
    expect(results.length).toBe(corpus.length * 2);
    for (const { got, want } of results) {
      expect(got).toEqual({ ...got, motebit: want, motebitVerify: want });
    }
  }, 600_000);

  it("committed negative conformance fixtures: both CLIs exit 1, strict and --lenient", async () => {
    const negatives = readdirSync(NEGATIVE_DIR).filter((f) => f.endsWith(".json"));
    expect(negatives.length).toBeGreaterThan(0);
    const runs = negatives.flatMap((n) =>
      [[], ["--lenient"]].map(async (flag) => {
        const f = join(NEGATIVE_DIR, n);
        const [motebit, motebitVerify] = await Promise.all([
          exitOf(MOTEBIT_VERIFY_WIRE, ["receipt", f, ...flag]),
          exitOf(MOTEBIT_VERIFY_CLI, [...flag, f]),
        ]);
        return { n, flag, motebit, motebitVerify };
      }),
    );
    for (const r of await Promise.all(runs)) {
      expect(r).toEqual({ ...r, motebit: 1, motebitVerify: 1 });
    }
  }, 300_000);
});

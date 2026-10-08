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
const FIXTURES = join(REPO, "examples", "python-receipt-verifier", "fixtures");

/** `.json` vectors under `fixtures/<sub>/`, or none when the directory is absent. */
function vectors(sub: string): string[] {
  try {
    return readdirSync(join(FIXTURES, sub))
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(FIXTURES, sub, f));
  } catch {
    return [];
  }
}

/** At most this many CLI processes at once, so the suite does not starve its neighbours. */
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function exitOf(script: string, args: readonly string[]): Promise<number | null> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await spawnExit(script, args);
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

function spawnExit(script: string, args: readonly string[]): Promise<number | null> {
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

  it("committed conformance vectors: negative/ exit 1 both modes; strict-negative/ exit 1 strict, 0 --lenient", async () => {
    const cases = [
      ...vectors("negative").map((f) => ({ f, strict: 1, lenient: 1 })),
      ...vectors("strict-negative").map((f) => ({ f, strict: 1, lenient: 0 })),
    ];
    expect(cases.length).toBeGreaterThan(0);
    const runs = cases.flatMap((c) =>
      [false, true].map(async (lenient) => {
        const flag = lenient ? ["--lenient"] : [];
        const [motebit, motebitVerify] = await Promise.all([
          exitOf(MOTEBIT_VERIFY_WIRE, ["receipt", c.f, ...flag]),
          exitOf(MOTEBIT_VERIFY_CLI, [...flag, c.f]),
        ]);
        return {
          got: { f: c.f, lenient, motebit, motebitVerify },
          want: lenient ? c.lenient : c.strict,
        };
      }),
    );
    for (const { got, want } of await Promise.all(runs)) {
      expect(got).toEqual({ ...got, motebit: want, motebitVerify: want });
    }
  }, 300_000);
});

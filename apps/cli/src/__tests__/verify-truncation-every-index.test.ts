/**
 * A result truncated at EVERY index of a string holding emoji (surrogate pairs,
 * a ZWJ-free skin-tone sequence, a flag) yields a receipt that passes strict
 * verification in `motebit verify receipt`, `motebit-verify` and the Python
 * reference verifier — whether the cut is surrogate-safe
 * (`truncateWellFormed`) or a naive `.slice(0, i)` that leaves a lone high
 * surrogate (an upstream LLM stream cut mid-emoji): the producer
 * (`buildServiceReceipt` → `signExecutionReceipt`) repairs it to U+FFFD before
 * signing, so no producer emits an unpaired surrogate
 * (spec/execution-ledger-v1.md §11.4).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateKeypair } from "@motebit/encryption";
import { buildServiceReceipt } from "@motebit/mcp-server";
import { truncateWellFormed } from "@motebit/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const MOTEBIT_VERIFY_WIRE = resolve(HERE, "helpers", "run-verify-wire.ts");
const MOTEBIT_VERIFY_CLI = join(REPO, "packages", "verify", "src", "cli.ts");
const VERIFY_PY = join(REPO, "examples", "python-receipt-verifier", "verify.py");

const SAMPLE = "ok 😀 👍🏽 🇺🇸!";
const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function exitOf(cmd: string, args: readonly string[]): Promise<number | null> {
  return new Promise((resolveExit) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

/** Run `tasks` with at most `limit` in flight — each spawns a tsx process. */
async function pooled<T>(tasks: Array<() => Promise<T>>, limit = 4): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

const pythonAvailable = (() => {
  const r = spawnSync("python3", ["-c", "import nacl"], { encoding: "utf8" });
  return r.status === 0;
})();

describe("receipt result truncated at every index → strict-valid in both CLIs and Python", () => {
  let dir: string;
  const files: Array<{ name: string; path: string }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "verify-truncation-"));
    const kp = await generateKeypair();
    for (let i = 0; i <= SAMPLE.length; i++) {
      // The naive cut differs from the safe one only where it splits a pair;
      // elsewhere it is the same text, so it is minted only where it differs.
      const naive = SAMPLE.slice(0, i);
      const cuts: Array<readonly [string, string]> = [["safe", truncateWellFormed(SAMPLE, i)]];
      if (naive !== truncateWellFormed(SAMPLE, i)) cuts.push(["naive", naive]);
      for (const [how, result] of cuts) {
        const receipt = await buildServiceReceipt({
          motebitId: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
          deviceId: "truncation-test",
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          prompt: "summarize",
          taskId: `task-${how}-${i}`,
          submittedAt: 1_713_456_000_000,
          completedAt: 1_713_456_001_000,
          result,
          ok: true,
          toolsUsed: [],
        });
        expect(UNPAIRED.test(receipt.result)).toBe(false);
        const path = join(dir, `${how}-${i}.json`);
        writeFileSync(path, JSON.stringify(receipt));
        files.push({ name: `${how}-${i}`, path });
      }
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("the naive cut really leaves a lone surrogate at some index (the case is exercised)", () => {
    const lone = [...Array(SAMPLE.length + 1).keys()].filter((i) =>
      UNPAIRED.test(SAMPLE.slice(0, i)),
    );
    expect(lone.length).toBeGreaterThan(0);
  });

  it("motebit verify receipt and motebit-verify: exit 0 (strict default) for every index", async () => {
    const results = await pooled(
      files.map((f) => async () => ({
        name: f.name,
        motebit: await exitOf("npx", ["--yes", "tsx", MOTEBIT_VERIFY_WIRE, "receipt", f.path]),
        motebitVerify: await exitOf("npx", ["--yes", "tsx", MOTEBIT_VERIFY_CLI, f.path]),
      })),
    );
    expect(results.some((r) => r.name.startsWith("naive-"))).toBe(true);
    for (const r of results) expect(r).toEqual({ name: r.name, motebit: 0, motebitVerify: 0 });
  }, 600_000);

  it.runIf(pythonAvailable || process.env.REQUIRE_PYTHON === "1")(
    "Python reference verifier: valid for every index",
    async () => {
      const results = await pooled(
        files.map((f) => async () => ({
          name: f.name,
          python: await exitOf("python3", [VERIFY_PY, f.path]),
        })),
      );
      for (const r of results) expect(r).toEqual({ name: r.name, python: 0 });
    },
    300_000,
  );
});

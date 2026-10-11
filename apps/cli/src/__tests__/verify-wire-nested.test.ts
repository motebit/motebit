/**
 * `motebit verify receipt` checks result_hash binding at every delegation
 * depth (strict by default): a signed outer receipt carrying a
 * `delegation_receipts` child at depth 1 or 2 whose result_hash !=
 * hex(SHA-256(result)) FAILS; `--lenient` reads it OK. A fully bound nested
 * chain is OK both ways. Also pins that the x402 smoke's own worker receipt
 * is self-consistent under the strict default.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateKeypair, signExecutionReceipt } from "@motebit/encryption";

import { buildSmokeWorkerReceipt } from "../subcommands/smoke-x402.js";
import { verifyWire } from "../subcommands/verify-wire.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "motebit-verify-nested-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

async function mint(
  taskId: string,
  result: string,
  resultHash: string,
  delegations?: unknown[],
): Promise<unknown> {
  const kp = await generateKeypair();
  return signExecutionReceipt(
    {
      task_id: taskId,
      motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
      device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
      submitted_at: 1_713_456_000_000,
      completed_at: 1_713_456_001_000,
      status: "completed",
      result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: resultHash,
      ...(delegations ? { delegation_receipts: delegations as never } : {}),
    },
    kp.privateKey,
    kp.publicKey,
  );
}

async function chain(bad: 1 | 2 | null): Promise<string> {
  const h = (level: number, r: string) => (bad === level ? "b".repeat(64) : sha256Hex(r));
  const grandchild = await mint("task-depth-2", "grandchild result", h(2, "grandchild result"));
  const child = await mint("task-depth-1", "child result", h(1, "child result"), [grandchild]);
  const outer = await mint("task-outer", "outer result", sha256Hex("outer result"), [child]);
  return writeJson(`chain-${String(bad)}.json`, outer);
}

describe("verify receipt — nested result_hash binding", () => {
  for (const depth of [1, 2] as const) {
    it(`a mismatched child at depth ${depth} FAILS by default, naming depth and task_id`, async () => {
      const report = await verifyWire("receipt", await chain(depth));
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => c.name === "signature")?.ok).toBe(true);
      const bind = report.checks.find((c) => c.name === "result_hash");
      expect(bind?.ok).toBe(false);
      expect(bind?.detail).toContain(`delegation depth ${depth}, task_id task-depth-${depth}`);
    });

    it(`a mismatched child at depth ${depth} is OK under --lenient`, async () => {
      const report = await verifyWire("receipt", await chain(depth), Date.now(), {
        lenient: true,
      });
      expect(report.ok).toBe(true);
    });
  }

  it("a fully bound nested chain is OK both ways", async () => {
    const path = await chain(null);
    expect((await verifyWire("receipt", path)).ok).toBe(true);
    expect((await verifyWire("receipt", path, Date.now(), { lenient: true })).ok).toBe(true);
  });
});

describe("smoke-x402 worker receipt", () => {
  it("binds result_hash = hex(SHA-256(result)) and verifies under the strict default", async () => {
    const kp = await generateKeypair();
    const receipt = await buildSmokeWorkerReceipt({
      worker: {
        motebitId: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        deviceId: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        publicKey: kp.publicKey,
        privateKey: kp.privateKey,
      },
      taskId: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
      submittedAtMs: 1_713_456_000_000,
      completedAt: 1_713_456_001_000,
    });
    expect(receipt.result_hash).toBe(sha256Hex(receipt.result));
    const report = await verifyWire("receipt", writeJson("smoke.json", receipt));
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

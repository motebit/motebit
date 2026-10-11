/**
 * `motebit-verify` strict-by-default applies at every delegation depth: a
 * signed outer receipt (its own result_hash bound) carrying a
 * `delegation_receipts` child whose result_hash != hex(SHA-256(result)) — at
 * depth 1 or depth 2 — is INVALID (exit 1). `--lenient` reads it VALID with
 * the one-line warning. A fully bound nested chain is VALID both ways.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateKeypair, signExecutionReceipt } from "@motebit/crypto";

import { LENIENT_WARNING } from "../cli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(HERE, "..", "cli.ts");

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("npx", ["--yes", "tsx", CLI_SRC, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function mint(
  taskId: string,
  result: string,
  resultHash: string,
  delegations?: unknown[],
): Promise<Record<string, unknown>> {
  const kp = await generateKeypair();
  return (await signExecutionReceipt(
    {
      task_id: taskId,
      motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
      device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
      submitted_at: 1_713_456_000_000,
      completed_at: 1_713_456_001_000,
      status: "completed" as const,
      result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: resultHash,
      ...(delegations ? { delegation_receipts: delegations as never } : {}),
    },
    kp.privateKey,
    kp.publicKey,
  )) as unknown as Record<string, unknown>;
}

async function chain(bad: 1 | 2 | null): Promise<Record<string, unknown>> {
  const h = (level: number, r: string) => (bad === level ? "b".repeat(64) : sha256Hex(r));
  const grandchild = await mint("task-depth-2", "grandchild result", h(2, "grandchild result"));
  const child = await mint("task-depth-1", "child result", h(1, "child result"), [grandchild]);
  return mint("task-outer", "outer result", sha256Hex("outer result"), [child]);
}

describe("motebit-verify CLI — nested result_hash binding (e2e)", () => {
  let dir: string;
  const files: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mv-nested-"));
    for (const [name, bad] of [
      ["depth1", 1],
      ["depth2", 2],
      ["bound", null],
    ] as const) {
      files[name] = join(dir, `${name}.json`);
      writeFileSync(files[name], JSON.stringify(await chain(bad)));
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [name, depth] of [
    ["depth1", 1],
    ["depth2", 2],
  ] as const) {
    it(`mismatched child at depth ${depth} → INVALID, exit 1, naming depth and task_id`, () => {
      const r = runCli([files[name]!]);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/INVALID/);
      expect(r.stdout).toContain(`delegation depth ${depth}, task_id task-depth-${depth}`);
    });

    it(`mismatched child at depth ${depth} with --lenient → VALID, exit 0, warning`, () => {
      const r = runCli(["--lenient", files[name]!]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/VALID \(receipt\)/);
      expect(r.stderr.trim()).toBe(LENIENT_WARNING);
    });
  }

  it("a fully bound nested chain is VALID both ways", () => {
    expect(runCli([files.bound!]).status).toBe(0);
    expect(runCli(["--lenient", files.bound!]).status).toBe(0);
  });
});

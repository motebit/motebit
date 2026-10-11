/**
 * `motebit-verify` is STRICT by default: an ExecutionReceipt whose signature
 * verifies but whose `result_hash` is not `hex(SHA-256(result))` is INVALID
 * (exit 1). `--lenient` restores signature-only checking with a one-line
 * warning on stderr; `--strict` stays accepted as a no-op alias.
 *
 * The library default (`@motebit/verifier`, `strictHashBinding` unset ⇒ off)
 * is a pinned external contract and is NOT changed — only this CLI layer.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateKeypair, signExecutionReceipt } from "@motebit/crypto";
import { verifyFile } from "@motebit/verifier";

import { LENIENT_WARNING, parseArgs } from "../cli.js";

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

describe("parseArgs — result_hash binding flags", () => {
  it("strict is the default", () => {
    const parsed = parseArgs(["receipt.json"]);
    expect(parsed.strictHashBinding).toBe(true);
    expect(parsed.lenient).toBeUndefined();
  });

  it("--strict is an accepted no-op alias", () => {
    expect(parseArgs(["--strict", "receipt.json"]).strictHashBinding).toBe(true);
  });

  it("--lenient turns the binding check off", () => {
    const parsed = parseArgs(["--lenient", "receipt.json"]);
    expect(parsed.strictHashBinding).toBe(false);
    expect(parsed.lenient).toBe(true);
  });

  it("--strict with --lenient is a usage error", () => {
    expect(parseArgs(["--strict", "--lenient", "receipt.json"]).usageError).toMatch(
      /mutually exclusive/,
    );
  });
});

describe("motebit-verify CLI — result_hash binding (e2e)", () => {
  let dir: string;
  let mismatch: string;
  let good: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mv-hash-"));
    const kp = await generateKeypair();
    const base = {
      task_id: "task-hash",
      motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
      device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
      submitted_at: 1_713_456_000_000,
      completed_at: 1_713_456_001_000,
      status: "completed" as const,
      result: "the answer",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
    };
    const bad = await signExecutionReceipt(
      { ...base, result_hash: "b".repeat(64) },
      kp.privateKey,
      kp.publicKey,
    );
    const ok = await signExecutionReceipt(
      { ...base, result_hash: sha256Hex("the answer") },
      kp.privateKey,
      kp.publicKey,
    );
    mismatch = join(dir, "mismatch.json");
    good = join(dir, "good.json");
    writeFileSync(mismatch, JSON.stringify(bad));
    writeFileSync(good, JSON.stringify(ok));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("the library default is unchanged: signature-only, the mismatch reads valid", async () => {
    const lib = await verifyFile(mismatch);
    expect(lib.type).toBe("receipt");
    expect(lib.valid).toBe(true);
    const strict = await verifyFile(mismatch, { strictHashBinding: true });
    expect(strict.valid).toBe(false);
    expect(strict.errors?.some((e) => e.path === "result_hash")).toBe(true);
  });

  it("mismatch → INVALID, exit 1, naming result_hash — by default", () => {
    const r = runCli([mismatch]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/INVALID/);
    expect(r.stdout).toMatch(/result_hash/);
    expect(r.stderr).not.toContain(LENIENT_WARNING);
  });

  it("mismatch with --strict (no-op alias) → INVALID, exit 1", () => {
    expect(runCli(["--strict", mismatch]).status).toBe(1);
  });

  it("mismatch with --lenient → VALID, exit 0, one-line warning on stderr", () => {
    const r = runCli(["--lenient", mismatch]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/VALID \(receipt\)/);
    expect(r.stderr.trim()).toBe(LENIENT_WARNING);
  });

  it("a good receipt is VALID both ways", () => {
    expect(runCli([good]).status).toBe(0);
    const lenient = runCli(["--lenient", good]);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toMatch(/VALID \(receipt\)/);
  });
});

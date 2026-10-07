/**
 * `motebit-verify` (strict by default) on sovereign payment receipts, and on
 * every committed receipt fixture in the repo.
 *
 * A receipt minted by `signSovereignPaymentReceipt` — the signer the runtime's
 * payee path calls — binds `result_hash` to its own `result` text and carries
 * the paid service's hash in `service_result_hash`, which the CLI reports.
 * The pre-fix shape (service hash in `result_hash`) is INVALID under strict.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  generateKeypair,
  signExecutionReceipt,
  signSovereignPaymentReceipt,
} from "@motebit/crypto";
import { verifyFile } from "@motebit/verifier";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(HERE, "..", "cli.ts");
const REPO = resolve(HERE, "..", "..", "..", "..");

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

describe("motebit-verify — sovereign payment receipt", () => {
  let dir: string;
  let good: string;
  let unbound: string;
  const serviceHash = sha256Hex("the service result");

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mv-sov-"));
    const kp = await generateKeypair();
    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "bob",
        payee_device_id: "runtime-default",
        payer_motebit_id: "alice",
        rail: "solana",
        tx_hash: "5JxYz",
        amount_micro: 5_000n,
        asset: "USDC",
        service_description: "research query",
        prompt_hash: sha256Hex("q"),
        result_hash: serviceHash,
        tools_used: ["web_search"],
        submitted_at: 1_713_456_000_000,
        completed_at: 1_713_456_001_000,
      },
      kp.privateKey,
      kp.publicKey,
    );
    // The pre-fix shape: synthesized result, service hash in result_hash.
    const { signature: _s, suite: _u, service_result_hash: _h, public_key: _p, ...body } = receipt;
    const legacy = await signExecutionReceipt(
      { ...body, result_hash: serviceHash },
      kp.privateKey,
      kp.publicKey,
    );
    good = join(dir, "sovereign.json");
    unbound = join(dir, "sovereign-unbound.json");
    writeFileSync(good, JSON.stringify(receipt));
    writeFileSync(unbound, JSON.stringify(legacy));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is VALID under the strict default and reports service_result_hash", () => {
    const r = runCli([good]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/VALID \(receipt\)/);
    expect(r.stdout).toContain(serviceHash);
  });

  it("the library verdict reports the field under strict", async () => {
    const v = await verifyFile(good, { strictHashBinding: true });
    expect(v.valid).toBe(true);
    expect(v.type === "receipt" && v.receipt?.service_result_hash).toBe(serviceHash);
  });

  it("the pre-fix unbound shape is INVALID (exit 1) naming result_hash", () => {
    const r = runCli([unbound]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/result_hash/);
  });
});

describe("every committed receipt fixture verifies strict", () => {
  const FIXTURES = [
    "apps/verify/src/sample-receipt.json",
    "packages/verify/examples/sample-receipt.json",
    "examples/python-receipt-verifier/fixtures/example-receipt.json",
    "examples/python-receipt-verifier/fixtures/sovereign-receipt.json",
    "examples/python-receipt-verifier/fixtures/sovereign-receipt-email-approval.json",
    "examples/python-receipt-verifier/fixtures/sovereign-receipt-payment-denied.json",
    "examples/python-receipt-verifier/fixtures/sovereign-receipt-research-complete.json",
    "examples/python-receipt-verifier/fixtures/sovereign-receipt-stripe-audit.json",
    "examples/python-receipt-verifier/fixtures/triad-deny-receipt.json",
    "examples/python-receipt-verifier/fixtures/triad-execution-receipt.json",
  ];

  it.each(FIXTURES)("%s", async (rel) => {
    const v = await verifyFile(join(REPO, rel), { strictHashBinding: true });
    expect(v.type).toBe("receipt");
    expect(v.errors).toBeUndefined();
    expect(v.valid).toBe(true);
  });

  it("the verdict corpus: integrity-verified receipt cases verify strict, the rest do not", async () => {
    const corpus = JSON.parse(
      readFileSync(join(REPO, "spec/conformance/verification-verdict/corpus.json"), "utf-8"),
    ) as {
      cases: Array<{
        name: string;
        kind: string;
        input: { receipt: unknown };
        expected: { integrity: string };
      }>;
    };
    const receipts = corpus.cases.filter((c) => c.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
    const tmp = mkdtempSync(join(tmpdir(), "mv-corpus-"));
    try {
      for (const c of receipts) {
        const p = join(tmp, `${c.name}.json`);
        writeFileSync(p, JSON.stringify(c.input.receipt));
        const v = await verifyFile(p, { strictHashBinding: true });
        expect({ name: c.name, valid: v.valid }).toEqual({
          name: c.name,
          valid: c.expected.integrity === "verified",
        });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

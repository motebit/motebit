/**
 * `motebit verify receipt` (strict by default) on a sovereign payment receipt
 * produced by the REAL runtime path: payer `requestSovereignReceipt` → hub →
 * payee runtime → `signSovereignPaymentReceipt`. The receipt binds
 * `result_hash` to its own `result` text and reports the paid service's hash
 * (`service_result_hash`).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateKeypair, signExecutionReceipt } from "@motebit/encryption";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
  InMemoryReceiptExchangeHub,
} from "@motebit/runtime";

import { verifyWire } from "../subcommands/verify-wire.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

async function makeRuntime(id: string, hub: InMemoryReceiptExchangeHub): Promise<MotebitRuntime> {
  const kp = await generateKeypair();
  const storage = createInMemoryStorage();
  return new MotebitRuntime(
    {
      motebitId: id,
      tickRateHz: 0,
      signingKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      sovereignReceiptExchange: hub.adapterFor(id),
    },
    {
      storage: { ...storage, agentTrustStore: new InMemoryAgentTrustStore() },
      renderer: new NullRenderer(),
    },
  );
}

let tmp: string;
let hub: InMemoryReceiptExchangeHub;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "motebit-verify-sov-"));
  hub = new InMemoryReceiptExchangeHub();
});
afterEach(() => {
  hub.disconnect("alice");
  hub.disconnect("bob");
  rmSync(tmp, { recursive: true, force: true });
});

describe("motebit verify receipt — sovereign payment receipt (runtime path)", () => {
  it("is OK under the strict default and reports service_result_hash", async () => {
    const alice = await makeRuntime("alice", hub);
    const bob = await makeRuntime("bob", hub);
    const serviceHash = sha256Hex("the service result");
    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "5JxYz",
      amount_micro: 5_000n,
      asset: "USDC",
      payee_address: bob.getSolanaAddress()!,
      service_description: "research query",
      prompt_hash: sha256Hex("q"),
      result_hash: serviceHash,
      tools_used: [],
      submitted_at: 1_713_456_000_000,
      completed_at: 1_713_456_001_000,
    });
    const p = join(tmp, "sovereign.json");
    writeFileSync(p, JSON.stringify(receipt));

    const report = await verifyWire("receipt", p, Date.now());
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    const svc = report.checks.find((c) => c.name === "service_result_hash");
    expect(svc?.ok).toBe(true);
    expect(svc?.detail).toContain(serviceHash);

    // The pre-fix shape (service hash in result_hash) FAILS strict.
    const kp = await generateKeypair();
    const { signature: _s, suite: _u, public_key: _p, service_result_hash: _h, ...body } = receipt;
    const legacy = await signExecutionReceipt(
      { ...body, result_hash: serviceHash },
      kp.privateKey,
      kp.publicKey,
    );
    const lp = join(tmp, "legacy.json");
    writeFileSync(lp, JSON.stringify(legacy));
    const bad = await verifyWire("receipt", lp, Date.now());
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === "result_hash")?.ok).toBe(false);
  });
});

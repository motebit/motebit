/**
 * Sovereign payment receipts bind every hash to the bytes it names.
 *
 * `signSovereignPaymentReceipt` synthesizes the receipt's own `result` text
 * (service description | payer | amount | asset | rail). Its `result_hash`
 * MUST be hex(SHA-256(UTF-8(result))) of that text — the invariant every
 * ExecutionReceipt carries (spec/execution-ledger-v1.md §11.4) — so a strict
 * verifier accepts it. The paid service's own result hash, which the payer
 * supplies, travels in the optional `service_result_hash` field
 * (spec/settlement-v1.md §7).
 *
 * Receipts without `service_result_hash` must sign and verify exactly as
 * before: the golden signature below was minted by the pre-change code.
 */
import { describe, expect, it } from "vitest";

import { canonicalJson, hash, verifyExecutionReceipt, verifyReceipt } from "../index.js";
import { signExecutionReceipt, signSovereignPaymentReceipt } from "../artifacts.js";
import type { SovereignPaymentReceiptInput } from "../artifacts.js";
import { getPublicKeyBySuite } from "../suite-dispatch.js";

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;
const PRIV = new Uint8Array(32).fill(7);
const SERVICE_RESULT_HASH = "b".repeat(64);

const sha256Hex = (s: string): Promise<string> => hash(new TextEncoder().encode(s));

function input(
  overrides: Partial<SovereignPaymentReceiptInput> = {},
): SovereignPaymentReceiptInput {
  return {
    payee_motebit_id: "bob",
    payee_device_id: "d",
    payer_motebit_id: "alice",
    rail: "solana",
    tx_hash: "TX",
    amount_micro: 5_000n,
    asset: "USDC",
    service_description: "svc",
    prompt_hash: "a".repeat(64),
    result_hash: SERVICE_RESULT_HASH,
    submitted_at: 1,
    completed_at: 2,
    ...overrides,
  };
}

describe("signSovereignPaymentReceipt — hash binding", () => {
  it("result_hash is hex(SHA-256(result)) of the receipt's own result text", async () => {
    const pub = await getPublicKeyBySuite(PRIV, SUITE);
    const r = await signSovereignPaymentReceipt(input(), PRIV, pub);
    expect(r.result).toBe("svc | paid by alice: 5000 micro-USDC via solana");
    expect(r.result_hash).toBe(await sha256Hex(r.result));
  });

  it("carries the paid service's result hash in service_result_hash", async () => {
    const pub = await getPublicKeyBySuite(PRIV, SUITE);
    const r = await signSovereignPaymentReceipt(input(), PRIV, pub);
    expect(r.service_result_hash).toBe(SERVICE_RESULT_HASH);
  });

  it("verifies under strict hash binding (and signature-only)", async () => {
    const pub = await getPublicKeyBySuite(PRIV, SUITE);
    const r = await signSovereignPaymentReceipt(input(), PRIV, pub);
    expect(await verifyExecutionReceipt(r, pub)).toBe(true);
    const strict = await verifyReceipt(r, { strictHashBinding: true });
    expect(strict.errors).toBeUndefined();
    expect(strict.valid).toBe(true);
    expect((await verifyReceipt(r)).valid).toBe(true);
  });

  it("service_result_hash is signature-bound and survives a JSON/JCS round trip", async () => {
    const pub = await getPublicKeyBySuite(PRIV, SUITE);
    const r = await signSovereignPaymentReceipt(input(), PRIV, pub);
    const reparsed = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(canonicalJson(reparsed)).toBe(canonicalJson(r));
    expect(canonicalJson(reparsed)).toContain(`"service_result_hash":"${SERVICE_RESULT_HASH}"`);
    expect((await verifyReceipt(reparsed, { strictHashBinding: true })).valid).toBe(true);

    const tampered = { ...reparsed, service_result_hash: "c".repeat(64) };
    expect(await verifyExecutionReceipt(tampered, pub)).toBe(false);
    expect((await verifyReceipt(tampered)).valid).toBe(false);

    const stripped: Record<string, unknown> = { ...reparsed };
    delete stripped.service_result_hash;
    expect(await verifyExecutionReceipt(stripped as typeof r, pub)).toBe(false);
  });

  it("a malformed service_result_hash fails verification even when signed", async () => {
    const pub = await getPublicKeyBySuite(PRIV, SUITE);
    const r = await signExecutionReceipt(
      {
        task_id: "solana:tx:TX",
        motebit_id: "bob",
        device_id: "d",
        submitted_at: 1,
        completed_at: 2,
        status: "completed",
        result: "x",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: await sha256Hex("x"),
        service_result_hash: "NOT-A-HASH",
      },
      PRIV,
      pub,
    );
    expect(await verifyExecutionReceipt(r, pub)).toBe(true); // signature itself is fine
    const v = await verifyReceipt(r);
    expect(v.valid).toBe(false);
    expect(v.errors?.some((e) => e.path === "service_result_hash")).toBe(true);
  });

  it("a receipt whose result_hash does not bind result fails strict", async () => {
    const pub = await getPublicKeyBySuite(PRIV, SUITE);
    const r = await signExecutionReceipt(
      {
        task_id: "solana:tx:TX",
        motebit_id: "bob",
        device_id: "d",
        submitted_at: 1,
        completed_at: 2,
        status: "completed",
        result: "svc | paid by alice: 5000 micro-USDC via solana",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        // the pre-fix shape: the service's hash in result_hash
        result_hash: SERVICE_RESULT_HASH,
      },
      PRIV,
      pub,
    );
    const v = await verifyReceipt(r, { strictHashBinding: true });
    expect(v.valid).toBe(false);
    expect(v.errors?.some((e) => e.path === "result_hash")).toBe(true);
  });
});

describe("receipts without service_result_hash are unchanged", () => {
  it("signs byte-identically to the pre-change code (golden signature)", async () => {
    const pub = await getPublicKeyBySuite(PRIV, SUITE);
    const r = await signExecutionReceipt(
      {
        task_id: "golden-1",
        motebit_id: "m",
        device_id: "d",
        submitted_at: 1,
        completed_at: 2,
        status: "completed",
        result: "hello",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
      PRIV,
      pub,
    );
    expect(r.signature).toBe(
      "QULfQV7qIT9LD0EXCcBmSYz92I9DvpzNhBmFirphDug7oDyil0kRGdDdasFcbDfyCPwfr8yMgk0VbE0J2o8lAw",
    );
    expect("service_result_hash" in r).toBe(false);
    const v = await verifyReceipt(r);
    expect(v.valid).toBe(true);
    expect(v.errors).toBeUndefined();
  });
});

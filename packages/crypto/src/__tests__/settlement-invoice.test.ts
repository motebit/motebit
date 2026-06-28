/**
 * settlement-invoice@1.0 — CostAttestation + Invoice sign/verify.
 *
 * The bill that extends the receipt chain to the money (spec/settlement-invoice-v1.md).
 * Every axis of the two structured verdicts is exercised, including the three that
 * agency.computer's forcing-consumer pass sharpened: the `≤`/floor passthrough law,
 * the `attested_at >= completed_at` temporal commitment (Catch 2), the CostAttestation
 * substitution belt + per-line cost binding (Catch 1), and the stale-cost overstatement
 * axis on a DOWNWARD supersession (Catch 3 — the customer-protection direction).
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  executionReceiptDigest,
  costAttestationDigest,
  signCostAttestation,
  verifyCostAttestation,
  signInvoice,
  verifyInvoice,
} from "../index.js";
import type { CostAttestationV1, InvoiceV1, ExecutionReceipt, DigestRef } from "@motebit/protocol";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const NOW = 1_700_000_000_000;
const ISSUER = "did:motebit:agency";

/** A minimal ExecutionReceipt — only the fields the invoice law reads + a stable shape to digest. */
function makeReceipt(
  taskId: string,
  motebitId = ISSUER,
  completedAt: number = NOW,
): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: motebitId,
    device_id: "dev-1",
    submitted_at: completedAt - 1000,
    completed_at: completedAt,
    status: "completed",
    result: "ok",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  } as unknown as ExecutionReceipt;
}

const dref = (value: string): DigestRef => ({ algorithm: "sha-256", value });

async function attestation(
  kp: Kp,
  receipt: ExecutionReceipt,
  cost_nanos: number,
  over: Partial<CostAttestationV1> = {},
): Promise<CostAttestationV1> {
  return signCostAttestation(
    {
      schema: "motebit.cost-attestation.v1",
      attestation_id: "att-1",
      receipt_id: receipt.task_id,
      receipt_digest: dref(await executionReceiptDigest(receipt)),
      cost_nanos,
      rate_table_id: "agency-rates-v1",
      covers: "recon",
      issuer_id: ISSUER,
      attested_at: NOW + 5000,
      ...over,
    },
    kp.privateKey,
  );
}

async function invoice(
  kp: Kp,
  lines: Array<{ receipt: ExecutionReceipt; att: CostAttestationV1; cost_nanos: number }>,
  over: Partial<InvoiceV1> = {},
): Promise<InvoiceV1> {
  const line_items = await Promise.all(
    lines.map(async (l) => ({
      receipt_id: l.receipt.task_id,
      receipt_digest: dref(await executionReceiptDigest(l.receipt)),
      cost_nanos: l.cost_nanos,
      cost_attestation_digest: dref(await costAttestationDigest(l.att)),
    })),
  );
  const sumNanos = line_items.reduce((s, li) => s + li.cost_nanos, 0);
  const passthrough = Math.floor(sumNanos / 10_000_000);
  const flat = 500;
  return signInvoice(
    {
      schema: "motebit.invoice.v1",
      invoice_id: "inv-1",
      issuer_id: ISSUER,
      customer_ref: "cust-1",
      currency: "USD",
      period_start: NOW,
      period_end: NOW + 86_400_000,
      line_items,
      flat_fee_minor: flat,
      passthrough_cost_minor: passthrough,
      total_minor: flat + passthrough,
      rate_table_id: "agency-rates-v1",
      issued_at: NOW + 10_000,
      ...over,
    },
    kp.privateKey,
  );
}

describe("CostAttestation", () => {
  it("round-trips and verifies all axes against its receipt", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 200_000_000); // $0.20
    const v = await verifyCostAttestation(att, bytesToHex(kp.publicKey), { receipt: r });
    expect(v).toEqual({
      valid: true,
      signature_valid: true,
      cost_positive: true,
      binding: "valid",
      temporal: "valid",
    });
  });

  it("rejects a wrong issuer key, a non-positive cost, and a carried key that mismatches", async () => {
    const kp = await generateKeypair();
    const other = await generateKeypair();
    const r = makeReceipt("t1");

    const att = await attestation(kp, r, 100);
    expect((await verifyCostAttestation(att, bytesToHex(other.publicKey))).signature_valid).toBe(
      false,
    );

    const zero = await attestation(kp, r, 0);
    const vz = await verifyCostAttestation(zero, bytesToHex(kp.publicKey));
    expect(vz.cost_positive).toBe(false);
    expect(vz.valid).toBe(false);

    const carried = await attestation(kp, r, 100, {
      issuer_public_key: bytesToHex(other.publicKey),
    });
    expect((await verifyCostAttestation(carried, bytesToHex(kp.publicKey))).signature_valid).toBe(
      false,
    );
  });

  it("binding fails on the wrong receipt or a mismatched issuer", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 100);

    const wrongReceipt = makeReceipt("t2");
    expect(
      (await verifyCostAttestation(att, bytesToHex(kp.publicKey), { receipt: wrongReceipt }))
        .binding,
    ).toBe("invalid");

    const foreignReceipt = makeReceipt("t1", "did:motebit:someone-else");
    // digest also differs (motebit_id is in the body), so binding is invalid either way.
    expect(
      (await verifyCostAttestation(att, bytesToHex(kp.publicKey), { receipt: foreignReceipt }))
        .binding,
    ).toBe("invalid");
  });

  it("temporal axis (Catch 2): a cost attested BEFORE the work finished is rejected", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1", ISSUER, NOW);
    const early = await attestation(kp, r, 100, { attested_at: NOW - 1 }); // before completed_at
    const v = await verifyCostAttestation(early, bytesToHex(kp.publicKey), { receipt: r });
    expect(v.temporal).toBe("invalid");
    expect(v.valid).toBe(false);
  });
});

describe("Invoice", () => {
  it("round-trips and verifies the MUST axes", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 200_000_000);
    const inv = await invoice(kp, [{ receipt: r, att, cost_nanos: 200_000_000 }]);

    const v = await verifyInvoice(inv, bytesToHex(kp.publicKey), {
      costAttestations: [att],
      receipts: [r],
    });
    expect(v.valid).toBe(true);
    expect(v.signature_valid).toBe(true);
    expect(v.arithmetic).toBe(true);
    expect(v.passthrough_cap).toBe(true);
    expect(v.per_line_binding).toBe("valid");
    expect(v.issuer_consistency).toBe("valid");
  });

  it("passthrough law is ≤/floor: overstatement fails, understatement (discount) passes", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 200_000_000); // $0.20 = 20 cents
    const base = await invoice(kp, [{ receipt: r, att, cost_nanos: 200_000_000 }]);

    // Overstate: claim 21 cents passthrough over a 20-cent cost.
    const over = await invoice(kp, [{ receipt: r, att, cost_nanos: 200_000_000 }], {
      passthrough_cost_minor: 21,
      total_minor: 500 + 21,
    });
    expect((await verifyInvoice(over, bytesToHex(kp.publicKey))).passthrough_cap).toBe(false);

    // Understate (discount): claim 5 cents. Allowed.
    const under = await invoice(kp, [{ receipt: r, att, cost_nanos: 200_000_000 }], {
      passthrough_cost_minor: 5,
      total_minor: 500 + 5,
    });
    expect((await verifyInvoice(under, bytesToHex(kp.publicKey))).passthrough_cap).toBe(true);
    // base sanity
    expect((await verifyInvoice(base, bytesToHex(kp.publicKey))).passthrough_cap).toBe(true);
  });

  it("arithmetic fails when total ≠ flat + passthrough", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 200_000_000);
    const bad = await invoice(kp, [{ receipt: r, att, cost_nanos: 200_000_000 }], {
      total_minor: 999,
    });
    expect((await verifyInvoice(bad, bytesToHex(kp.publicKey))).arithmetic).toBe(false);
  });

  it("per-line binding (Catch 1): a line charging ABOVE its cited attestation is invalid", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 100_000_000); // attested $0.10
    // line claims $0.20 against a $0.10 attestation
    const inv = await invoice(kp, [{ receipt: r, att, cost_nanos: 200_000_000 }]);
    const v = await verifyInvoice(inv, bytesToHex(kp.publicKey), { costAttestations: [att] });
    expect(v.per_line_binding).toBe("invalid");
    expect(v.valid).toBe(false);
  });

  it("issuer-consistency fails on a receipt produced by a different issuer", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 100_000_000);
    const inv = await invoice(kp, [{ receipt: r, att, cost_nanos: 100_000_000 }]);
    const foreign = makeReceipt("t1", "did:motebit:not-the-issuer");
    const v = await verifyInvoice(inv, bytesToHex(kp.publicKey), { receipts: [foreign] });
    expect(v.issuer_consistency).toBe("invalid");
    expect(v.valid).toBe(false);
  });

  it("idempotency is DETECTABLE across held invoices (not enforced)", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 100_000_000);
    const a = await invoice(kp, [{ receipt: r, att, cost_nanos: 100_000_000 }], {
      invoice_id: "inv-A",
    });
    const b = await invoice(kp, [{ receipt: r, att, cost_nanos: 100_000_000 }], {
      invoice_id: "inv-B",
    });
    const v = await verifyInvoice(a, bytesToHex(kp.publicKey), { otherInvoices: [b] });
    expect(v.idempotency).toBe("duplicate_detected");
    // detectable, not gating: the invoice itself is still structurally valid.
    expect(v.valid).toBe(true);
  });

  it("stale-cost overstatement (Catch 3): a DOWNWARD supersession surfaces, detectable not silent", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    const att = await attestation(kp, r, 100_000_000); // cited cost $0.10 = 10 cents
    const inv = await invoice(kp, [{ receipt: r, att, cost_nanos: 100_000_000 }]); // passthrough = 10 cents

    // A' supersedes A downward — the TRUE cost was $0.05 (5 cents). The customer was overcharged.
    const cheaper = await attestation(kp, r, 50_000_000, {
      attestation_id: "att-2",
      attested_at: NOW + 9000,
    });
    const latest = new Map([[r.task_id, cheaper]]);

    const v = await verifyInvoice(inv, bytesToHex(kp.publicKey), {
      costAttestations: [att],
      latestCostAttestations: latest,
    });
    expect(v.per_line_binding).toBe("valid"); // still valid against the CITED attestation
    expect(v.stale_cost_overstatement).toBe("detected"); // but the latest cost is lower — surfaced
    // detectable, not gating — whether a correction forces re-issue is consumer policy.
    expect(v.valid).toBe(true);

    // And when the latest cost still covers the bill, no overstatement.
    const same = new Map([[r.task_id, att]]);
    expect(
      (await verifyInvoice(inv, bytesToHex(kp.publicKey), { latestCostAttestations: same }))
        .stale_cost_overstatement,
    ).toBe("none");
  });
});

describe("digest helpers are reproducible", () => {
  it("the same artifact always digests the same; a changed field changes it", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt("t1");
    expect(await executionReceiptDigest(r)).toBe(await executionReceiptDigest(makeReceipt("t1")));
    expect(await executionReceiptDigest(r)).not.toBe(
      await executionReceiptDigest(makeReceipt("t2")),
    );

    const att = await attestation(kp, r, 100);
    expect(await costAttestationDigest(att)).toBe(await costAttestationDigest(att));
  });
});

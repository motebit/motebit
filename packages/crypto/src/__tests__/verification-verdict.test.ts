/**
 * VerificationVerdict — receipt-path conformance (Phase A.2.1).
 *
 * The executable corpus for the receipt path of the VerificationVerdict arc
 * (docs/doctrine/verify-family-fail-closed.md). Each case mints a REAL signed
 * receipt and asserts the EXACT structured verdict — the contract a second
 * implementation (consumer #2) must reproduce byte-for-byte. The
 * token/grant/revocation-path fixtures (revoked-tick-self-mint, clock-rollback)
 * land with the authority/revocation producer in the next increment.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  signExecutionReceipt,
  deriveSovereignMotebitId,
  bytesToHex,
  verifyReceiptVerdict,
  isFullyVerified,
  type SignableReceipt,
  type VerificationVerdict,
} from "../index.js";

function makeReceipt(
  overrides: Partial<Omit<SignableReceipt, "signature" | "suite">> = {},
): Omit<SignableReceipt, "signature" | "suite"> {
  return {
    task_id: "task-001",
    motebit_id: "mote-alice",
    device_id: "device-001",
    submitted_at: 1700000000000,
    completed_at: 1700000060000,
    status: "completed",
    result: "Task completed successfully",
    tools_used: ["web_search"],
    memories_formed: 1,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    ...overrides,
  };
}

describe("verifyReceiptVerdict — receipt-path conformance", () => {
  it("FIXTURE: sovereign-but-not-pinned receipt → integrity verified, binding sovereign, nothing manufactured", async () => {
    const kp = await generateKeypair();
    const pubHex = bytesToHex(kp.publicKey);
    const sovereignId = await deriveSovereignMotebitId(pubHex);
    const receipt = await signExecutionReceipt(
      makeReceipt({ motebit_id: sovereignId }),
      kp.privateKey,
      kp.publicKey,
    );

    const v = await verifyReceiptVerdict(receipt);

    // The full verdict is the contract — assert it exactly.
    expect(v).toEqual({
      type: "receipt",
      integrity: "verified",
      identityBinding: "sovereign", // emphatically NOT "pinned" — the rung doing its job
      authority: "unknown", // a bare receipt has no authority dimension — not manufactured "valid"
      revocation: { status: "unchecked" }, // no grant context — not manufactured "fresh"
      temporalBasis: "clockless", // no temporal check runs on a plain receipt
      evidenceBasis: [
        { kind: "public_key", ref: pubHex },
        { kind: "receipt", ref: receipt.result_hash },
      ],
    });
    expect(v.repair).toBeUndefined();

    // Fail-closed collapse: a real signed sovereign receipt is NOT "fully
    // verified" — authority unknown + revocation unchecked. A consumer wanting
    // "a real receipt" branches integrity + identityBinding, not this boolean.
    expect(isFullyVerified(v)).toBe(false);
  });

  it("a consumer pinning a known agent branches identityBinding === 'pinned'; sovereign fails that branch without failing integrity", async () => {
    const kp = await generateKeypair();
    const pubHex = bytesToHex(kp.publicKey);
    const sovereignId = await deriveSovereignMotebitId(pubHex);
    const receipt = await signExecutionReceipt(
      makeReceipt({ motebit_id: sovereignId }),
      kp.privateKey,
      kp.publicKey,
    );
    const v = await verifyReceiptVerdict(receipt);
    expect(v.integrity).toBe("verified");
    expect(v.identityBinding === "pinned").toBe(false); // not the pinned agent
    expect(v.identityBinding).toBe("sovereign"); // but a real signed receipt from someone
  });

  it("tampered receipt → integrity invalid + integrity repair", async () => {
    const kp = await generateKeypair();
    const receipt = await signExecutionReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    const tampered: SignableReceipt = { ...receipt, result_hash: "c".repeat(64) };

    const v = await verifyReceiptVerdict(tampered);
    expect(v.integrity).toBe("invalid");
    expect(v.repair?.axis).toBe("integrity");
    expect(v.repair?.code).toBe("integrity.signature_invalid");
    expect(v.repair?.fix).toMatch(/re-fetch/i);
    expect(isFullyVerified(v)).toBe(false);
  });

  it("embedded-key-only receipt whose id does NOT commit to the key → integrity verified, binding unverified + repair", async () => {
    const kp = await generateKeypair();
    const receipt = await signExecutionReceipt(
      makeReceipt({ motebit_id: "mote-not-sovereign" }),
      kp.privateKey,
      kp.publicKey,
    );
    const v = await verifyReceiptVerdict(receipt);
    expect(v.integrity).toBe("verified"); // the bytes sign
    expect(v.identityBinding).toBe("unverified"); // but key→id is NOT established — the footgun, named
    expect(v.repair?.code).toBe("identity.binding_unverified");
    expect(isFullyVerified(v)).toBe(false);
  });

  it("receipt with no embedded public_key → integrity invalid (cannot verify), no-key repair", async () => {
    const kp = await generateKeypair();
    const receipt = await signExecutionReceipt(makeReceipt(), kp.privateKey); // no publicKey arg
    const v = await verifyReceiptVerdict(receipt);
    expect(v.integrity).toBe("invalid");
    expect(v.repair?.axis).toBe("integrity");
    expect(v.repair?.summary).toMatch(/no usable embedded public_key/i);
  });

  it("receipt with a malformed public_key → integrity invalid (decode fails fail-closed)", async () => {
    const kp = await generateKeypair();
    const receipt = await signExecutionReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    const bogus: SignableReceipt = { ...receipt, public_key: "zz" };
    const v = await verifyReceiptVerdict(bogus);
    expect(v.integrity).toBe("invalid");
  });
});

describe("isFullyVerified — fail-closed collapse", () => {
  const allGood: VerificationVerdict = {
    type: "receipt",
    integrity: "verified",
    identityBinding: "sovereign",
    authority: "valid",
    revocation: { status: "fresh" },
    temporalBasis: "clockless",
    evidenceBasis: [],
  };

  it("true only when every load-bearing axis passes", () => {
    expect(isFullyVerified(allGood)).toBe(true);
    expect(isFullyVerified({ ...allGood, identityBinding: "anchored" })).toBe(true);
    expect(isFullyVerified({ ...allGood, identityBinding: "pinned" })).toBe(true);
  });

  it("any non-passing load-bearing axis → false (never a silent true)", () => {
    expect(isFullyVerified({ ...allGood, integrity: "invalid" })).toBe(false);
    expect(isFullyVerified({ ...allGood, identityBinding: "unverified" })).toBe(false);
    expect(isFullyVerified({ ...allGood, identityBinding: "invalid" })).toBe(false);
    expect(isFullyVerified({ ...allGood, authority: "unknown" })).toBe(false);
    expect(isFullyVerified({ ...allGood, authority: "expired" })).toBe(false);
    expect(isFullyVerified({ ...allGood, revocation: { status: "unchecked" } })).toBe(false);
    expect(isFullyVerified({ ...allGood, revocation: { status: "stale" } })).toBe(false);
    expect(isFullyVerified({ ...allGood, revocation: { status: "revoked" } })).toBe(false);
  });
});

/**
 * VerificationVerdict — receipt-path conformance (Phase A.2.1).
 *
 * The executable corpus for the receipt path of the VerificationVerdict arc
 * (docs/doctrine/verify-family-fail-closed.md). Each case mints a REAL signed
 * receipt and asserts the EXACT structured verdict — the contract a second
 * implementation (consumer #2) must reproduce.
 *
 * integrity folds BOTH the Ed25519 signature AND strict hash binding
 * (result_hash == hex(SHA-256(result))): a valid signature over a
 * hash-inconsistent receipt is a silent-true this reshape kills. Surfaced by
 * consumer #2's parity run (their verifyReceipt enforces strict binding as
 * load-bearing doctrine). So valid receipts carry REAL digests, and a
 * signed-but-hash-inconsistent receipt is its own integrity:"invalid".
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  signExecutionReceipt,
  deriveSovereignMotebitId,
  bytesToHex,
  hash,
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
    result_hash: "b".repeat(64), // overwritten by mintValid with the real digest
    ...overrides,
  };
}

/** Mint a receipt whose result_hash is the REAL hex(SHA-256(result)) — strict-binding-clean. */
async function mintValid(
  kp: Awaited<ReturnType<typeof generateKeypair>>,
  overrides: Partial<Omit<SignableReceipt, "signature" | "suite">> = {},
): Promise<SignableReceipt> {
  const base = makeReceipt(overrides);
  const result_hash = await hash(new TextEncoder().encode(base.result));
  return signExecutionReceipt({ ...base, result_hash }, kp.privateKey, kp.publicKey);
}

describe("verifyReceiptVerdict — receipt-path conformance", () => {
  it("FIXTURE: sovereign-but-not-pinned receipt → integrity verified, binding sovereign, nothing manufactured", async () => {
    const kp = await generateKeypair();
    const pubHex = bytesToHex(kp.publicKey);
    const sovereignId = await deriveSovereignMotebitId(pubHex);
    const receipt = await mintValid(kp, { motebit_id: sovereignId });

    const v = await verifyReceiptVerdict(receipt);

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
    expect(isFullyVerified(v)).toBe(false);
  });

  it("a consumer pinning a known agent branches identityBinding === 'pinned'; sovereign fails that branch without failing integrity", async () => {
    const kp = await generateKeypair();
    const pubHex = bytesToHex(kp.publicKey);
    const sovereignId = await deriveSovereignMotebitId(pubHex);
    const v = await verifyReceiptVerdict(await mintValid(kp, { motebit_id: sovereignId }));
    expect(v.integrity).toBe("verified");
    expect(v.identityBinding === "pinned").toBe(false); // not the pinned agent
    expect(v.identityBinding).toBe("sovereign"); // but a real signed receipt from someone
  });

  it("tampered receipt (result_hash changed after signing) → integrity invalid, signature_invalid repair", async () => {
    const kp = await generateKeypair();
    const receipt = await mintValid(kp);
    const tampered: SignableReceipt = { ...receipt, result_hash: "c".repeat(64) };

    const v = await verifyReceiptVerdict(tampered);
    expect(v.integrity).toBe("invalid");
    expect(v.repair?.code).toBe("integrity.signature_invalid"); // tamper breaks the SIGNATURE
    expect(isFullyVerified(v)).toBe(false);
  });

  it("signed-but-hash-inconsistent receipt → integrity invalid, hash_inconsistent repair (a valid sig over a lie)", async () => {
    const kp = await generateKeypair();
    // Sign a receipt whose result_hash deliberately does NOT bind `result`. The
    // signature is VALID (the signer signed these exact bytes), but result_hash
    // commits to different content. This is the silent-true integrity must catch.
    const receipt = await signExecutionReceipt(
      { ...makeReceipt(), result_hash: "d".repeat(64) },
      kp.privateKey,
      kp.publicKey,
    );
    const v = await verifyReceiptVerdict(receipt);
    expect(v.integrity).toBe("invalid");
    expect(v.repair?.code).toBe("integrity.hash_inconsistent");
    expect(v.repair?.fix).toMatch(/result_hash MUST equal/i);
    expect(isFullyVerified(v)).toBe(false);
  });

  it("embedded-key-only receipt whose id does NOT commit to the key → integrity verified, binding unverified + repair", async () => {
    const kp = await generateKeypair();
    const v = await verifyReceiptVerdict(await mintValid(kp, { motebit_id: "mote-not-sovereign" }));
    expect(v.integrity).toBe("verified"); // the bytes sign and the hash binds
    expect(v.identityBinding).toBe("unverified"); // but key→id is NOT established — the footgun, named
    expect(v.repair?.code).toBe("identity.binding_unverified");
    expect(isFullyVerified(v)).toBe(false);
  });

  it("receipt with no embedded public_key → integrity invalid (cannot verify), no_key repair", async () => {
    const kp = await generateKeypair();
    const base = makeReceipt();
    const result_hash = await hash(new TextEncoder().encode(base.result));
    const receipt = await signExecutionReceipt({ ...base, result_hash }, kp.privateKey); // no publicKey arg
    const v = await verifyReceiptVerdict(receipt);
    expect(v.integrity).toBe("invalid");
    expect(v.repair?.code).toBe("integrity.no_key");
    expect(v.repair?.summary).toMatch(/no usable embedded public_key/i);
  });

  it("receipt with a malformed public_key → integrity invalid (decode fails fail-closed)", async () => {
    const kp = await generateKeypair();
    const receipt = await mintValid(kp);
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

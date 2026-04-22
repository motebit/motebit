/**
 * Tests extracted from @motebit/encryption to exercise @motebit/crypto
 * functions directly for coverage attribution.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  ed25519Sign,
  ed25519Verify,
  createSignedToken,
  verifySignedToken,
  signExecutionReceipt,
  verifyExecutionReceipt,
  signToolInvocationReceipt,
  verifyToolInvocationReceipt,
  hashToolPayload,
  signSettlement,
  verifySettlement,
  signBalanceWaiver,
  verifyBalanceWaiver,
  signConsolidationReceipt,
  verifyConsolidationReceipt,
  signAdjudicatorVote,
  verifyAdjudicatorVote,
  signDisputeResolution,
  verifyDisputeResolution,
  signDisputeRequest,
  verifyDisputeRequest,
  signDisputeEvidence,
  verifyDisputeEvidence,
  signDisputeAppeal,
  verifyDisputeAppeal,
  signSovereignPaymentReceipt,
  verifyReceiptChain,
  signKeySuccession,
  verifyKeySuccession,
  signGuardianRecoverySuccession,
  signGuardianRevocation,
  verifyGuardianRevocation,
  verifySuccessionChain,
  didKeyToPublicKey,
  publicKeyToDidKey,
  hexPublicKeyToDidKey,
  base58btcEncode,
  hexToBytes,
  bytesToHex,
  hash,
  type SignedTokenPayload,
  type SignableReceipt,
  type SignableToolInvocationReceipt,
  type KnownKeys,
} from "../index.js";

// ---------------------------------------------------------------------------
// hash()
// ---------------------------------------------------------------------------

describe("hash", () => {
  it("produces a hex string of 64 characters (SHA-256)", async () => {
    const data = new TextEncoder().encode("test data");
    const result = await hash(data);
    expect(typeof result).toBe("string");
    expect(result.length).toBe(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it("produces consistent output for the same input", async () => {
    const data = new TextEncoder().encode("hello");
    const a = await hash(data);
    const b = await hash(data);
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", async () => {
    const a = await hash(new TextEncoder().encode("input-a"));
    const b = await hash(new TextEncoder().encode("input-b"));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Ed25519: generateKeypair()
// ---------------------------------------------------------------------------

describe("generateKeypair", () => {
  it("returns 32-byte keys", async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("generates different keypairs on successive calls", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.publicKey).not.toEqual(b.publicKey);
    expect(a.privateKey).not.toEqual(b.privateKey);
  });
});

// ---------------------------------------------------------------------------
// Ed25519: ed25519Sign() / ed25519Verify()
// ---------------------------------------------------------------------------

describe("ed25519Sign and ed25519Verify", () => {
  it("round-trips correctly", async () => {
    const kp = await generateKeypair();
    const message = new TextEncoder().encode("Hello, Ed25519!");
    const sig = await ed25519Sign(message, kp.privateKey);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    const valid = await ed25519Verify(sig, message, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("rejects tampered message", async () => {
    const kp = await generateKeypair();
    const message = new TextEncoder().encode("Original message");
    const sig = await ed25519Sign(message, kp.privateKey);
    const tampered = new TextEncoder().encode("Tampered message");
    const valid = await ed25519Verify(sig, tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects signature verified with wrong public key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const message = new TextEncoder().encode("test");
    const sig = await ed25519Sign(message, kpA.privateKey);
    const valid = await ed25519Verify(sig, message, kpB.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signed Tokens
// ---------------------------------------------------------------------------

describe("createSignedToken / verifySignedToken", () => {
  it("round-trips correctly", async () => {
    const kp = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: "sync",
    };
    const token = await createSignedToken(payload, kp.privateKey);
    expect(typeof token).toBe("string");
    expect(token).toContain(".");

    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).not.toBeNull();
    expect(result!.mid).toBe("mote-123");
    expect(result!.did).toBe("device-456");
    expect(result!.aud).toBe("sync");
  });

  it("round-trips with audience claim preserved", async () => {
    const kp = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: "task:submit",
    };
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).not.toBeNull();
    expect(result!.aud).toBe("task:submit");
  });

  it("rejects tokens without audience binding (cross-endpoint replay prevention)", async () => {
    const kp = await generateKeypair();
    // Intentionally omit aud to test runtime guard against malformed payloads
    const payload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
    } as SignedTokenPayload;
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });

  it("rejects expired token", async () => {
    const kp = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now() - 10 * 60 * 1000,
      exp: Date.now() - 1, // Already expired
      jti: crypto.randomUUID(),
      aud: "sync",
    };
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });

  it("rejects invalid signature (wrong key)", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: "sync",
    };
    const token = await createSignedToken(payload, kpA.privateKey);
    const result = await verifySignedToken(token, kpB.publicKey);
    expect(result).toBeNull();
  });

  it("rejects malformed token (no dot)", async () => {
    const kp = await generateKeypair();
    const result = await verifySignedToken("nodothere", kp.publicKey);
    expect(result).toBeNull();
  });

  it("rejects token without jti (replay attack protection)", async () => {
    const kp = await generateKeypair();
    // Intentionally omit jti and aud to test runtime guard against malformed payloads
    const payload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
    } as SignedTokenPayload;
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Execution Receipt Signing
// ---------------------------------------------------------------------------

describe("signExecutionReceipt / verifyExecutionReceipt", () => {
  function makeReceipt(): Omit<SignableReceipt, "signature" | "suite"> {
    return {
      task_id: "task-001",
      motebit_id: "mote-123",
      device_id: "device-456",
      submitted_at: 1700000000000,
      completed_at: 1700000060000,
      status: "completed",
      result: "Task completed successfully",
      tools_used: ["search", "calculate"],
      memories_formed: 2,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
    };
  }

  it("round-trips correctly (sign -> verify = true)", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed.signature).toBeTruthy();
    expect(signed.task_id).toBe("task-001");

    const valid = await verifyExecutionReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("detects tampering (modify result -> verify = false)", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    const tampered: SignableReceipt = { ...signed, result: "TAMPERED" };
    const valid = await verifyExecutionReceipt(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kpA.privateKey);

    const valid = await verifyExecutionReceipt(signed, kpB.publicKey);
    expect(valid).toBe(false);
  });

  it("is deterministic (same receipt -> same signature)", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed1 = await signExecutionReceipt(receipt, kp.privateKey);
    const signed2 = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed1.signature).toBe(signed2.signature);
  });

  it("round-trips with delegation_receipts present", async () => {
    const kp = await generateKeypair();
    const delegationReceipt: SignableReceipt = {
      ...makeReceipt(),
      task_id: "delegated-001",
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: "delegate-sig",
    };
    const receipt = {
      ...makeReceipt(),
      delegation_receipts: [delegationReceipt],
    };
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed.delegation_receipts).toHaveLength(1);
    expect(signed.delegation_receipts![0]!.task_id).toBe("delegated-001");

    const valid = await verifyExecutionReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("backward compat: receipt without delegation_receipts still verifies", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt(); // no delegation_receipts field
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed.delegation_receipts).toBeUndefined();
    const valid = await verifyExecutionReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signToolInvocationReceipt / verifyToolInvocationReceipt
// ---------------------------------------------------------------------------

describe("signToolInvocationReceipt / verifyToolInvocationReceipt", () => {
  function makeInvocation(): Omit<SignableToolInvocationReceipt, "signature" | "suite"> {
    return {
      invocation_id: "inv-001",
      task_id: "task-001",
      motebit_id: "mote-123",
      device_id: "device-456",
      tool_name: "read_url",
      started_at: 1700000000000,
      completed_at: 1700000001500,
      status: "completed",
      args_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
    };
  }

  it("round-trips (sign -> verify = true)", async () => {
    const kp = await generateKeypair();
    const signed = await signToolInvocationReceipt(makeInvocation(), kp.privateKey);

    expect(signed.signature).toBeTruthy();
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(signed.tool_name).toBe("read_url");

    const valid = await verifyToolInvocationReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("detects tampering on tool_name", async () => {
    const kp = await generateKeypair();
    const signed = await signToolInvocationReceipt(makeInvocation(), kp.privateKey);

    const tampered: SignableToolInvocationReceipt = { ...signed, tool_name: "shell_exec" };
    const valid = await verifyToolInvocationReceipt(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("detects tampering on result_hash", async () => {
    const kp = await generateKeypair();
    const signed = await signToolInvocationReceipt(makeInvocation(), kp.privateKey);

    const tampered: SignableToolInvocationReceipt = { ...signed, result_hash: "c".repeat(64) };
    const valid = await verifyToolInvocationReceipt(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("detects tampering on invocation_origin", async () => {
    const kp = await generateKeypair();
    const signed = await signToolInvocationReceipt(
      { ...makeInvocation(), invocation_origin: "user-tap" },
      kp.privateKey,
    );

    const tampered: SignableToolInvocationReceipt = { ...signed, invocation_origin: "ai-loop" };
    const valid = await verifyToolInvocationReceipt(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const signed = await signToolInvocationReceipt(makeInvocation(), kpA.privateKey);

    const valid = await verifyToolInvocationReceipt(signed, kpB.publicKey);
    expect(valid).toBe(false);
  });

  it("is deterministic (same inputs -> same signature)", async () => {
    const kp = await generateKeypair();
    const a = await signToolInvocationReceipt(makeInvocation(), kp.privateKey);
    const b = await signToolInvocationReceipt(makeInvocation(), kp.privateKey);
    expect(a.signature).toBe(b.signature);
  });

  it("embeds the public key (hex) when provided", async () => {
    const kp = await generateKeypair();
    const signed = await signToolInvocationReceipt(makeInvocation(), kp.privateKey, kp.publicKey);

    expect(signed.public_key).toBeTruthy();
    expect(signed.public_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on unknown suite", async () => {
    const kp = await generateKeypair();
    const signed = await signToolInvocationReceipt(makeInvocation(), kp.privateKey);

    const bogus = {
      ...signed,
      suite: "bogus-suite-v0",
    } as unknown as SignableToolInvocationReceipt;
    const valid = await verifyToolInvocationReceipt(bogus, kp.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hashToolPayload — canonical SHA-256 of an args/result payload
// ---------------------------------------------------------------------------

describe("hashToolPayload", () => {
  it("returns a 64-char hex string for object inputs", async () => {
    const h = await hashToolPayload({ url: "https://motebit.com" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across key ordering (JCS canonicalization)", async () => {
    const a = await hashToolPayload({ url: "https://motebit.com", method: "GET" });
    const b = await hashToolPayload({ method: "GET", url: "https://motebit.com" });
    expect(a).toBe(b);
  });

  it("differs when payload content differs", async () => {
    const a = await hashToolPayload({ url: "https://motebit.com" });
    const b = await hashToolPayload({ url: "https://example.com" });
    expect(a).not.toBe(b);
  });

  it("handles scalar string payloads", async () => {
    const h = await hashToolPayload("plain result text");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// signSettlement / verifySettlement
// ---------------------------------------------------------------------------

describe("signSettlement / verifySettlement", () => {
  function makeSettlement() {
    return {
      settlement_id: "settle-001" as never,
      allocation_id: "alloc-001" as never,
      receipt_hash: "a".repeat(64),
      ledger_hash: null,
      amount_settled: 950_000,
      platform_fee: 50_000,
      platform_fee_rate: 0.05,
      status: "completed" as const,
      settled_at: 1_700_000_000_000,
      issuer_relay_id: "relay-001",
    };
  }

  it("round-trips correctly (sign -> verify = true)", async () => {
    const kp = await generateKeypair();
    const signed = await signSettlement(makeSettlement(), kp.privateKey);
    expect(signed.signature).toBeTruthy();
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    const valid = await verifySettlement(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("detects amount tampering — relay cannot rewrite settlement amounts", async () => {
    const kp = await generateKeypair();
    const signed = await signSettlement(makeSettlement(), kp.privateKey);
    const tampered = { ...signed, amount_settled: 9_999_999 };
    const valid = await verifySettlement(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("detects fee_rate tampering — relay cannot retroactively change its declared fee", async () => {
    const kp = await generateKeypair();
    const signed = await signSettlement(makeSettlement(), kp.privateKey);
    const tampered = { ...signed, platform_fee_rate: 0.5 };
    const valid = await verifySettlement(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const signed = await signSettlement(makeSettlement(), kpA.privateKey);
    const valid = await verifySettlement(signed, kpB.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects unknown suite (no legacy-no-suite path)", async () => {
    const kp = await generateKeypair();
    const signed = await signSettlement(makeSettlement(), kp.privateKey);
    const wrongSuite = { ...signed, suite: "motebit-future-pqc-v7" as never };
    const valid = await verifySettlement(wrongSuite, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("is deterministic (same record -> same signature)", async () => {
    const kp = await generateKeypair();
    const r = makeSettlement();
    const a = await signSettlement(r, kp.privateKey);
    const b = await signSettlement(r, kp.privateKey);
    expect(a.signature).toBe(b.signature);
  });
});

// ---------------------------------------------------------------------------
// signBalanceWaiver / verifyBalanceWaiver
// ---------------------------------------------------------------------------

describe("signBalanceWaiver / verifyBalanceWaiver", () => {
  function makeWaiver() {
    return {
      motebit_id: "mote-departing",
      waived_amount: 1_234_567,
      waived_at: 1_700_000_000_000,
    };
  }

  it("round-trips (sign -> verify = true) and stamps suite", async () => {
    const kp = await generateKeypair();
    const signed = await signBalanceWaiver(makeWaiver(), kp.privateKey);
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(signed.signature).toBeTruthy();
    expect(await verifyBalanceWaiver(signed, kp.publicKey)).toBe(true);
  });

  it("detects waived_amount tampering — a verifier cannot silently inflate the forfeit", async () => {
    const kp = await generateKeypair();
    const signed = await signBalanceWaiver(makeWaiver(), kp.privateKey);
    const tampered = { ...signed, waived_amount: 9_999_999 };
    expect(await verifyBalanceWaiver(tampered, kp.publicKey)).toBe(false);
  });

  it("detects motebit_id tampering — a waiver cannot be reattributed to another agent", async () => {
    const kp = await generateKeypair();
    const signed = await signBalanceWaiver(makeWaiver(), kp.privateKey);
    const tampered = { ...signed, motebit_id: "mote-impostor" };
    expect(await verifyBalanceWaiver(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const signed = await signBalanceWaiver(makeWaiver(), kpA.privateKey);
    expect(await verifyBalanceWaiver(signed, kpB.publicKey)).toBe(false);
  });

  it("rejects unknown suite (no legacy-no-suite path)", async () => {
    const kp = await generateKeypair();
    const signed = await signBalanceWaiver(makeWaiver(), kp.privateKey);
    const wrongSuite = { ...signed, suite: "motebit-future-pqc-v7" as never };
    expect(await verifyBalanceWaiver(wrongSuite, kp.publicKey)).toBe(false);
  });

  it("rejects malformed base64url signature", async () => {
    const kp = await generateKeypair();
    const signed = await signBalanceWaiver(makeWaiver(), kp.privateKey);
    const garbage = { ...signed, signature: "!!!not-base64url!!!" };
    expect(await verifyBalanceWaiver(garbage, kp.publicKey)).toBe(false);
  });

  it("is deterministic (same body -> same signature)", async () => {
    const kp = await generateKeypair();
    const w = makeWaiver();
    const a = await signBalanceWaiver(w, kp.privateKey);
    const b = await signBalanceWaiver(w, kp.privateKey);
    expect(a.signature).toBe(b.signature);
  });
});

// ---------------------------------------------------------------------------
// signConsolidationReceipt / verifyConsolidationReceipt
// ---------------------------------------------------------------------------

describe("signConsolidationReceipt / verifyConsolidationReceipt", () => {
  function makeReceipt() {
    return {
      receipt_id: "00000000-0000-4000-8000-000000000001",
      motebit_id: "mote-tending",
      cycle_id: "cycle-abc-123",
      started_at: 1_700_000_000_000,
      finished_at: 1_700_000_005_000,
      phases_run: ["orient", "gather", "consolidate", "prune"] as const,
      phases_yielded: [] as ReadonlyArray<"orient" | "gather" | "consolidate" | "prune">,
      summary: {
        orient_nodes: 42,
        gather_clusters: 3,
        gather_notable: 5,
        consolidate_merged: 2,
        pruned_decay: 7,
        pruned_notability: 1,
        pruned_retention: 0,
      },
    };
  }

  it("round-trips (sign -> verify = true) and stamps suite", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(signed.signature).toBeTruthy();
    expect(signed.public_key).toBeTruthy();
    expect(await verifyConsolidationReceipt(signed, kp.publicKey)).toBe(true);
  });

  it("verifies without an embedded public key when caller provides it", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey);
    expect(signed.public_key).toBeUndefined();
    expect(await verifyConsolidationReceipt(signed, kp.publicKey)).toBe(true);
  });

  it("detects summary tampering — a verifier cannot silently inflate consolidation work", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    const tampered = {
      ...signed,
      summary: { ...signed.summary, consolidate_merged: 99 },
    };
    expect(await verifyConsolidationReceipt(tampered, kp.publicKey)).toBe(false);
  });

  it("detects motebit_id tampering — receipt cannot be reattributed", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    const tampered = { ...signed, motebit_id: "mote-impostor" };
    expect(await verifyConsolidationReceipt(tampered, kp.publicKey)).toBe(false);
  });

  it("detects cycle_id tampering — receipt cannot be re-bound to a different cycle", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    const tampered = { ...signed, cycle_id: "cycle-someone-elses" };
    expect(await verifyConsolidationReceipt(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kpA.privateKey, kpA.publicKey);
    expect(await verifyConsolidationReceipt(signed, kpB.publicKey)).toBe(false);
  });

  it("rejects unknown suite (no legacy-no-suite path)", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    const wrongSuite = { ...signed, suite: "motebit-future-pqc-v7" as never };
    expect(await verifyConsolidationReceipt(wrongSuite, kp.publicKey)).toBe(false);
  });

  it("rejects malformed base64url signature", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    const garbage = { ...signed, signature: "!!!not-base64url!!!" };
    expect(await verifyConsolidationReceipt(garbage, kp.publicKey)).toBe(false);
  });

  it("is deterministic (same body -> same signature)", async () => {
    const kp = await generateKeypair();
    const r = makeReceipt();
    const a = await signConsolidationReceipt(r, kp.privateKey, kp.publicKey);
    const b = await signConsolidationReceipt(r, kp.privateKey, kp.publicKey);
    expect(a.signature).toBe(b.signature);
  });

  it("frozen — post-sign mutation throws", async () => {
    const kp = await generateKeypair();
    const signed = await signConsolidationReceipt(makeReceipt(), kp.privateKey, kp.publicKey);
    expect(() => {
      (signed as unknown as { motebit_id: string }).motebit_id = "mote-mutated";
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// signAdjudicatorVote / verifyAdjudicatorVote  (dispute-v1 §6.4 + §6.5)
// ---------------------------------------------------------------------------

describe("signAdjudicatorVote / verifyAdjudicatorVote", () => {
  function makeVote(overrides?: { dispute_id?: string; peer_id?: string }) {
    return {
      dispute_id: overrides?.dispute_id ?? "dispute-alpha",
      peer_id: overrides?.peer_id ?? "peer-one",
      vote: "upheld" as const,
      rationale: "Evidence favors the filing party.",
    };
  }

  it("round-trips and stamps suite", async () => {
    const kp = await generateKeypair();
    const signed = await signAdjudicatorVote(makeVote(), kp.privateKey);
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(signed.signature).toBeTruthy();
    expect(await verifyAdjudicatorVote(signed, kp.publicKey)).toBe(true);
  });

  // The foundation-law invariant: §6.5 says "Each AdjudicatorVote
  // signature MUST cover its dispute_id. Votes are not portable across
  // disputes." If a vote signed for dispute A verifies when attached to
  // dispute B, the binding is broken.
  it("signature binds to dispute_id — vote for dispute A fails against dispute B's bytes (§6.5)", async () => {
    const kp = await generateKeypair();
    const voteForA = await signAdjudicatorVote(
      makeVote({ dispute_id: "dispute-A" }),
      kp.privateKey,
    );
    const reattributedToB = { ...voteForA, dispute_id: "dispute-B" };
    expect(await verifyAdjudicatorVote(reattributedToB, kp.publicKey)).toBe(false);
  });

  it("detects vote-outcome tampering", async () => {
    const kp = await generateKeypair();
    const signed = await signAdjudicatorVote(makeVote(), kp.privateKey);
    const flipped = { ...signed, vote: "overturned" as const };
    expect(await verifyAdjudicatorVote(flipped, kp.publicKey)).toBe(false);
  });

  it("rejects wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const signed = await signAdjudicatorVote(makeVote(), kpA.privateKey);
    expect(await verifyAdjudicatorVote(signed, kpB.publicKey)).toBe(false);
  });

  it("rejects unknown suite (no legacy-no-suite path)", async () => {
    const kp = await generateKeypair();
    const signed = await signAdjudicatorVote(makeVote(), kp.privateKey);
    const wrongSuite = { ...signed, suite: "motebit-future-pqc-v7" as never };
    expect(await verifyAdjudicatorVote(wrongSuite, kp.publicKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// signDisputeResolution / verifyDisputeResolution  (dispute-v1 §6.4 + §6.5)
// ---------------------------------------------------------------------------

describe("signDisputeResolution / verifyDisputeResolution", () => {
  function makeResolution(overrides?: {
    dispute_id?: string;
    adjudicator?: string;
    adjudicator_votes?: Parameters<typeof signAdjudicatorVote>[0][];
  }) {
    return {
      dispute_id: overrides?.dispute_id ?? "dispute-alpha",
      resolution: "upheld" as const,
      rationale: "Both parties presented evidence; the filing party's claim is substantiated.",
      fund_action: "release_to_worker" as const,
      split_ratio: 1,
      adjudicator: overrides?.adjudicator ?? "relay-1",
      adjudicator_votes: [],
      resolved_at: 1_700_000_000_000,
    };
  }

  it("single-relay resolution: no votes, outer signature verifies", async () => {
    const relayKp = await generateKeypair();
    const signed = await signDisputeResolution(makeResolution(), relayKp.privateKey);
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(await verifyDisputeResolution(signed, relayKp.publicKey)).toBe(true);
  });

  it("federation resolution: every embedded vote signature re-checked (§6.5)", async () => {
    const leaderKp = await generateKeypair();
    const peer1 = await generateKeypair();
    const peer2 = await generateKeypair();
    const peer3 = await generateKeypair();

    const votes = await Promise.all([
      signAdjudicatorVote(
        { dispute_id: "d-1", peer_id: "p1", vote: "upheld", rationale: "ok" },
        peer1.privateKey,
      ),
      signAdjudicatorVote(
        { dispute_id: "d-1", peer_id: "p2", vote: "upheld", rationale: "ok" },
        peer2.privateKey,
      ),
      signAdjudicatorVote(
        { dispute_id: "d-1", peer_id: "p3", vote: "split", rationale: "partial" },
        peer3.privateKey,
      ),
    ]);

    const body = {
      ...makeResolution({ dispute_id: "d-1", adjudicator: "leader" }),
      adjudicator_votes: votes,
    };
    const signed = await signDisputeResolution(body, leaderKp.privateKey);

    const peerKeys = new Map<string, Uint8Array>([
      ["p1", peer1.publicKey],
      ["p2", peer2.publicKey],
      ["p3", peer3.publicKey],
    ]);
    expect(await verifyDisputeResolution(signed, leaderKp.publicKey, peerKeys)).toBe(true);
  });

  it("federation resolution with missing peer key — rejected (aggregated-only verdicts forbidden)", async () => {
    const leaderKp = await generateKeypair();
    const peer1 = await generateKeypair();
    const vote = await signAdjudicatorVote(
      { dispute_id: "d-2", peer_id: "p1", vote: "upheld", rationale: "ok" },
      peer1.privateKey,
    );
    const signed = await signDisputeResolution(
      { ...makeResolution({ dispute_id: "d-2" }), adjudicator_votes: [vote] },
      leaderKp.privateKey,
    );
    expect(await verifyDisputeResolution(signed, leaderKp.publicKey, new Map())).toBe(false);
  });

  it("federation resolution with one tampered vote — whole resolution fails", async () => {
    const leaderKp = await generateKeypair();
    const peer1 = await generateKeypair();
    const vote = await signAdjudicatorVote(
      { dispute_id: "d-3", peer_id: "p1", vote: "upheld", rationale: "ok" },
      peer1.privateKey,
    );
    const tamperedVote = { ...vote, vote: "overturned" as const };
    const signed = await signDisputeResolution(
      { ...makeResolution({ dispute_id: "d-3" }), adjudicator_votes: [tamperedVote] },
      leaderKp.privateKey,
    );
    const peerKeys = new Map([["p1", peer1.publicKey]]);
    expect(await verifyDisputeResolution(signed, leaderKp.publicKey, peerKeys)).toBe(false);
  });

  it("vote whose dispute_id does not match the outer resolution — rejected", async () => {
    const leaderKp = await generateKeypair();
    const peer1 = await generateKeypair();
    const voteForOtherDispute = await signAdjudicatorVote(
      { dispute_id: "d-OTHER", peer_id: "p1", vote: "upheld", rationale: "ok" },
      peer1.privateKey,
    );
    const signed = await signDisputeResolution(
      {
        ...makeResolution({ dispute_id: "d-TARGET" }),
        adjudicator_votes: [voteForOtherDispute],
      },
      leaderKp.privateKey,
    );
    const peerKeys = new Map([["p1", peer1.publicKey]]);
    expect(await verifyDisputeResolution(signed, leaderKp.publicKey, peerKeys)).toBe(false);
  });

  it("detects outer-signature tampering (split_ratio)", async () => {
    const relayKp = await generateKeypair();
    const signed = await signDisputeResolution(makeResolution(), relayKp.privateKey);
    const tampered = { ...signed, split_ratio: 0 };
    expect(await verifyDisputeResolution(tampered, relayKp.publicKey)).toBe(false);
  });

  it("rejects unknown suite", async () => {
    const relayKp = await generateKeypair();
    const signed = await signDisputeResolution(makeResolution(), relayKp.privateKey);
    const wrongSuite = { ...signed, suite: "motebit-future-pqc-v7" as never };
    expect(await verifyDisputeResolution(wrongSuite, relayKp.publicKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// signDisputeRequest / verifyDisputeRequest  (dispute-v1 §4.2)
// signDisputeEvidence / verifyDisputeEvidence  (dispute-v1 §5.2)
// signDisputeAppeal / verifyDisputeAppeal  (dispute-v1 §8.2)
// ---------------------------------------------------------------------------

describe("signDisputeRequest / verifyDisputeRequest", () => {
  function makeRequest(): Parameters<typeof signDisputeRequest>[0] {
    return {
      dispute_id: "dsp-test-1",
      task_id: "task-1",
      allocation_id: "alloc-1",
      filed_by: "did:motebit:filer",
      respondent: "did:motebit:resp",
      category: "quality",
      description: "Work was inadequate",
      evidence_refs: ["receipt-1"],
      filed_at: 1700000000000,
    };
  }

  it("round-trips: signed by the filer, verified with the filer's public key", async () => {
    const filerKp = await generateKeypair();
    const signed = await signDisputeRequest(makeRequest(), filerKp.privateKey);
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(typeof signed.signature).toBe("string");
    expect(await verifyDisputeRequest(signed, filerKp.publicKey)).toBe(true);
  });

  it("rejects under the wrong public key", async () => {
    const filerKp = await generateKeypair();
    const otherKp = await generateKeypair();
    const signed = await signDisputeRequest(makeRequest(), filerKp.privateKey);
    expect(await verifyDisputeRequest(signed, otherKp.publicKey)).toBe(false);
  });

  it("rejects tampered fields", async () => {
    const filerKp = await generateKeypair();
    const signed = await signDisputeRequest(makeRequest(), filerKp.privateKey);
    const tampered = { ...signed, filed_by: "did:motebit:attacker" };
    expect(await verifyDisputeRequest(tampered, filerKp.publicKey)).toBe(false);
  });

  it("rejects unknown suite (fail-closed)", async () => {
    const filerKp = await generateKeypair();
    const signed = await signDisputeRequest(makeRequest(), filerKp.privateKey);
    const wrongSuite = { ...signed, suite: "motebit-future-pqc-v9" as never };
    expect(await verifyDisputeRequest(wrongSuite, filerKp.publicKey)).toBe(false);
  });
});

describe("signDisputeEvidence / verifyDisputeEvidence", () => {
  function makeEvidence(): Parameters<typeof signDisputeEvidence>[0] {
    return {
      dispute_id: "dsp-test-1",
      submitted_by: "did:motebit:resp",
      evidence_type: "execution_receipt",
      evidence_data: { receipt_id: "rcpt-1" },
      description: "Receipt showing the task completed",
      submitted_at: 1700000005000,
    };
  }

  it("round-trips: signed by the submitter, verified with submitter's public key", async () => {
    const submitterKp = await generateKeypair();
    const signed = await signDisputeEvidence(makeEvidence(), submitterKp.privateKey);
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(await verifyDisputeEvidence(signed, submitterKp.publicKey)).toBe(true);
  });

  it("rejects under the wrong public key", async () => {
    const submitterKp = await generateKeypair();
    const otherKp = await generateKeypair();
    const signed = await signDisputeEvidence(makeEvidence(), submitterKp.privateKey);
    expect(await verifyDisputeEvidence(signed, otherKp.publicKey)).toBe(false);
  });

  it("rejects tampered evidence_data", async () => {
    const submitterKp = await generateKeypair();
    const signed = await signDisputeEvidence(makeEvidence(), submitterKp.privateKey);
    const tampered = { ...signed, evidence_data: { receipt_id: "rcpt-FAKE" } };
    expect(await verifyDisputeEvidence(tampered, submitterKp.publicKey)).toBe(false);
  });
});

describe("signDisputeAppeal / verifyDisputeAppeal", () => {
  function makeAppeal(): Parameters<typeof signDisputeAppeal>[0] {
    return {
      dispute_id: "dsp-test-1",
      appealed_by: "did:motebit:filer",
      reason: "New evidence overturns the resolution",
      additional_evidence: ["evi-2"],
      appealed_at: 1700000010000,
    };
  }

  it("round-trips: signed by the appealer, verified with appealer's public key", async () => {
    const appealerKp = await generateKeypair();
    const signed = await signDisputeAppeal(makeAppeal(), appealerKp.privateKey);
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(await verifyDisputeAppeal(signed, appealerKp.publicKey)).toBe(true);
  });

  it("rejects under the wrong public key", async () => {
    const appealerKp = await generateKeypair();
    const otherKp = await generateKeypair();
    const signed = await signDisputeAppeal(makeAppeal(), appealerKp.privateKey);
    expect(await verifyDisputeAppeal(signed, otherKp.publicKey)).toBe(false);
  });

  it("rejects tampered reason", async () => {
    const appealerKp = await generateKeypair();
    const signed = await signDisputeAppeal(makeAppeal(), appealerKp.privateKey);
    const tampered = { ...signed, reason: "Different reason after-the-fact" };
    expect(await verifyDisputeAppeal(tampered, appealerKp.publicKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyReceiptChain()
// ---------------------------------------------------------------------------

describe("verifyReceiptChain", () => {
  function makeReceipt(
    overrides?: Partial<Omit<SignableReceipt, "signature" | "suite">>,
  ): Omit<SignableReceipt, "signature" | "suite"> {
    return {
      task_id: "task-001",
      motebit_id: "mote-123",
      device_id: "device-456",
      submitted_at: 1700000000000,
      completed_at: 1700000060000,
      status: "completed",
      result: "Task completed successfully",
      tools_used: ["search", "calculate"],
      memories_formed: 2,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
      ...overrides,
    };
  }

  it("single receipt verifies", async () => {
    const kp = await generateKeypair();
    const signed = await signExecutionReceipt(makeReceipt(), kp.privateKey);

    const knownKeys: KnownKeys = new Map([["mote-123", kp.publicKey]]);
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.task_id).toBe("task-001");
    expect(result.motebit_id).toBe("mote-123");
    expect(result.verified).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.delegations).toEqual([]);
  });

  it("single receipt fails with wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const signed = await signExecutionReceipt(makeReceipt(), kpA.privateKey);

    const knownKeys: KnownKeys = new Map([["mote-123", kpB.publicKey]]);
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.delegations).toEqual([]);
  });

  it("unknown motebit_id", async () => {
    const kp = await generateKeypair();
    const signed = await signExecutionReceipt(makeReceipt(), kp.privateKey);

    const knownKeys: KnownKeys = new Map(); // empty — no known keys
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(false);
    expect(result.error).toBe("unknown motebit_id");
    expect(result.delegations).toEqual([]);
  });

  it("two-level chain — both verify", async () => {
    const parentKp = await generateKeypair();
    const childKp = await generateKeypair();

    // Sign the child (delegation) receipt first
    const childSigned = await signExecutionReceipt(
      makeReceipt({ task_id: "delegated-001", motebit_id: "mote-child" }),
      childKp.privateKey,
    );

    // Sign the parent receipt with the delegation included
    const parentSigned = await signExecutionReceipt(
      {
        ...makeReceipt({ task_id: "parent-001", motebit_id: "mote-parent" }),
        delegation_receipts: [childSigned],
      },
      parentKp.privateKey,
    );

    const knownKeys: KnownKeys = new Map([
      ["mote-parent", parentKp.publicKey],
      ["mote-child", childKp.publicKey],
    ]);
    const result = await verifyReceiptChain(parentSigned, knownKeys);

    expect(result.task_id).toBe("parent-001");
    expect(result.verified).toBe(true);
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]!.task_id).toBe("delegated-001");
    expect(result.delegations[0]!.motebit_id).toBe("mote-child");
    expect(result.delegations[0]!.verified).toBe(true);
    expect(result.delegations[0]!.delegations).toEqual([]);
  });

  it("chain where parent verifies but delegation fails", async () => {
    const parentKp = await generateKeypair();
    const childKp = await generateKeypair();

    // Sign child receipt
    const childSigned = await signExecutionReceipt(
      makeReceipt({ task_id: "delegated-002", motebit_id: "mote-unknown-child" }),
      childKp.privateKey,
    );

    // Sign parent receipt with delegation
    const parentSigned = await signExecutionReceipt(
      {
        ...makeReceipt({ task_id: "parent-002", motebit_id: "mote-parent" }),
        delegation_receipts: [childSigned],
      },
      parentKp.privateKey,
    );

    // Only parent key is known — child's motebit_id is missing from knownKeys
    const knownKeys: KnownKeys = new Map([["mote-parent", parentKp.publicKey]]);
    const result = await verifyReceiptChain(parentSigned, knownKeys);

    expect(result.verified).toBe(true);
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]!.verified).toBe(false);
    expect(result.delegations[0]!.error).toBe("unknown motebit_id");
  });

  it("verifies using embedded public_key when not in knownKeys", async () => {
    const kp = await generateKeypair();
    const receiptWithKey = { ...makeReceipt(), public_key: bytesToHex(kp.publicKey) };
    const signed = await signExecutionReceipt(receiptWithKey, kp.privateKey);

    // Empty knownKeys — verification falls back to receipt.public_key
    const knownKeys: KnownKeys = new Map();
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("empty delegation_receipts still verifies with empty delegations array", async () => {
    const kp = await generateKeypair();
    const signed = await signExecutionReceipt(
      { ...makeReceipt(), delegation_receipts: [] },
      kp.privateKey,
    );

    const knownKeys: KnownKeys = new Map([["mote-123", kp.publicKey]]);
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(true);
    expect(result.delegations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// did:key — W3C DID derivation from Ed25519 public keys
// ---------------------------------------------------------------------------

describe("base58btcEncode", () => {
  it("encodes empty bytes as empty string", () => {
    expect(base58btcEncode(new Uint8Array(0))).toBe("");
  });

  it("encodes leading zeros as '1' characters", () => {
    const result = base58btcEncode(new Uint8Array([0, 0, 0, 1]));
    expect(result.startsWith("111")).toBe(true);
    expect(result).toBe("1112");
  });

  it("encodes a known byte sequence correctly", () => {
    // "Hello" in base58btc = "9Ajdvzr"
    const hello = new TextEncoder().encode("Hello");
    expect(base58btcEncode(hello)).toBe("9Ajdvzr");
  });
});

describe("hexToBytes", () => {
  it("converts hex string to Uint8Array", () => {
    const bytes = hexToBytes("deadbeef");
    expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles all-zero hex", () => {
    const bytes = hexToBytes("00000000");
    expect(bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("handles empty string", () => {
    const bytes = hexToBytes("");
    expect(bytes.length).toBe(0);
  });
});

describe("publicKeyToDidKey", () => {
  it("produces a did:key URI starting with did:key:z", async () => {
    const kp = await generateKeypair();
    const did = publicKeyToDidKey(kp.publicKey);
    expect(did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("is deterministic — same key produces same DID", async () => {
    const kp = await generateKeypair();
    const a = publicKeyToDidKey(kp.publicKey);
    const b = publicKeyToDidKey(kp.publicKey);
    expect(a).toBe(b);
  });

  it("different keys produce different DIDs", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    expect(publicKeyToDidKey(kpA.publicKey)).not.toBe(publicKeyToDidKey(kpB.publicKey));
  });

  it("rejects non-32-byte input", () => {
    expect(() => publicKeyToDidKey(new Uint8Array(16))).toThrow("32 bytes");
    expect(() => publicKeyToDidKey(new Uint8Array(64))).toThrow("32 bytes");
  });

  it("matches known test vector", () => {
    // Test vector: 32 zero bytes -> known did:key
    // Multicodec prefix ed01 + 32 zero bytes -> base58btc
    const zeroKey = new Uint8Array(32);
    const did = publicKeyToDidKey(zeroKey);
    expect(did).toMatch(/^did:key:z/);
    // The prefix bytes (0xed, 0x01) followed by 32 zeros should produce a consistent result
    const prefixed = new Uint8Array(34);
    prefixed[0] = 0xed;
    prefixed[1] = 0x01;
    expect(did).toBe(`did:key:z${base58btcEncode(prefixed)}`);
  });
});

describe("hexPublicKeyToDidKey", () => {
  it("converts hex public key to did:key", async () => {
    const kp = await generateKeypair();
    const hex = Array.from(kp.publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const didFromHex = hexPublicKeyToDidKey(hex);
    const didFromBytes = publicKeyToDidKey(kp.publicKey);
    expect(didFromHex).toBe(didFromBytes);
  });
});

// ---------------------------------------------------------------------------
// signKeySuccession / verifyKeySuccession
// ---------------------------------------------------------------------------

describe("signKeySuccession", () => {
  it("creates a valid succession record signed by both keys", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
      "routine rotation",
    );

    expect(record.old_public_key).toHaveLength(64);
    expect(record.new_public_key).toHaveLength(64);
    expect(record.old_key_signature).toHaveLength(128);
    expect(record.new_key_signature).toHaveLength(128);
    expect(record.reason).toBe("routine rotation");
    expect(record.timestamp).toBeTypeOf("number");
  });

  it("creates a record without reason", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    expect(record.reason).toBeUndefined();
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(true);
  });
});

describe("verifyKeySuccession", () => {
  it("verifies a valid succession record", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
      "compromise",
    );

    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(true);
  });

  it("rejects a record with tampered new_public_key", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    // Tamper with the new public key
    record.new_public_key = "ff".repeat(32);
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects a record with tampered old_key_signature", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    // Tamper with old key signature
    record.old_key_signature = "aa".repeat(64);
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects a record with tampered new_key_signature", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    // Tamper with new key signature
    record.new_key_signature = "bb".repeat(64);
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects a record with tampered timestamp", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    record.timestamp = record.timestamp + 1;
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("returns false for invalid hex in public keys (catch block)", async () => {
    const record = {
      old_public_key: "not-valid-hex",
      new_public_key: "also-not-valid-hex",
      timestamp: Date.now(),
      old_key_signature: "aa".repeat(64),
      new_key_signature: "bb".repeat(64),
    };
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// didKeyToPublicKey error paths
// ---------------------------------------------------------------------------

describe("didKeyToPublicKey error paths", () => {
  it("rejects did:key with wrong multicodec prefix", () => {
    // Build a did:key with wrong prefix bytes (0x00, 0x00 instead of 0xed, 0x01)
    const fakeBytes = new Uint8Array(34);
    fakeBytes[0] = 0x00;
    fakeBytes[1] = 0x00;
    const encoded = `did:key:z${base58btcEncode(fakeBytes)}`;
    expect(() => didKeyToPublicKey(encoded)).toThrow("multicodec prefix");
  });

  it("rejects did:key with wrong decoded length", () => {
    // Build a did:key with only 20 bytes instead of 34
    const shortBytes = new Uint8Array(20);
    const encoded = `did:key:z${base58btcEncode(shortBytes)}`;
    expect(() => didKeyToPublicKey(encoded)).toThrow("expected 34 bytes");
  });
});

// ---------------------------------------------------------------------------
// ed25519Verify() catch block
// ---------------------------------------------------------------------------

describe("ed25519Verify error handling", () => {
  it("returns false when signature bytes are malformed (not 64 bytes)", async () => {
    const kp = await generateKeypair();
    const message = new TextEncoder().encode("test");
    // Pass a too-short signature — @noble/ed25519 will throw
    const badSig = new Uint8Array(10);
    const valid = await ed25519Verify(badSig, message, kp.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySignedToken error paths
// ---------------------------------------------------------------------------

describe("verifySignedToken error paths", () => {
  it("returns null when base64url payload is invalid (decode error)", async () => {
    const kp = await generateKeypair();
    // "!!!" is not valid base64url — atob will throw
    const result = await verifySignedToken("!!!.!!!", kp.publicKey);
    expect(result).toBeNull();
  });

  it("returns null when payload is valid base64 but not valid JSON", async () => {
    const kp = await generateKeypair();
    // Create a token where the payload is valid base64url but not JSON,
    // and the signature is valid for that payload
    const notJson = new TextEncoder().encode("this is not json");
    const payloadB64 = btoa(String.fromCharCode(...notJson))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = await ed25519Sign(notJson, kp.privateKey);
    const sigB64 = btoa(String.fromCharCode(...sig))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const token = `${payloadB64}.${sigB64}`;
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyExecutionReceipt catch block
// ---------------------------------------------------------------------------

describe("verifyExecutionReceipt error paths", () => {
  it("returns false when signature is not valid base64url", async () => {
    const kp = await generateKeypair();
    const receipt: SignableReceipt = {
      task_id: "task-001",
      motebit_id: "mote-123",
      device_id: "device-456",
      submitted_at: 1700000000000,
      completed_at: 1700000060000,
      status: "completed",
      result: "ok",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: "!!!not-valid-base64!!!",
    };
    const valid = await verifyExecutionReceipt(receipt, kp.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardian Recovery Succession
// ---------------------------------------------------------------------------

describe("signGuardianRecoverySuccession", () => {
  it("creates a valid guardian recovery record", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair(); // compromised key
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    expect(record.recovery).toBe(true);
    expect(record.reason).toBe("guardian_recovery");
    expect(record.guardian_signature).toHaveLength(128);
    expect(record.new_key_signature).toHaveLength(128);
    expect(record.old_key_signature).toBeUndefined();
  });

  it("uses custom reason when provided", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
      "guardian_recovery: employee departure",
    );

    expect(record.reason).toBe("guardian_recovery: employee departure");
  });

  it("verifies with correct guardian public key", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    const guardianPubHex = bytesToHex(guardianKp.publicKey);
    const valid = await verifyKeySuccession(record, guardianPubHex);
    expect(valid).toBe(true);
  });

  it("rejects with wrong guardian public key", async () => {
    const guardianKp = await generateKeypair();
    const wrongGuardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    const wrongPubHex = bytesToHex(wrongGuardianKp.publicKey);
    const valid = await verifyKeySuccession(record, wrongPubHex);
    expect(valid).toBe(false);
  });

  it("rejects guardian recovery when no guardian key provided", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    // No guardian key provided — must reject
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects when guardian_signature is tampered", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    record.guardian_signature = "aa".repeat(64);
    const guardianPubHex = bytesToHex(guardianKp.publicKey);
    const valid = await verifyKeySuccession(record, guardianPubHex);
    expect(valid).toBe(false);
  });
});

describe("verifySuccessionChain with guardian recovery", () => {
  it("verifies a mixed chain: normal rotation -> guardian recovery", async () => {
    const guardianKp = await generateKeypair();
    const kp1 = await generateKeypair(); // genesis
    const kp2 = await generateKeypair(); // normal rotation target
    const kp3 = await generateKeypair(); // guardian recovery target

    // Step 1: normal rotation kp1 -> kp2
    const normalRecord = await signKeySuccession(
      kp1.privateKey,
      kp2.privateKey,
      kp2.publicKey,
      kp1.publicKey,
      "routine rotation",
    );

    // Small delay to ensure timestamp ordering
    await new Promise((r) => setTimeout(r, 5));

    // Step 2: guardian recovery kp2 -> kp3 (kp2 compromised)
    const recoveryRecord = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      kp3.privateKey,
      kp2.publicKey,
      kp3.publicKey,
    );

    const guardianPubHex = bytesToHex(guardianKp.publicKey);

    const result = await verifySuccessionChain([normalRecord, recoveryRecord], guardianPubHex);

    expect(result.valid).toBe(true);
    expect(result.genesis_public_key).toBe(bytesToHex(kp1.publicKey));
    expect(result.current_public_key).toBe(bytesToHex(kp3.publicKey));
    expect(result.length).toBe(2);
  });

  it("rejects guardian recovery in chain without guardian key", async () => {
    const guardianKp = await generateKeypair();
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();

    const recoveryRecord = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      kp2.privateKey,
      kp1.publicKey,
      kp2.publicKey,
    );

    const result = await verifySuccessionChain([recoveryRecord]);
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain("guardian recovery but no guardian public key");
  });

  it("guardian key must not equal identity key", async () => {
    // This is a policy invariant: guardian.public_key !== identity.public_key
    // Enforced at identity generation, not chain verification — but let's verify
    // that a self-signed "guardian recovery" is still cryptographically valid
    // (the policy check happens at a higher layer)
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();

    // "Guardian" is actually kp1 itself — cryptographically valid but policy-invalid
    const record = await signGuardianRecoverySuccession(
      kp1.privateKey, // using identity key as guardian
      kp2.privateKey,
      kp1.publicKey,
      kp2.publicKey,
    );

    const pubHex = bytesToHex(kp1.publicKey);
    const valid = await verifyKeySuccession(record, pubHex);
    // Cryptographically valid — policy layer rejects this, not crypto
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guardian Revocation — dual authorization
// ---------------------------------------------------------------------------

describe("signGuardianRevocation + verifyGuardianRevocation", () => {
  it("creates and verifies a dual-signed revocation", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    expect(revocation.identity_signature).toHaveLength(128);
    expect(revocation.guardian_signature).toHaveLength(128);
    expect(revocation.timestamp).toBeTypeOf("number");

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(identityKp.publicKey),
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(true);
  });

  it("rejects with wrong identity key", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();
    const wrongKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(wrongKp.publicKey), // wrong identity key
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(false);
  });

  it("rejects with wrong guardian key", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();
    const wrongKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(identityKp.publicKey),
      bytesToHex(wrongKp.publicKey), // wrong guardian key
    );
    expect(valid).toBe(false);
  });

  it("rejects tampered timestamp", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    const tampered = { ...revocation, timestamp: revocation.timestamp + 1 };
    const valid = await verifyGuardianRevocation(
      tampered,
      bytesToHex(identityKp.publicKey),
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(false);
  });

  it("uses provided timestamp", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();
    const ts = 1700000000000;

    const revocation = await signGuardianRevocation(
      identityKp.privateKey,
      guardianKp.privateKey,
      ts,
    );

    expect(revocation.timestamp).toBe(ts);

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(identityKp.publicKey),
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signSovereignPaymentReceipt() — sovereign trust signal, no relay involved
// ---------------------------------------------------------------------------

describe("signSovereignPaymentReceipt", () => {
  it("produces a verifiable ExecutionReceipt anchored to an onchain tx", async () => {
    const payeeKp = await generateKeypair();

    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "payee-mote",
        payee_device_id: "payee-device",
        payer_motebit_id: "payer-mote",
        rail: "solana",
        tx_hash: "5JxYzExampleSolanaTxSignature",
        amount_micro: 5_000n,
        asset: "USDC",
        service_description: "search query",
        prompt_hash: "sha256:prompt",
        result_hash: "sha256:result",
        submitted_at: 1_700_000_000_000,
        completed_at: 1_700_000_001_000,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // task_id anchors the trust signal to a globally unique onchain payment
    expect(receipt.task_id).toBe("solana:tx:5JxYzExampleSolanaTxSignature");
    // sovereign rail — no relay binding
    expect(receipt.relay_task_id).toBeUndefined();
    expect(receipt.motebit_id).toBe("payee-mote");
    expect(receipt.status).toBe("completed");
    expect(receipt.signature).toBeTruthy();

    // The signature must verify against the embedded public key — no relay
    // lookup, no registry, no third party. Self-contained trust artifact.
    const valid = await verifyExecutionReceipt(receipt, payeeKp.publicKey);
    expect(valid).toBe(true);
  });

  it("tampering with the amount breaks verification", async () => {
    const payeeKp = await generateKeypair();
    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "payee",
        payee_device_id: "device",
        payer_motebit_id: "payer",
        rail: "solana",
        tx_hash: "txhash",
        amount_micro: 5_000n,
        asset: "USDC",
        service_description: "service",
        prompt_hash: "h1",
        result_hash: "h2",
        submitted_at: 1,
        completed_at: 2,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // Forge a higher amount in the result string after signing
    const tampered = {
      ...receipt,
      result: receipt.result.replace("5000", "999999999"),
    };
    const valid = await verifyExecutionReceipt(tampered, payeeKp.publicKey);
    expect(valid).toBe(false);
  });

  it("a different signer cannot produce a valid receipt for the same payment", async () => {
    const payeeKp = await generateKeypair();
    const attackerKp = await generateKeypair();

    const real = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "payee",
        payee_device_id: "device",
        payer_motebit_id: "payer",
        rail: "solana",
        tx_hash: "txhash",
        amount_micro: 1_000n,
        asset: "USDC",
        service_description: "service",
        prompt_hash: "h1",
        result_hash: "h2",
        submitted_at: 1,
        completed_at: 2,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // Attacker can't validate the real receipt against their own pubkey
    const validAgainstAttacker = await verifyExecutionReceipt(real, attackerKp.publicKey);
    expect(validAgainstAttacker).toBe(false);
  });

  it("works with an empty tools_used array by default", async () => {
    const payeeKp = await generateKeypair();
    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "p",
        payee_device_id: "d",
        payer_motebit_id: "x",
        rail: "solana",
        tx_hash: "h",
        amount_micro: 1n,
        asset: "USDC",
        service_description: "s",
        prompt_hash: "ph",
        result_hash: "rh",
        submitted_at: 0,
        completed_at: 0,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );
    expect(receipt.tools_used).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { verify } from "../index";
import type { ExecutionReceipt, ReceiptVerifyResult } from "../index";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sorted) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue;
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

async function makeKeypair() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

async function signReceipt(
  body: Omit<ExecutionReceipt, "signature">,
  privateKey: Uint8Array,
): Promise<ExecutionReceipt> {
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await ed.signAsync(message, privateKey);
  return { ...body, signature: toBase64Url(sig) };
}

function makeReceiptBody(publicKeyHex: string): Omit<ExecutionReceipt, "signature"> {
  return {
    task_id: "task-001",
    motebit_id: "01234567-89ab-cdef-0123-456789abcdef",
    public_key: publicKeyHex,
    device_id: "dev-001",
    submitted_at: 1000000,
    completed_at: 1001000,
    status: "completed",
    result: "Task completed successfully",
    tools_used: ["web_search", "file_read"],
    memories_formed: 2,
    prompt_hash: "abc123",
    result_hash: "def456",
  };
}

// ---------------------------------------------------------------------------
// Receipt verification
// ---------------------------------------------------------------------------

describe("verify — execution receipts", () => {
  it("verifies a correctly signed receipt (object)", async () => {
    const kp = await makeKeypair();
    const receipt = await signReceipt(makeReceiptBody(kp.publicKeyHex), kp.privateKey);

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(true);

    const r = result as ReceiptVerifyResult;
    expect(r.receipt).not.toBeNull();
    expect(r.receipt!.task_id).toBe("task-001");
    expect(r.signer).toMatch(/^did:key:z/);
    expect(r.errors).toBeUndefined();
  });

  it("verifies a receipt passed as JSON string", async () => {
    const kp = await makeKeypair();
    const receipt = await signReceipt(makeReceiptBody(kp.publicKeyHex), kp.privateKey);

    const result = await verify(JSON.stringify(receipt));
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(true);
  });

  it("fails on tampered receipt", async () => {
    const kp = await makeKeypair();
    const receipt = await signReceipt(makeReceiptBody(kp.publicKeyHex), kp.privateKey);

    // Tamper: change the result
    receipt.result = "tampered result";

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toContain("signature verification failed");
  });

  it("fails on receipt signed with wrong key", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();

    // Body has kp1's public key, signed with kp2's private key
    const receipt = await signReceipt(makeReceiptBody(kp1.publicKeyHex), kp2.privateKey);

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
  });

  it("fails on receipt without embedded public key", async () => {
    const kp = await makeKeypair();
    const body = makeReceiptBody(kp.publicKeyHex);
    delete (body as Record<string, unknown>).public_key;
    const receipt = await signReceipt(body, kp.privateKey);

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain("No embedded public_key");
  });

  it("verifies nested delegation receipts", async () => {
    const kpParent = await makeKeypair();
    const kpChild = await makeKeypair();

    const childBody = makeReceiptBody(kpChild.publicKeyHex);
    childBody.task_id = "task-child";
    childBody.motebit_id = "child-agent-id";
    const childReceipt = await signReceipt(childBody, kpChild.privateKey);

    const parentBody = makeReceiptBody(kpParent.publicKeyHex);
    parentBody.delegation_receipts = [childReceipt];
    const parentReceipt = await signReceipt(parentBody, kpParent.privateKey);

    const result = await verify(parentReceipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(true);

    const r = result as ReceiptVerifyResult;
    expect(r.delegations).toHaveLength(1);
    expect(r.delegations![0]!.valid).toBe(true);
    expect(r.delegations![0]!.receipt!.task_id).toBe("task-child");
  });

  it("reports invalid delegation in chain", async () => {
    const kpParent = await makeKeypair();
    const kpChild = await makeKeypair();

    const childBody = makeReceiptBody(kpChild.publicKeyHex);
    childBody.task_id = "task-child";
    const childReceipt = await signReceipt(childBody, kpChild.privateKey);
    // Tamper the child
    childReceipt.result = "tampered";

    const parentBody = makeReceiptBody(kpParent.publicKeyHex);
    parentBody.delegation_receipts = [childReceipt];
    const parentReceipt = await signReceipt(parentBody, kpParent.privateKey);

    const result = await verify(parentReceipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);

    const r = result as ReceiptVerifyResult;
    expect(r.delegations![0]!.valid).toBe(false);
  });

  it("fails on receipt without public key but still verifies delegations", async () => {
    const kpParent = await makeKeypair();
    const kpChild = await makeKeypair();

    // Create a valid child receipt
    const childBody = makeReceiptBody(kpChild.publicKeyHex);
    childBody.task_id = "task-child-no-parent-key";
    const childReceipt = await signReceipt(childBody, kpChild.privateKey);

    // Create parent without public_key but with delegation_receipts
    const parentBody = makeReceiptBody(kpParent.publicKeyHex);
    delete (parentBody as Record<string, unknown>).public_key;
    parentBody.delegation_receipts = [childReceipt];
    const parentReceipt = await signReceipt(parentBody, kpParent.privateKey);

    const result = await verify(parentReceipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain("No embedded public_key");

    const r = result as ReceiptVerifyResult;
    expect(r.delegations).toHaveLength(1);
    expect(r.delegations![0]!.valid).toBe(true);
  });

  it("fails on receipt with invalid public key hex (wrong length)", async () => {
    const kp = await makeKeypair();
    const body = makeReceiptBody(kp.publicKeyHex);
    // Set public_key to a hex string that's not 32 bytes
    body.public_key = "abcd";
    const receipt = await signReceipt(body, kp.privateKey);

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain("No embedded public_key");
  });

  it("respects expectedType option", async () => {
    const kp = await makeKeypair();
    const receipt = await signReceipt(makeReceiptBody(kp.publicKeyHex), kp.privateKey);

    // Correct expected type
    const r1 = await verify(receipt, { expectedType: "receipt" });
    expect(r1.valid).toBe(true);

    // Wrong expected type
    const r2 = await verify(receipt, { expectedType: "identity" });
    expect(r2.valid).toBe(false);
    expect(r2.errors![0]!.message).toContain("Expected type");
  });

  it("fails on empty signature string", async () => {
    const kp = await makeKeypair();
    const body = makeReceiptBody(kp.publicKeyHex);
    const receipt: ExecutionReceipt = { ...body, signature: "" };

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain("empty");
  });

  it("fails on malformed base64url signature", async () => {
    const kp = await makeKeypair();
    const body = makeReceiptBody(kp.publicKeyHex);
    const receipt: ExecutionReceipt = { ...body, signature: "!!!not-base64!!!" };

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
  });

  it("fails on wrong-length signature (not 64 bytes)", async () => {
    const kp = await makeKeypair();
    const body = makeReceiptBody(kp.publicKeyHex);
    // 32 bytes instead of 64 — valid base64url but wrong signature length
    const shortSig = toBase64Url(new Uint8Array(32));
    const receipt: ExecutionReceipt = { ...body, signature: shortSig };

    const result = await verify(receipt);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain("64 bytes");
  });
});

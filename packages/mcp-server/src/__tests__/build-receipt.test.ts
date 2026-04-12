import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, verifyExecutionReceipt, hash as sha256 } from "@motebit/encryption";
import type { ExecutionReceipt } from "@motebit/sdk";
import { buildServiceReceipt } from "../build-receipt.js";

let privateKey: Uint8Array;
let publicKey: Uint8Array;

beforeAll(async () => {
  const kp = await generateKeypair();
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
});

function baseInput(overrides: Partial<Parameters<typeof buildServiceReceipt>[0]> = {}) {
  return {
    motebitId: "motebit-svc",
    deviceId: "svc-device",
    privateKey,
    publicKey,
    prompt: "do a thing",
    taskId: "task-1",
    submittedAt: 1_700_000_000_000,
    result: "did the thing",
    ok: true,
    toolsUsed: ["the_thing"],
    ...overrides,
  };
}

describe("buildServiceReceipt", () => {
  it("constructs a receipt with the canonical fields", async () => {
    const receipt = await buildServiceReceipt(baseInput());
    expect(receipt.task_id).toBe("task-1");
    expect(receipt.motebit_id).toBe("motebit-svc");
    expect(receipt.device_id).toBe("svc-device");
    expect(receipt.submitted_at).toBe(1_700_000_000_000);
    expect(receipt.completed_at).toBeGreaterThanOrEqual(1_700_000_000_000);
    expect(receipt.status).toBe("completed");
    expect(receipt.result).toBe("did the thing");
    expect(receipt.tools_used).toEqual(["the_thing"]);
    expect(receipt.memories_formed).toBe(0);
    expect(typeof receipt.prompt_hash).toBe("string");
    expect(typeof receipt.result_hash).toBe("string");
    expect(typeof receipt.signature).toBe("string");
  });

  it("produces SHA-256 of prompt and result (stable across calls)", async () => {
    const r1 = await buildServiceReceipt(baseInput());
    const r2 = await buildServiceReceipt(baseInput({ taskId: "task-2" }));
    const enc = new TextEncoder();
    const expectedPromptHash = await sha256(enc.encode("do a thing"));
    const expectedResultHash = await sha256(enc.encode("did the thing"));
    expect(r1.prompt_hash).toBe(expectedPromptHash);
    expect(r1.result_hash).toBe(expectedResultHash);
    expect(r2.prompt_hash).toBe(expectedPromptHash);
    expect(r2.result_hash).toBe(expectedResultHash);
  });

  it("sets status to 'failed' when ok=false", async () => {
    const r = await buildServiceReceipt(baseInput({ ok: false, result: "kaboom" }));
    expect(r.status).toBe("failed");
    expect(r.result).toBe("kaboom");
  });

  it("omits relay_task_id when not provided", async () => {
    const r = (await buildServiceReceipt(baseInput())) as unknown as Record<string, unknown>;
    expect(r.relay_task_id).toBeUndefined();
  });

  it("includes relay_task_id when provided (economic binding)", async () => {
    const r = (await buildServiceReceipt(
      baseInput({ relayTaskId: "relay-xyz" }),
    )) as unknown as Record<string, unknown>;
    expect(r.relay_task_id).toBe("relay-xyz");
  });

  it("omits delegated_scope when not provided", async () => {
    const r = (await buildServiceReceipt(baseInput())) as unknown as Record<string, unknown>;
    expect(r.delegated_scope).toBeUndefined();
  });

  it("includes delegated_scope when this service was invoked as a sub-delegate", async () => {
    const r = (await buildServiceReceipt(
      baseInput({ delegatedScope: "web_search" }),
    )) as unknown as Record<string, unknown>;
    expect(r.delegated_scope).toBe("web_search");
  });

  it("omits delegation_receipts when the chain is empty", async () => {
    const r = (await buildServiceReceipt(
      baseInput({ delegationReceipts: [] }),
    )) as unknown as Record<string, unknown>;
    expect(r.delegation_receipts).toBeUndefined();
  });

  it("omits delegation_receipts when not provided at all", async () => {
    const r = (await buildServiceReceipt(baseInput())) as unknown as Record<string, unknown>;
    expect(r.delegation_receipts).toBeUndefined();
  });

  it("includes delegation_receipts when the chain has entries (citation chain)", async () => {
    const subReceipt = { task_id: "sub-1", signature: "sig-sub" } as unknown as ExecutionReceipt;
    const r = (await buildServiceReceipt(
      baseInput({ delegationReceipts: [subReceipt] }),
    )) as unknown as Record<string, unknown>;
    expect(r.delegation_receipts).toEqual([subReceipt]);
  });

  it("honors an explicit completedAt override", async () => {
    const r = await buildServiceReceipt(baseInput({ completedAt: 1_800_000_000_000 }));
    expect(r.completed_at).toBe(1_800_000_000_000);
  });

  it("falls back to Date.now() when completedAt is omitted", async () => {
    const before = Date.now();
    const r = await buildServiceReceipt(baseInput());
    const after = Date.now();
    expect(r.completed_at).toBeGreaterThanOrEqual(before);
    expect(r.completed_at).toBeLessThanOrEqual(after);
  });

  // (no-op marker — section boundary)

  it("honors an explicit memoriesFormed count", async () => {
    const r = await buildServiceReceipt(baseInput({ memoriesFormed: 3 }));
    expect(r.memories_formed).toBe(3);
  });

  it("produces a signature verifiable with the matching public key", async () => {
    const r = await buildServiceReceipt(baseInput());
    const valid = await verifyExecutionReceipt(r, publicKey);
    expect(valid).toBe(true);
  });

  it("tampering with the result invalidates the signature", async () => {
    const r = await buildServiceReceipt(baseInput());
    const tampered = { ...r, result: "I never actually did the thing" };
    const valid = await verifyExecutionReceipt(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("a different keypair does not verify the signature", async () => {
    const r = await buildServiceReceipt(baseInput());
    const other = await generateKeypair();
    const valid = await verifyExecutionReceipt(r, other.publicKey);
    expect(valid).toBe(false);
  });
});

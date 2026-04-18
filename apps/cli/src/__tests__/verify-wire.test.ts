/**
 * `motebit verify <kind> <path>` — end-to-end tests.
 *
 * The verify subcommand is the proof point for the wire-schemas
 * publication: a real receipt or token, signed with an actual Ed25519
 * keypair via @motebit/crypto, must verify; tampering one byte must
 * fail with a specific reason; schema violations must surface before
 * signature checks run.
 *
 * The full crypto stack is exercised — no mocks of @motebit/crypto.
 * That's the whole point: the verifier is what an external user (e.g.
 * a Python worker checking their output) would invoke, and what
 * external users invoke must use the real verification path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bytesToHex,
  generateKeypair,
  signDelegation,
  signExecutionReceipt,
} from "@motebit/encryption";

import { verifyWire } from "../subcommands/verify-wire.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "motebit-verify-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(value), "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// ExecutionReceipt — round-trip with real crypto
// ---------------------------------------------------------------------------

describe("verify receipt", () => {
  it("verifies a freshly-signed receipt against the published schema", async () => {
    const kp = await generateKeypair();
    const receipt = await signExecutionReceipt(
      {
        task_id: "task-1",
        motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        submitted_at: 1_713_456_000_000,
        completed_at: 1_713_456_001_000,
        status: "completed",
        result: "hello",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: "b".repeat(64),
      },
      kp.privateKey,
      kp.publicKey,
    );
    const path = writeJson("receipt.json", receipt);

    const report = await verifyWire("receipt", path);
    expect(report.ok).toBe(true);
    const sig = report.checks.find((c) => c.name === "signature");
    expect(sig?.ok).toBe(true);
    expect(sig?.detail).toMatch(/Ed25519/);
  });

  it("fails with signature error if any byte of the body is tampered", async () => {
    const kp = await generateKeypair();
    const receipt = await signExecutionReceipt(
      {
        task_id: "task-2",
        motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        submitted_at: 1_713_456_000_000,
        completed_at: 1_713_456_001_000,
        status: "completed",
        result: "original",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: "b".repeat(64),
      },
      kp.privateKey,
      kp.publicKey,
    );
    // Tamper: same shape, different result. Signature no longer matches.
    const tampered = { ...receipt, result: "TAMPERED" };
    const path = writeJson("receipt.json", tampered);

    const report = await verifyWire("receipt", path);
    expect(report.ok).toBe(false);
    const sig = report.checks.find((c) => c.name === "signature");
    expect(sig?.ok).toBe(false);
    // Schema check should still pass — tampering didn't break the shape.
    expect(report.checks.find((c) => c.name === "schema")?.ok).toBe(true);
  });

  it("fails on schema before reaching signature when shape is wrong", async () => {
    const path = writeJson("bad-receipt.json", { task_id: "lonely" });
    const report = await verifyWire("receipt", path);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "schema")?.ok).toBe(false);
    // Signature check is short-circuited.
    expect(report.checks.find((c) => c.name === "signature")).toBeUndefined();
  });

  it("fails on json parse for non-JSON files", async () => {
    const path = join(tmp, "not.json");
    writeFileSync(path, "this is not json {", "utf-8");
    const report = await verifyWire("receipt", path);
    expect(report.ok).toBe(false);
    const json = report.checks.find((c) => c.name === "json");
    expect(json?.ok).toBe(false);
    // Schema/signature short-circuited.
    expect(report.checks.find((c) => c.name === "schema")).toBeUndefined();
  });

  it("fails when public_key is omitted (cannot verify offline)", async () => {
    const kp = await generateKeypair();
    const receipt = await signExecutionReceipt(
      {
        task_id: "task-no-key",
        motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        submitted_at: 1_713_456_000_000,
        completed_at: 1_713_456_001_000,
        status: "completed",
        result: "hi",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: "b".repeat(64),
      },
      kp.privateKey,
      // Omit publicKey arg → receipt won't carry public_key.
    );
    const path = writeJson("receipt.json", receipt);
    const report = await verifyWire("receipt", path);
    expect(report.ok).toBe(false);
    const sig = report.checks.find((c) => c.name === "signature");
    expect(sig?.ok).toBe(false);
    expect(sig?.detail).toMatch(/no embedded public_key/);
  });
});

// ---------------------------------------------------------------------------
// DelegationToken — round-trip + window checks
// ---------------------------------------------------------------------------

describe("verify token", () => {
  it("verifies a freshly-signed delegation token", async () => {
    const kp = await generateKeypair();
    const delegateKp = await generateKeypair();
    const now = 1_713_456_000_000;
    const token = await signDelegation(
      {
        delegator_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        delegator_public_key: bytesToHex(kp.publicKey),
        delegate_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        delegate_public_key: bytesToHex(delegateKp.publicKey),
        scope: "web_search",
        issued_at: now,
        expires_at: now + 60_000,
      },
      kp.privateKey,
    );
    const path = writeJson("token.json", token);
    const report = await verifyWire("token", path, now + 1_000);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "window")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "signature")?.ok).toBe(true);
  });

  it("flags an expired token on the window check (signature still valid)", async () => {
    const kp = await generateKeypair();
    const delegateKp = await generateKeypair();
    const issued = 1_000_000;
    const expires = 2_000_000;
    const token = await signDelegation(
      {
        delegator_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        delegator_public_key: bytesToHex(kp.publicKey),
        delegate_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        delegate_public_key: bytesToHex(delegateKp.publicKey),
        scope: "*",
        issued_at: issued,
        expires_at: expires,
      },
      kp.privateKey,
    );
    const path = writeJson("token.json", token);
    const report = await verifyWire("token", path, expires + 1_000);
    expect(report.ok).toBe(false);
    const win = report.checks.find((c) => c.name === "window");
    expect(win?.ok).toBe(false);
    expect(win?.detail).toMatch(/expired/);
    // Signature is still cryptographically valid — we report orthogonally.
    expect(report.checks.find((c) => c.name === "signature")?.ok).toBe(true);
  });

  it("flags a not-yet-valid token (now < issued_at)", async () => {
    const kp = await generateKeypair();
    const delegateKp = await generateKeypair();
    const issued = 5_000_000;
    const token = await signDelegation(
      {
        delegator_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        delegator_public_key: bytesToHex(kp.publicKey),
        delegate_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        delegate_public_key: bytesToHex(delegateKp.publicKey),
        scope: "*",
        issued_at: issued,
        expires_at: issued + 60_000,
      },
      kp.privateKey,
    );
    const path = writeJson("token.json", token);
    const report = await verifyWire("token", path, 1_000);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "window")?.detail).toMatch(/not yet valid/);
  });

  it("fails when token signature is tampered", async () => {
    const kp = await generateKeypair();
    const delegateKp = await generateKeypair();
    const now = 1_713_456_000_000;
    const token = await signDelegation(
      {
        delegator_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
        delegator_public_key: bytesToHex(kp.publicKey),
        delegate_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
        delegate_public_key: bytesToHex(delegateKp.publicKey),
        scope: "web_search",
        issued_at: now,
        expires_at: now + 60_000,
      },
      kp.privateKey,
    );
    // Tamper: widen scope. Signature no longer matches.
    const tampered = { ...token, scope: "*" };
    const path = writeJson("token.json", tampered);
    const report = await verifyWire("token", path, now + 1_000);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "signature")?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentServiceListing — schema-only, not signed
// ---------------------------------------------------------------------------

describe("verify listing", () => {
  it("accepts a valid listing", async () => {
    const listing = {
      listing_id: "019cd9d4-3275-7b24-8265-listing01",
      motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 0.05, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
      description: "test",
      updated_at: 1_713_456_000_000,
    };
    const path = writeJson("listing.json", listing);
    const report = await verifyWire("listing", path);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "signature")?.detail).toMatch(/n\/a/);
  });

  it("preserves extra top-level keys on a listing (forward-compat per audit drift #1)", async () => {
    // AgentServiceListing is an unsigned envelope — the spec mandates
    // "unknown fields MUST be ignored (forward compatibility)" so a v1
    // verifier accepts a v2 listing carrying new fields. Inner objects
    // (`sla`, `pricing[]`) are still strict because they're protocol-
    // defined closed surfaces.
    const listing = {
      listing_id: "x",
      motebit_id: "y",
      capabilities: [],
      pricing: [],
      sla: { max_latency_ms: 1, availability_guarantee: 1 },
      description: "",
      updated_at: 0,
      future_v2_field: "preserved",
    };
    const path = writeJson("listing.json", listing);
    const report = await verifyWire("listing", path);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "schema")?.ok).toBe(true);
  });

  it("rejects a listing whose nested `sla` carries unknown keys (inner closed surfaces stay strict)", async () => {
    const listing = {
      listing_id: "x",
      motebit_id: "y",
      capabilities: [],
      pricing: [],
      sla: { max_latency_ms: 1, availability_guarantee: 1, sneak: "no" },
      description: "",
      updated_at: 0,
    };
    const path = writeJson("listing.json", listing);
    const report = await verifyWire("listing", path);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "schema")?.ok).toBe(false);
  });
});

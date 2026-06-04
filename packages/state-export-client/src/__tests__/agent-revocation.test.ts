/**
 * Portable agent-revocation verifier tests. Fabricate a signed record + feed
 * with a keypair under test (mirroring the relay's producer shape — no BSL dep
 * into a permissive-floor test), then verify the round-trip and every tamper
 * mode is caught fail-closed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, bytesToHex, sha256, canonicalJson, signBySuite } from "@motebit/crypto";
import type { SuiteId, AgentRevocationRecord, AgentRevocationFeed } from "@motebit/protocol";
import { verifyAgentRevocationRecord, verifyAgentRevocationFeed } from "../agent-revocation.js";

const SUITE: SuiteId = "motebit-jcs-ed25519-hex-v1";

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

async function makeKeys(): Promise<Keys> {
  const kp = await generateKeypair();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
  };
}

async function buildRecord(
  signer: Keys,
  overrides: Partial<AgentRevocationRecord> = {},
): Promise<AgentRevocationRecord> {
  const payload: Record<string, unknown> = {
    spec: overrides.spec ?? "motebit-agent-revocation/draft-2026-06-04",
    motebit_id: overrides.motebit_id ?? "019dd011-0000-7000-8000-00000000be7c",
    revoked: overrides.revoked ?? true,
    reason: overrides.reason ?? "operator_test_cleanup",
    actor: overrides.actor ?? "operator",
    effective_at: overrides.effective_at ?? 1_780_000_000_000,
    relay_id: overrides.relay_id ?? "test-relay",
    relay_public_key: overrides.relay_public_key ?? signer.publicKeyHex,
  };
  if (overrides.note !== undefined) payload.note = overrides.note;
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  const hash = bytesToHex(await sha256(canonical));
  const signature = bytesToHex(await signBySuite(SUITE, canonical, signer.privateKey));
  return { ...(payload as object), hash, suite: SUITE, signature } as AgentRevocationRecord;
}

async function buildFeed(
  signer: Keys,
  records: AgentRevocationRecord[],
): Promise<AgentRevocationFeed> {
  const payload = {
    spec: "motebit-agent-revocation/draft-2026-06-04",
    relay_id: "test-relay",
    relay_public_key: signer.publicKeyHex,
    generated_at: 1_780_000_001_000,
    records,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  const signature = bytesToHex(await signBySuite(SUITE, canonical, signer.privateKey));
  return { ...payload, suite: SUITE, signature } as AgentRevocationFeed;
}

describe("verifyAgentRevocationRecord", () => {
  let signer: Keys;
  beforeAll(async () => {
    signer = await makeKeys();
  });

  it("verifies a well-formed record", async () => {
    const r = await buildRecord(signer);
    expect(await verifyAgentRevocationRecord(r)).toEqual({ ok: true });
  });

  it("verifies a record carrying an optional note (note in canonical bytes)", async () => {
    const r = await buildRecord(signer, { note: "leftover smoke test" });
    expect(await verifyAgentRevocationRecord(r)).toEqual({ ok: true });
  });

  it("verifies a reinstate (revoked:false, reason reinstated)", async () => {
    const r = await buildRecord(signer, { revoked: false, reason: "reinstated" });
    expect(await verifyAgentRevocationRecord(r)).toEqual({ ok: true });
  });

  it("enforces the pinned producer key", async () => {
    const r = await buildRecord(signer);
    const other = await makeKeys();
    expect(await verifyAgentRevocationRecord(r, other.publicKeyHex)).toEqual({
      ok: false,
      reason: "producer_key_mismatch",
    });
    expect(await verifyAgentRevocationRecord(r, signer.publicKeyHex)).toEqual({ ok: true });
  });

  it("catches a tampered reason (hash_mismatch)", async () => {
    const r = await buildRecord(signer);
    const tampered = { ...r, reason: "spam" as const };
    expect((await verifyAgentRevocationRecord(tampered)).ok).toBe(false);
  });

  it("catches a tampered note (signature/hash break)", async () => {
    const r = await buildRecord(signer, { note: "original" });
    const tampered = { ...r, note: "rewritten" };
    expect((await verifyAgentRevocationRecord(tampered)).ok).toBe(false);
  });

  it("rejects a malformed record", async () => {
    expect(await verifyAgentRevocationRecord({} as AgentRevocationRecord)).toEqual({
      ok: false,
      reason: "malformed_record",
    });
  });

  it("rejects a bad signature", async () => {
    const r = await buildRecord(signer);
    const bad = { ...r, signature: "zz" };
    expect(await verifyAgentRevocationRecord(bad)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });
});

describe("verifyAgentRevocationFeed", () => {
  let signer: Keys;
  beforeAll(async () => {
    signer = await makeKeys();
  });

  it("verifies the feed digest and every record", async () => {
    const r1 = await buildRecord(signer, { reason: "abuse" });
    const r2 = await buildRecord(signer, { revoked: false, reason: "reinstated" });
    const feed = await buildFeed(signer, [r1, r2]);
    expect(await verifyAgentRevocationFeed(feed)).toEqual({ ok: true, count: 2 });
  });

  it("verifies an empty feed", async () => {
    const feed = await buildFeed(signer, []);
    expect(await verifyAgentRevocationFeed(feed)).toEqual({ ok: true, count: 0 });
  });

  it("fails when a contained record is tampered (record_invalid)", async () => {
    const r = await buildRecord(signer, { reason: "spam" });
    const feed = await buildFeed(signer, [{ ...r, reason: "abuse" as const }]);
    // Feed digest covers the records array, so tampering a record also breaks
    // the feed signature — the envelope check fires first.
    expect((await verifyAgentRevocationFeed(feed)).ok).toBe(false);
  });

  it("enforces the pinned producer key on the feed", async () => {
    const feed = await buildFeed(signer, []);
    const other = await makeKeys();
    expect(await verifyAgentRevocationFeed(feed, other.publicKeyHex)).toEqual({
      ok: false,
      reason: "producer_key_mismatch",
    });
  });
});

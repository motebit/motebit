/**
 * verifyRelayFeeRate — a relay's fee rate is trusted only from discovery
 * metadata signed by the key the caller already trusts for that relay.
 */
import { describe, it, expect } from "vitest";
import {
  verifyRelayFeeRate,
  generateKeypair,
  signBySuite,
  canonicalJson,
  bytesToHex,
} from "../index.js";

const SUITE = "motebit-jcs-ed25519-hex-v1" as const;

async function signed(
  priv: Uint8Array,
  pubHex: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const body = {
    protocol_version: "1.0",
    relay_id: "relay-1",
    public_key: pubHex,
    endpoint_url: "https://relay.test",
    suite: SUITE,
    ...extra,
  };
  const sig = await signBySuite(SUITE, new TextEncoder().encode(canonicalJson(body)), priv);
  return { ...body, signature: bytesToHex(sig) };
}

describe("verifyRelayFeeRate", () => {
  it("returns the declared rate from metadata signed by the trusted key", async () => {
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    const r = await verifyRelayFeeRate(await signed(kp.privateKey, hex, { fee_rate: 0.03 }), hex);
    expect(r).toMatchObject({ ok: true, declaredFeeRate: 0.03 });
  });

  it("an absent fee_rate verifies as undeclared (the caller applies the reference default)", async () => {
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    const r = await verifyRelayFeeRate(await signed(kp.privateKey, hex), hex);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.declaredFeeRate).toBeUndefined();
  });

  it("accepts a zero rate (a relay may charge nothing)", async () => {
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    const r = await verifyRelayFeeRate(await signed(kp.privateKey, hex, { fee_rate: 0 }), hex);
    expect(r).toMatchObject({ ok: true, declaredFeeRate: 0 });
  });

  for (const bad of [1, 1.5, -0.01, "0.03", null, true, {}]) {
    it(`refuses a malformed fee_rate ${JSON.stringify(bad)}`, async () => {
      const kp = await generateKeypair();
      const hex = bytesToHex(kp.publicKey);
      const r = await verifyRelayFeeRate(await signed(kp.privateKey, hex, { fee_rate: bad }), hex);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/fee_rate/);
    });
  }

  it("refuses metadata signed by another key that claims the trusted key", async () => {
    const trusted = await generateKeypair();
    const attacker = await generateKeypair();
    const hex = bytesToHex(trusted.publicKey);
    const r = await verifyRelayFeeRate(
      await signed(attacker.privateKey, hex, { fee_rate: 0.5 }),
      hex,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signature/);
  });

  it("refuses validly-signed metadata for a key other than the trusted one", async () => {
    const trusted = await generateKeypair();
    const other = await generateKeypair();
    const otherHex = bytesToHex(other.publicKey);
    const r = await verifyRelayFeeRate(
      await signed(other.privateKey, otherHex, { fee_rate: 0.03 }),
      bytesToHex(trusted.publicKey),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/different relay key/);
  });

  it("refuses a tampered fee_rate after signing", async () => {
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    const doc = await signed(kp.privateKey, hex, { fee_rate: 0.05 });
    const r = await verifyRelayFeeRate({ ...doc, fee_rate: 0.01 }, hex);
    expect(r.ok).toBe(false);
  });

  it("refuses an unexpected relay_id", async () => {
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    const r = await verifyRelayFeeRate(await signed(kp.privateKey, hex), hex, {
      expectedRelayId: "relay-2",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/relay_id/);
  });

  it("refuses non-documents", async () => {
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    for (const doc of [null, undefined, 42, "x", [], { public_key: hex }]) {
      expect((await verifyRelayFeeRate(doc, hex)).ok).toBe(false);
    }
  });
});

import { describe, it, expect } from "vitest";
import { generateKeypair, signRequestEnvelope, verifyRequestEnvelope } from "../index.js";

const AUD = "app.agency.computer/api/monitors";

describe("signRequestEnvelope / verifyRequestEnvelope", () => {
  it("round-trips against the signing key", async () => {
    const kp = await generateKeypair();
    const env = await signRequestEnvelope(
      { subject: "S", cadence: "daily" },
      { motebit_id: "mb-1", ts: 1_000, aud: AUD },
      kp.privateKey,
    );
    expect(env.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(env.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyRequestEnvelope(env, kp.publicKey)).toBe(true);
  });

  it("rejects a different key (the registered key is the trust move)", async () => {
    const kp = await generateKeypair();
    const other = await generateKeypair();
    const env = await signRequestEnvelope(
      { x: 1 },
      { motebit_id: "mb-1", ts: 1_000, aud: AUD },
      kp.privateKey,
    );
    expect(await verifyRequestEnvelope(env, other.publicKey)).toBe(false);
  });

  it("re-checks the detached payload digest when the payload is supplied", async () => {
    const kp = await generateKeypair();
    const payload = { subject: "S", cadence: "daily" };
    const env = await signRequestEnvelope(
      payload,
      { motebit_id: "mb-1", ts: 1_000, aud: AUD },
      kp.privateKey,
    );
    expect(await verifyRequestEnvelope(env, kp.publicKey, { payload })).toBe(true);
    // A different body has a different digest → reject.
    expect(await verifyRequestEnvelope(env, kp.publicKey, { payload: { subject: "EVIL" } })).toBe(
      false,
    );
  });

  it("enforces exact audience match when expectedAud is supplied", async () => {
    const kp = await generateKeypair();
    const env = await signRequestEnvelope(
      { x: 1 },
      { motebit_id: "mb-1", ts: 1_000, aud: AUD },
      kp.privateKey,
    );
    expect(await verifyRequestEnvelope(env, kp.publicKey, { expectedAud: AUD })).toBe(true);
    expect(
      await verifyRequestEnvelope(env, kp.publicKey, { expectedAud: "other.host/route" }),
    ).toBe(false);
  });

  it("enforces the freshness window when now is supplied", async () => {
    const kp = await generateKeypair();
    const env = await signRequestEnvelope(
      { x: 1 },
      { motebit_id: "mb-1", ts: 1_000, aud: AUD },
      kp.privateKey,
    );
    // Within ±300s default window.
    expect(await verifyRequestEnvelope(env, kp.publicKey, { now: 1_000 + 200_000 })).toBe(true);
    // Beyond the window → stale.
    expect(await verifyRequestEnvelope(env, kp.publicKey, { now: 1_000 + 400_000 })).toBe(false);
  });

  it("signs the optional nonce into the body", async () => {
    const kp = await generateKeypair();
    const env = await signRequestEnvelope(
      { x: 1 },
      { motebit_id: "mb-1", ts: 1_000, aud: AUD, nonce: "n-123" },
      kp.privateKey,
    );
    expect(env.nonce).toBe("n-123");
    expect(await verifyRequestEnvelope(env, kp.publicKey)).toBe(true);
    // Tampering with a signed field (aud) breaks the signature.
    expect(await verifyRequestEnvelope({ ...env, aud: "x" }, kp.publicKey)).toBe(false);
  });
});

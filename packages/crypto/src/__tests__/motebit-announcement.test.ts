import { describe, it, expect, beforeAll } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  signMotebitAnnouncement,
  verifyMotebitAnnouncement,
  isAnnouncementSurface,
  MOTEBIT_ANNOUNCEMENT_SUITE,
  MOTEBIT_ANNOUNCEMENT_MAX_AGE_MS,
  type SignableMotebitAnnouncement,
} from "../index";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

const RELAY_ID = "019d903f-0000-7000-8000-relayrelayid01";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function freshKeys() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

function baseBody(publicKeyHex: string, overrides: Record<string, unknown> = {}) {
  return {
    motebit_id: "019d903f-13de-75a4-8341-58319e0a2f16",
    public_key: publicKeyHex,
    surface: "web" as const,
    audience: RELAY_ID,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("signMotebitAnnouncement / verifyMotebitAnnouncement", () => {
  it("round-trips: signed announcement verifies against the embedded public key + audience", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signMotebitAnnouncement(baseBody(publicKeyHex), privateKey);
    expect(signed.suite).toBe(MOTEBIT_ANNOUNCEMENT_SUITE);
    expect(typeof signed.signature).toBe("string");
    expect(signed.signature.length).toBeGreaterThan(0);

    const result = await verifyMotebitAnnouncement(signed, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: true });
  });

  it("rejects an announcement bound to a different relay (wrong_audience)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    // Validly signed for RELAY_ID, but replayed to a relay whose id differs.
    const signed = await signMotebitAnnouncement(baseBody(publicKeyHex), privateKey);
    const result = await verifyMotebitAnnouncement(signed, {
      expectedAudience: "019d903f-ffff-7000-8000-otherrelayid99",
    });
    expect(result).toEqual({ valid: false, reason: "wrong_audience" });
  });

  it("rejects when the audience field is mutated after signing (bad_signature, not wrong_audience)", async () => {
    // Audience is part of the signed body: tampering with it to match the
    // target relay breaks the signature before the audience check passes.
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signMotebitAnnouncement(baseBody(publicKeyHex), privateKey);
    const forged = { ...signed, audience: "019d903f-ffff-7000-8000-otherrelayid99" };
    const result = await verifyMotebitAnnouncement(forged, {
      expectedAudience: "019d903f-ffff-7000-8000-otherrelayid99",
    });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects requests outside the ±5 minute timestamp window (stale)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const tooOld = Date.now() - MOTEBIT_ANNOUNCEMENT_MAX_AGE_MS - 1000;
    const signed = await signMotebitAnnouncement(
      baseBody(publicKeyHex, { timestamp: tooOld }),
      privateKey,
    );
    const result = await verifyMotebitAnnouncement(signed, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "stale" });
  });

  it("rejects future-dated requests outside the window (also stale)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const tooFuture = Date.now() + MOTEBIT_ANNOUNCEMENT_MAX_AGE_MS + 1000;
    const signed = await signMotebitAnnouncement(
      baseBody(publicKeyHex, { timestamp: tooFuture }),
      privateKey,
    );
    const result = await verifyMotebitAnnouncement(signed, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "stale" });
  });

  it("rejects when the body is mutated after signing (bad_signature)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signMotebitAnnouncement(baseBody(publicKeyHex), privateKey);
    const tampered = { ...signed, motebit_id: "different-id" };
    const result = await verifyMotebitAnnouncement(tampered, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects when the public_key in the body does not match the signer", async () => {
    const a = await freshKeys();
    const b = await freshKeys();
    const signed = await signMotebitAnnouncement(baseBody(b.publicKeyHex), a.privateKey);
    const result = await verifyMotebitAnnouncement(signed, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects malformed public_key (non-hex)", async () => {
    const { privateKey } = await freshKeys();
    const signed = await signMotebitAnnouncement(baseBody("not-a-hex-key"), privateKey);
    const result = await verifyMotebitAnnouncement(signed, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects malformed timestamp (string)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signMotebitAnnouncement(baseBody(publicKeyHex), privateKey);
    const broken = { ...signed, timestamp: "1234" as unknown as number };
    const result = await verifyMotebitAnnouncement(broken, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects unknown suite", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signMotebitAnnouncement(baseBody(publicKeyHex), privateKey);
    const wrongSuite = {
      ...signed,
      suite: "made-up-suite-v999" as unknown as typeof MOTEBIT_ANNOUNCEMENT_SUITE,
    };
    const result = await verifyMotebitAnnouncement(wrongSuite, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "unsupported_suite" });
  });

  it("clock parameter overrides Date.now() for testing replay windows", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const stamp = 1_000_000_000_000; // arbitrary fixed time
    const signed = await signMotebitAnnouncement(
      baseBody(publicKeyHex, { timestamp: stamp }),
      privateKey,
    );
    const inWindow = await verifyMotebitAnnouncement(signed, {
      expectedAudience: RELAY_ID,
      now: stamp + 1_000,
    });
    expect(inWindow).toEqual({ valid: true });
    const outOfWindow = await verifyMotebitAnnouncement(signed, {
      expectedAudience: RELAY_ID,
      now: stamp + 10 * 60 * 1000,
    });
    expect(outOfWindow).toEqual({ valid: false, reason: "stale" });
  });

  it("rejects an unknown surface as malformed (not just typeof string)", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const signed = await signMotebitAnnouncement(
      baseBody(publicKeyHex, { surface: "hacker" }),
      privateKey,
    );
    const result = await verifyMotebitAnnouncement(signed, { expectedAudience: RELAY_ID });
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("isAnnouncementSurface guards the closed set", () => {
    for (const s of ["web", "desktop", "mobile", "cli", "spatial"]) {
      expect(isAnnouncementSurface(s)).toBe(true);
    }
    for (const s of ["", "Web", "hacker", 1, null, undefined, {}]) {
      expect(isAnnouncementSurface(s)).toBe(false);
    }
  });

  it("each surface arm round-trips", async () => {
    const { privateKey, publicKeyHex } = await freshKeys();
    const surfaces: SignableMotebitAnnouncement["surface"][] = [
      "web",
      "desktop",
      "mobile",
      "cli",
      "spatial",
    ];
    for (const surface of surfaces) {
      const signed = await signMotebitAnnouncement(baseBody(publicKeyHex, { surface }), privateKey);
      const result = await verifyMotebitAnnouncement(signed, { expectedAudience: RELAY_ID });
      expect(result).toEqual({ valid: true });
    }
  });
});

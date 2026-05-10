/**
 * Browser-sandbox dispatcher-token tests.
 *
 * Three invariants:
 *   1. `mintBrowserSandboxToken` produces a signed token whose
 *      payload carries the expected motebit_id, audience, and TTL,
 *      and verifies under the relay's public key.
 *   2. The token's `aud` claim is exactly `BROWSER_SANDBOX_AUDIENCE`
 *      — cross-endpoint replay defense.
 *   3. A token with a tampered payload fails verification.
 */
import { describe, it, expect, beforeAll } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, verifySignedToken, bytesToHex } from "@motebit/encryption";
import { BROWSER_SANDBOX_AUDIENCE } from "@motebit/protocol";
import { mintBrowserSandboxToken, DEFAULT_SANDBOX_TOKEN_TTL_SEC } from "../browser-sandbox.js";
import type { RelayIdentity } from "../federation.js";

let relayIdentity: RelayIdentity;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeypair();
  const publicKeyHex = bytesToHex(publicKey);
  relayIdentity = {
    relayMotebitId: "relay-test-id",
    publicKey,
    privateKey,
    publicKeyHex,
    did: `did:key:z${publicKeyHex.slice(0, 10)}`,
  };
});

describe("mintBrowserSandboxToken", () => {
  it("produces a token that verifies under the relay's public key", async () => {
    const motebitId = "motebit-alice";
    const { token, expiresAt } = await mintBrowserSandboxToken(relayIdentity, motebitId);

    const payload = await verifySignedToken(token, relayIdentity.publicKey);

    expect(payload).not.toBeNull();
    expect(payload?.mid).toBe(motebitId);
    expect(payload?.did).toBe(relayIdentity.did);
    expect(payload?.aud).toBe(BROWSER_SANDBOX_AUDIENCE);
    expect(payload?.exp).toBe(expiresAt);
    expect(payload?.suite).toBe("motebit-jwt-ed25519-v1");
    expect(payload?.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("defaults TTL to DEFAULT_SANDBOX_TOKEN_TTL_SEC", async () => {
    const before = Date.now();
    const { expiresAt } = await mintBrowserSandboxToken(relayIdentity, "motebit-bob");
    const after = Date.now();

    const ttlMs = DEFAULT_SANDBOX_TOKEN_TTL_SEC * 1000;
    // exp = mintedAt + ttlMs, where mintedAt is between `before` and `after`
    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresAt).toBeLessThanOrEqual(after + ttlMs);
  });

  it("respects a custom TTL", async () => {
    const customTtlSec = 60;
    const before = Date.now();
    const { expiresAt } = await mintBrowserSandboxToken(
      relayIdentity,
      "motebit-carol",
      customTtlSec,
    );
    const after = Date.now();

    const ttlMs = customTtlSec * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresAt).toBeLessThanOrEqual(after + ttlMs);
  });

  it("each token gets a fresh jti — no replay collision", async () => {
    const a = await mintBrowserSandboxToken(relayIdentity, "motebit-dave");
    const b = await mintBrowserSandboxToken(relayIdentity, "motebit-dave");

    const payloadA = await verifySignedToken(a.token, relayIdentity.publicKey);
    const payloadB = await verifySignedToken(b.token, relayIdentity.publicKey);

    expect(payloadA?.jti).toBeDefined();
    expect(payloadB?.jti).toBeDefined();
    expect(payloadA?.jti).not.toBe(payloadB?.jti);
  });

  it("audience is exactly browser-sandbox — defense against cross-endpoint replay", async () => {
    const { token } = await mintBrowserSandboxToken(relayIdentity, "motebit-eve");
    const payload = await verifySignedToken(token, relayIdentity.publicKey);
    // Hardcoded literal — protects against accidental rename in audience.ts
    expect(payload?.aud).toBe("browser-sandbox");
  });

  it("a tampered payload fails verification", async () => {
    const { token } = await mintBrowserSandboxToken(relayIdentity, "motebit-frank");
    const [payloadB64, sigB64] = token.split(".");
    expect(payloadB64).toBeDefined();
    expect(sigB64).toBeDefined();

    // Decode, mutate `mid`, re-encode (signature stays the same → mismatch)
    const padded = payloadB64!.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const obj = JSON.parse(json) as Record<string, unknown>;
    obj.mid = "motebit-attacker";
    const tamperedJson = JSON.stringify(obj);
    const tamperedB64 = btoa(tamperedJson)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tamperedToken = `${tamperedB64}.${sigB64!}`;

    const payload = await verifySignedToken(tamperedToken, relayIdentity.publicKey);
    expect(payload).toBeNull();
  });

  it("a token verified under the wrong public key returns null", async () => {
    const { token } = await mintBrowserSandboxToken(relayIdentity, "motebit-grace");
    const otherKeypair = await generateKeypair();

    const payload = await verifySignedToken(token, otherKeypair.publicKey);
    expect(payload).toBeNull();
  });
});

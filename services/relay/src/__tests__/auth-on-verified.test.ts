/**
 * `verifySignedTokenForDevice`'s `onVerified` — the additive callback that
 * names the key a token verified under, from the same row read that
 * verified it (machine roster part B, B1;
 * docs/proposals/machine-roster-relay-v1.md D2/D4).
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, createSignedToken, bytesToHex } from "@motebit/crypto";
import type { IdentityManager } from "@motebit/core-identity";
import type { TokenAudience } from "@motebit/protocol";
import { verifySignedTokenForDevice } from "../auth.js";

const mid = "motebit-onverified-1";
const did = "device-onverified-1";

async function mintToken(privateKey: Uint8Array, aud: TokenAudience = "device:auth") {
  const now = Date.now();
  return createSignedToken(
    { mid, did, iat: now, exp: now + 300_000, jti: "jti-onverified-1", aud },
    privateKey,
  );
}

const deviceIM = (publicKeyHex: string): IdentityManager =>
  ({ loadDeviceById: async () => ({ public_key: publicKeyHex }) }) as unknown as IdentityManager;

describe("onVerified names the key that verified", () => {
  it("reports the DEVICE row's key, lowercased, exactly once, on success", async () => {
    const kp = await generateKeypair();
    const token = await mintToken(kp.privateKey);
    const seen: Array<[string, string]> = [];
    const ok = await verifySignedTokenForDevice(
      token,
      mid,
      deviceIM(bytesToHex(kp.publicKey).toUpperCase()),
      "device:auth",
      undefined,
      undefined,
      undefined,
      undefined,
      (key, source) => seen.push([key, source]),
    );
    expect(ok).toBe(true);
    expect(seen).toEqual([[bytesToHex(kp.publicKey), "device"]]);
  });

  it("reports the agent-registry fallback as such — a route that needs a device row can refuse it", async () => {
    const kp = await generateKeypair();
    const token = await mintToken(kp.privateKey);
    const seen: Array<[string, string]> = [];
    const ok = await verifySignedTokenForDevice(
      token,
      mid,
      { loadDeviceById: async () => null } as unknown as IdentityManager,
      "device:auth",
      undefined,
      undefined,
      () => bytesToHex(kp.publicKey),
      undefined,
      (key, source) => seen.push([key, source]),
    );
    expect(ok).toBe(true);
    expect(seen).toEqual([[bytesToHex(kp.publicKey), "agent_registry"]]);
  });

  it("is never called on a rejection — wrong key, or right key and wrong audience", async () => {
    const kp = await generateKeypair();
    const other = await generateKeypair();
    const token = await mintToken(kp.privateKey);
    let called = 0;
    const cases: Array<[IdentityManager, TokenAudience]> = [
      [deviceIM(bytesToHex(other.publicKey)), "device:auth"],
      [deviceIM(bytesToHex(kp.publicKey)), "sync"],
    ];
    for (const [im, aud] of cases) {
      const ok = await verifySignedTokenForDevice(
        token,
        mid,
        im,
        aud,
        undefined,
        undefined,
        undefined,
        undefined,
        () => called++,
      );
      expect(ok).toBe(false);
    }
    expect(called).toBe(0);
  });
});

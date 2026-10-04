/**
 * I0 through the mobile adapter: `rotateMobileKey` passes the wallet reader
 * and the acknowledgment to the shared controller, so a funded wallet stops
 * the rotation before SecureStore is touched, and the confirmed retry rotates.
 * The full table lives in surface-kit's `rotation-funds-preflight.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex, base58btcEncode } from "@motebit/encryption";
import { KeyRotationError, rotationFundsStop } from "@motebit/surface-kit";
import { rotateMobileKey } from "../key-rotation";

async function phone() {
  const a = await generateKeypair();
  const slots = new Map<string, string>([
    ["device_private_key", bytesToHex(a.privateKey)],
    ["device_public_key", bytesToHex(a.publicKey)],
  ]);
  const writes: string[] = [];
  const keyring = {
    get: async (k: string) => slots.get(k) ?? null,
    set: async (k: string, v: string) => {
      writes.push(k);
      slots.set(k, v);
    },
    delete: async (k: string) => {
      writes.push(`delete:${k}`);
      slots.delete(k);
    },
  };
  return { a, slots, writes, keyring };
}

const deps = (keyring: Awaited<ReturnType<typeof phone>>["keyring"]) => ({
  keyring,
  motebitId: "mid-phone",
  deviceId: "phone-device",
  syncUrl: null,
  identityFile: { load: async () => null, save: async () => undefined },
  onCommitted: () => undefined,
});

describe("rotateMobileKey — rotation never strands funds", () => {
  it("a funded wallet refuses before SecureStore is written, naming the address and the amount", async () => {
    const p = await phone();
    const err = await rotateMobileKey({
      ...deps(p.keyring),
      readWalletHoldings: async () => ({ solLamports: 1_000_000_000n, tokens: [] }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyRotationError);
    const funds = rotationFundsStop(err);
    expect(funds?.address).toBe(base58btcEncode(p.a.publicKey));
    expect(funds?.message).toMatch(/holds 1 SOL/);
    expect(p.writes).toEqual([]);
    expect(p.slots.get("device_private_key")).toBe(bytesToHex(p.a.privateKey));
  });

  it("the confirmed retry (acknowledgeFundsAtRisk) rotates", async () => {
    const p = await phone();
    const out = await rotateMobileKey({
      ...deps(p.keyring),
      readWalletHoldings: async () => ({ solLamports: 1_000_000_000n, tokens: [] }),
      acknowledgeFundsAtRisk: true,
    });
    expect(p.slots.get("device_public_key")).toBe(out.newPublicKey);
  });
});

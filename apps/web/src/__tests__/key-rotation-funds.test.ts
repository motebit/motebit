/**
 * I0 through the web adapter: `rotateWebKey` passes the wallet reader and the
 * acknowledgment to the shared controller, so a wallet whose balance cannot
 * be read (the public RPC 403s browsers) stops the rotation before the
 * keystore is touched, and the confirmed retry rotates. The full table lives
 * in surface-kit's `rotation-funds-preflight.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { rotationFundsStop } from "@motebit/surface-kit";
import type { EncryptedKeyStore } from "../encrypted-keystore";
import { rotateWebKey } from "../key-rotation";

async function tab() {
  const a = await generateKeypair();
  const stored: string[] = [bytesToHex(a.privateKey)];
  let pending: string | null = null;
  const keyStore = {
    loadPrivateKey: async () => stored[stored.length - 1]!,
    storePrivateKey: async (h: string) => {
      stored.push(h);
    },
    loadPendingRotation: async () => pending,
    storePendingRotation: async (p: string) => {
      pending = p;
    },
    clearPendingRotation: async () => {
      pending = null;
    },
    setAsidePendingRotation: async () => {
      pending = null;
    },
  } as unknown as EncryptedKeyStore;
  localStorage.setItem("motebit:device_public_key", bytesToHex(a.publicKey));
  return { a, stored, keyStore, pending: () => pending };
}

describe("rotateWebKey — rotation refuses while the old address holds value", () => {
  it("an unreadable wallet refuses (fail-closed) before the keystore is written", async () => {
    const t = await tab();
    const err = await rotateWebKey({
      keyStore: t.keyStore,
      motebitId: "mid-tab",
      deviceId: "tab-device",
      syncUrl: null,
      onCommitted: () => undefined,
      readWalletHoldings: async () => {
        throw new Error("HTTP 403");
      },
    }).catch((e: unknown) => e);
    const funds = rotationFundsStop(err);
    expect(funds?.reason).toBe("HTTP 403");
    expect(funds?.message).toMatch(/could not be read/);
    expect(t.stored).toEqual([bytesToHex(t.a.privateKey)]);
    expect(t.pending()).toBeNull();
  });

  it("the confirmed retry (acknowledgeFundsAtRisk) rotates", async () => {
    const t = await tab();
    const out = await rotateWebKey({
      keyStore: t.keyStore,
      motebitId: "mid-tab",
      deviceId: "tab-device",
      syncUrl: null,
      onCommitted: () => undefined,
      readWalletHoldings: async () => {
        throw new Error("HTTP 403");
      },
      acknowledgeFundsAtRisk: true,
    });
    expect(t.stored[t.stored.length - 1]).not.toBe(bytesToHex(t.a.privateKey));
    expect(localStorage.getItem("motebit:device_public_key")).toBe(out.newPublicKey);
  });
});

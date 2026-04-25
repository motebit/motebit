/**
 * Tests for web's `publishHardwareCredentialIfDue` — bootstrap helper
 * that mints a hardware-attestation credential through the web cascade
 * (WebAuthn → software) and submits it to the relay.
 *
 * Sibling of mobile + desktop publish tests — same shape, web-specific
 * deps (no AsyncStorage, no Tauri invoke; localStorage / WebAuthn).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import {
  LAST_HW_ATTEST_MINT_KEY,
  MIN_PUBLISH_INTERVAL_MS,
  publishHardwareCredentialIfDue,
  type PublishStorage,
} from "../publish-hardware-credential.js";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

interface InMemoryStorage extends PublishStorage {
  readonly map: Map<string, string>;
}

function makeStorage(initial: Record<string, string> = {}): InMemoryStorage {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
    }),
  };
}

async function makeKeypair(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  hex: string;
}> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const hex = Array.from(publicKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { privateKey, publicKey, hex };
}

/**
 * WebAuthn unavailable — cascade falls through to `platform: "software"`.
 * The browser-bound code path is exercised in `mint-hardware-credential.test.ts`;
 * here we only need the publish flow to drive a real signed credential.
 */
const noWebAuthn = {
  available: () => false,
  create: vi.fn(),
};

const NOW = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishHardwareCredentialIfDue (web)", () => {
  it("submits a credential and records the timestamp", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const storage = makeStorage();

    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ saved: 1 }),
        }) as unknown as Response,
    );

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "test-motebit",
      deviceId: "test-device",
      rpId: "localhost",
      syncUrl: "https://relay.test",
      authToken: "bearer-xyz",
      now: () => NOW,
      native: noWebAuthn,
      storage,
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "submitted", platform: "software" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://relay.test/api/v1/agents/test-motebit/credentials/submit");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer bearer-xyz");
    const body = JSON.parse(init?.body as string) as { credentials: unknown[] };
    expect(body.credentials).toHaveLength(1);

    expect(storage.map.get(LAST_HW_ATTEST_MINT_KEY)).toBe(String(NOW));
  });

  it("skips when the last publish was less than MIN_PUBLISH_INTERVAL_MS ago", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const recentMintAt = NOW - (MIN_PUBLISH_INTERVAL_MS - 1);
    const storage = makeStorage({ [LAST_HW_ATTEST_MINT_KEY]: String(recentMintAt) });
    const fetchImpl = vi.fn();

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      rpId: "localhost",
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      native: noWebAuthn,
      storage,
      fetchImpl,
    });

    expect(outcome.kind).toBe("skipped_recent");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-mints when the last publish is past the cadence window", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const oldMintAt = NOW - MIN_PUBLISH_INTERVAL_MS - 1;
    const storage = makeStorage({ [LAST_HW_ATTEST_MINT_KEY]: String(oldMintAt) });
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      rpId: "localhost",
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      native: noWebAuthn,
      storage,
      fetchImpl,
    });

    expect(outcome.kind).toBe("submitted");
    expect(storage.map.get(LAST_HW_ATTEST_MINT_KEY)).toBe(String(NOW));
  });

  it("returns submit_failed and does NOT advance the timestamp on a non-2xx", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const storage = makeStorage();
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          json: async () => ({ error: "relay down" }),
        }) as unknown as Response,
    );

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      rpId: "localhost",
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      native: noWebAuthn,
      storage,
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "submit_failed", status: 503, reason: "relay down" });
    expect(storage.map.has(LAST_HW_ATTEST_MINT_KEY)).toBe(false);
  });

  it("returns transport_failed when fetch throws", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const storage = makeStorage();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      rpId: "localhost",
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      native: noWebAuthn,
      storage,
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "transport_failed", error: "network down" });
    expect(storage.map.has(LAST_HW_ATTEST_MINT_KEY)).toBe(false);
  });
});

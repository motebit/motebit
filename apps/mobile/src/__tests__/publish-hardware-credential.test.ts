/**
 * Tests for `publishHardwareCredentialIfDue` — the mobile bootstrap
 * path that mints a hardware-attestation credential and submits it to
 * the relay. Exercises the cadence logic, the mint failure cascade,
 * the relay submission shape, and the storage round-trip without
 * requiring a real React Native runtime, real Apple/Google attestation
 * services, or a real relay.
 *
 * Sibling of `mint-hardware-credential.test.ts` — that file verifies
 * the cascade itself; this file verifies what the surface does with
 * the result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo", () => ({
  requireNativeModule: (name: string) => {
    if (name === "ExpoAppAttest") {
      return { appAttestAvailable: vi.fn(), appAttestMint: vi.fn() };
    }
    if (name === "ExpoPlayIntegrity") {
      return { playIntegrityAvailable: vi.fn(), playIntegrityMint: vi.fn() };
    }
    return { seAvailable: vi.fn(), seMintAttestation: vi.fn() };
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import {
  MIN_PUBLISH_INTERVAL_MS,
  publishHardwareCredentialIfDue,
} from "../publish-hardware-credential.js";
import { ASYNC_STORAGE_KEYS } from "../storage-keys.js";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

interface InMemoryStorage {
  readonly map: Map<string, string>;
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function makeStorage(initial: Record<string, string> = {}): InMemoryStorage {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: vi.fn(async (key: string) => map.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
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

const NOW = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishHardwareCredentialIfDue", () => {
  it("submits a credential to the relay and records the timestamp", async () => {
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
      syncUrl: "https://relay.test",
      authToken: "bearer-xyz",
      now: () => NOW,
      platform: "ios",
      storage,
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "submitted", platform: "software" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://relay.test/api/v1/agents/test-motebit/credentials/submit");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer bearer-xyz");
    const body = JSON.parse(init?.body as string) as { credentials: unknown[] };
    expect(body.credentials).toHaveLength(1);

    expect(storage.map.get(ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt)).toBe(String(NOW));
  });

  it("trims trailing slashes from syncUrl before composing the path", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const storage = makeStorage();
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );

    await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      syncUrl: "https://relay.test///",
      authToken: "t",
      now: () => NOW,
      platform: "ios",
      storage,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://relay.test/api/v1/agents/m1/credentials/submit",
    );
  });

  it("skips when the last publish was less than MIN_PUBLISH_INTERVAL_MS ago", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const recentMintAt = NOW - (MIN_PUBLISH_INTERVAL_MS - 1_000);
    const storage = makeStorage({
      [ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt]: String(recentMintAt),
    });
    const fetchImpl = vi.fn();

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      platform: "ios",
      storage,
      fetchImpl,
    });

    expect(outcome).toEqual({
      kind: "skipped_recent",
      lastMintAt: recentMintAt,
      nextEligibleAt: recentMintAt + MIN_PUBLISH_INTERVAL_MS,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-mints when the last publish is past the cadence window", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const oldMintAt = NOW - MIN_PUBLISH_INTERVAL_MS - 1;
    const storage = makeStorage({
      [ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt]: String(oldMintAt),
    });
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      platform: "ios",
      storage,
      fetchImpl,
    });

    expect(outcome.kind).toBe("submitted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(storage.map.get(ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt)).toBe(String(NOW));
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
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      platform: "ios",
      storage,
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "submit_failed", status: 503, reason: "relay down" });
    expect(storage.map.has(ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt)).toBe(false);
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
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      platform: "ios",
      storage,
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: "transport_failed", error: "network down" });
    expect(storage.map.has(ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt)).toBe(false);
  });

  it("proceeds with mint when storage read fails (over-mint > miss-publish)", async () => {
    const { privateKey, publicKey, hex } = await makeKeypair();
    const storage: InMemoryStorage = {
      map: new Map(),
      getItem: vi.fn(async () => {
        throw new Error("corrupt cache");
      }),
      setItem: vi.fn(async (key: string, value: string) => {
        // setItem path still works
        // (no-op for this test)
        void key;
        void value;
      }),
    };
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );

    const outcome = await publishHardwareCredentialIfDue({
      identityPublicKeyHex: hex,
      privateKey,
      publicKey,
      motebitId: "m1",
      deviceId: "d1",
      syncUrl: "https://relay.test",
      authToken: "t",
      now: () => NOW,
      platform: "ios",
      storage,
      fetchImpl,
    });

    expect(outcome.kind).toBe("submitted");
    expect(fetchImpl).toHaveBeenCalled();
  });
});

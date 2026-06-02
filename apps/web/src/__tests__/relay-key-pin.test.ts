/**
 * Relay-key TOFU pin — the trust root for paid P2P fee-leg treasury derivation.
 * Locks the fail-closed-on-mismatch contract so a changed relay key disables
 * paid P2P (relay-mode still works) rather than redirecting an irreversible
 * payment to a possibly-wrong address.
 */
import { describe, it, expect, vi } from "vitest";
import { getOrPinRelayKey } from "../relay-key-pin.js";

const RELAY = "https://relay.test";
const KEY_A = "aa".repeat(32);
const KEY_B = "bb".repeat(32);

function makeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    store: m,
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      m.set(k, v);
    },
  };
}

const okFetch = (publicKey: string) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ public_key: publicKey }) }) as Response);

describe("getOrPinRelayKey", () => {
  it("trust-on-first-use: persists and returns the fetched key when no pin exists", async () => {
    const storage = makeStorage();
    const fetchImpl = okFetch(KEY_A);
    const result = await getOrPinRelayKey(RELAY, { fetchImpl, storage });
    expect(result).toBe(KEY_A);
    expect(storage.getItem(`motebit:relay_pin:${RELAY}`)).toBe(KEY_A);
  });

  it("returns the pin when the live key still matches it", async () => {
    const storage = makeStorage({ [`motebit:relay_pin:${RELAY}`]: KEY_A });
    const result = await getOrPinRelayKey(RELAY, { fetchImpl: okFetch(KEY_A), storage });
    expect(result).toBe(KEY_A);
  });

  it("FAILS CLOSED (undefined) and does not re-pin when the live key differs from the pin", async () => {
    const storage = makeStorage({ [`motebit:relay_pin:${RELAY}`]: KEY_A });
    const logger = { warn: vi.fn() };
    const result = await getOrPinRelayKey(RELAY, { fetchImpl: okFetch(KEY_B), storage, logger });
    expect(result).toBeUndefined();
    // Pin is NOT overwritten by the mismatching key.
    expect(storage.getItem(`motebit:relay_pin:${RELAY}`)).toBe(KEY_A);
    expect(logger.warn).toHaveBeenCalledWith("relay_key_pin.mismatch", expect.any(Object));
  });

  it("falls back to the existing pin when the fetch fails", async () => {
    const storage = makeStorage({ [`motebit:relay_pin:${RELAY}`]: KEY_A });
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await getOrPinRelayKey(RELAY, { fetchImpl, storage });
    expect(result).toBe(KEY_A);
  });

  it("returns undefined when the fetch fails and there is no pin (cannot establish trust)", async () => {
    const storage = makeStorage();
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage })).toBeUndefined();
  });

  it("returns undefined when the relay metadata omits a public_key (no TOFU on garbage)", async () => {
    const storage = makeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage })).toBeUndefined();
    expect(storage.getItem(`motebit:relay_pin:${RELAY}`)).toBeNull();
  });
});

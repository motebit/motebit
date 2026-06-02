/**
 * Relay-key TOFU pin — the trust root for paid P2P fee-leg treasury derivation.
 * Locks the fail-closed-on-mismatch contract so a changed relay key disables
 * paid P2P (relay-mode still works) rather than redirecting an irreversible
 * payment, and confirms the store may be synchronous (web/desktop localStorage)
 * or asynchronous (mobile AsyncStorage).
 */
import { describe, it, expect, vi } from "vitest";
import {
  generateKeypair,
  signKeySuccession,
  bytesToHex,
  type KeySuccessionRecord,
} from "@motebit/crypto";
import { getOrPinRelayKey, type RelayKeyPinStorage } from "../relay-key-pin.js";

const RELAY = "https://relay.test";
const KEY_A = "aa".repeat(32);
const KEY_B = "bb".repeat(32);

function syncStorage(initial: Record<string, string> = {}): RelayKeyPinStorage & {
  store: Map<string, string>;
} {
  const m = new Map(Object.entries(initial));
  return {
    store: m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

function asyncStorage(initial: Record<string, string> = {}): RelayKeyPinStorage & {
  store: Map<string, string>;
} {
  const m = new Map(Object.entries(initial));
  return {
    store: m,
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
  };
}

const okFetch = (publicKey: string) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ public_key: publicKey }) }) as Response);

describe("getOrPinRelayKey", () => {
  it("trust-on-first-use: persists and returns the fetched key when no pin exists", async () => {
    const storage = syncStorage();
    const result = await getOrPinRelayKey(RELAY, { fetchImpl: okFetch(KEY_A), storage });
    expect(result).toBe(KEY_A);
    expect(storage.store.get(`motebit:relay_pin:${RELAY}`)).toBe(KEY_A);
  });

  it("works with an ASYNC store (mobile AsyncStorage shape)", async () => {
    const storage = asyncStorage();
    const first = await getOrPinRelayKey(RELAY, { fetchImpl: okFetch(KEY_A), storage });
    expect(first).toBe(KEY_A);
    // Second call reads the async-persisted pin and matches.
    const second = await getOrPinRelayKey(RELAY, { fetchImpl: okFetch(KEY_A), storage });
    expect(second).toBe(KEY_A);
  });

  it("returns the pin when the live key still matches it", async () => {
    const storage = syncStorage({ [`motebit:relay_pin:${RELAY}`]: KEY_A });
    expect(await getOrPinRelayKey(RELAY, { fetchImpl: okFetch(KEY_A), storage })).toBe(KEY_A);
  });

  it("FAILS CLOSED (undefined) and does not re-pin when the live key differs from the pin", async () => {
    const storage = syncStorage({ [`motebit:relay_pin:${RELAY}`]: KEY_A });
    const logger = { warn: vi.fn() };
    const result = await getOrPinRelayKey(RELAY, { fetchImpl: okFetch(KEY_B), storage, logger });
    expect(result).toBeUndefined();
    expect(storage.store.get(`motebit:relay_pin:${RELAY}`)).toBe(KEY_A); // pin untouched
    expect(logger.warn).toHaveBeenCalledWith("relay_key_pin.mismatch", expect.any(Object));
  });

  it("falls back to the existing pin when the fetch fails", async () => {
    const storage = syncStorage({ [`motebit:relay_pin:${RELAY}`]: KEY_A });
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage })).toBe(KEY_A);
  });

  it("returns undefined when the fetch fails and there is no pin", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage: syncStorage() })).toBeUndefined();
  });

  it("returns undefined when the relay metadata omits a public_key (no TOFU on garbage)", async () => {
    const storage = syncStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage })).toBeUndefined();
    expect(storage.store.get(`motebit:relay_pin:${RELAY}`)).toBeUndefined();
  });
});

// ── rotation-aware re-pin (verifies the relay's signed succession chain) ──

/** Mimic the relay's succession endpoint, which omits the (constant) suite. */
function endpointRecord(r: KeySuccessionRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...r };
  delete copy.suite;
  return copy;
}

/** Route /.well-known + /succession; everything else 404. */
function rotationFetch(opts: {
  livePublicKey: string;
  relayId?: string;
  chain?: Record<string, unknown>[];
  currentPublicKey?: string;
  successionStatus?: number;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/.well-known/motebit.json")) {
      return {
        ok: true,
        json: async () => ({
          public_key: opts.livePublicKey,
          ...(opts.relayId != null ? { relay_id: opts.relayId } : {}),
        }),
      } as Response;
    }
    if (url.includes("/succession")) {
      if (opts.successionStatus != null && opts.successionStatus >= 400) {
        return { ok: false, status: opts.successionStatus } as Response;
      }
      return {
        ok: true,
        json: async () => ({ chain: opts.chain ?? [], current_public_key: opts.currentPublicKey }),
      } as Response;
    }
    return { ok: false, status: 404 } as Response;
  });
}

describe("getOrPinRelayKey — rotation-aware re-pin", () => {
  it("re-pins when a signed succession chain proves pinned → fetched (legitimate rotation)", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();
    const oldHex = bytesToHex(oldKp.publicKey);
    const newHex = bytesToHex(newKp.publicKey);
    const rec = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    const storage = syncStorage({ [`motebit:relay_pin:${RELAY}`]: oldHex });
    const logger = { warn: vi.fn() };
    const fetchImpl = rotationFetch({
      livePublicKey: newHex,
      relayId: "relay-1",
      chain: [endpointRecord(rec)],
      currentPublicKey: newHex,
    });

    const result = await getOrPinRelayKey(RELAY, { fetchImpl, storage, logger });
    expect(result).toBe(newHex);
    // Pin advanced to the rotated key.
    expect(storage.store.get(`motebit:relay_pin:${RELAY}`)).toBe(newHex);
    expect(logger.warn).toHaveBeenCalledWith("relay_key_pin.rotated", expect.any(Object));
  });

  it("fails closed when the succession chain is valid but NOT rooted at the pinned key (equivocation)", async () => {
    // A valid X → C chain, but our pin is an unrelated key.
    const xKp = await generateKeypair();
    const cKp = await generateKeypair();
    const cHex = bytesToHex(cKp.publicKey);
    const rec = await signKeySuccession(
      xKp.privateKey,
      cKp.privateKey,
      cKp.publicKey,
      xKp.publicKey,
    );

    const pinnedHex = bytesToHex((await generateKeypair()).publicKey); // unrelated to the chain
    const storage = syncStorage({ [`motebit:relay_pin:${RELAY}`]: pinnedHex });
    const fetchImpl = rotationFetch({
      livePublicKey: cHex,
      relayId: "relay-1",
      chain: [endpointRecord(rec)],
      currentPublicKey: cHex,
    });

    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage })).toBeUndefined();
    expect(storage.store.get(`motebit:relay_pin:${RELAY}`)).toBe(pinnedHex); // pin untouched
  });

  it("fails closed when the key changed but no succession chain is available", async () => {
    const oldHex = bytesToHex((await generateKeypair()).publicKey);
    const newHex = bytesToHex((await generateKeypair()).publicKey);
    const storage = syncStorage({ [`motebit:relay_pin:${RELAY}`]: oldHex });
    const fetchImpl = rotationFetch({
      livePublicKey: newHex,
      relayId: "relay-1",
      successionStatus: 404,
    });
    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage })).toBeUndefined();
    expect(storage.store.get(`motebit:relay_pin:${RELAY}`)).toBe(oldHex);
  });

  it("fails closed on a tampered succession signature", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();
    const oldHex = bytesToHex(oldKp.publicKey);
    const newHex = bytesToHex(newKp.publicKey);
    const rec = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );
    const tampered = endpointRecord({ ...rec, new_key_signature: "00".repeat(64) });

    const storage = syncStorage({ [`motebit:relay_pin:${RELAY}`]: oldHex });
    const fetchImpl = rotationFetch({
      livePublicKey: newHex,
      relayId: "relay-1",
      chain: [tampered],
      currentPublicKey: newHex,
    });

    expect(await getOrPinRelayKey(RELAY, { fetchImpl, storage })).toBeUndefined();
    expect(storage.store.get(`motebit:relay_pin:${RELAY}`)).toBe(oldHex);
  });
});

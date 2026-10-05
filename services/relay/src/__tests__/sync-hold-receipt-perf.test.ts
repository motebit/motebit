/**
 * Cost of the sync hold receipt on the largest seq pull page (1000 events,
 * ~2 KB each — `EVENT_SEQ_PAGE_MAX`). The receipt digests every served entry
 * (JCS + SHA-256) and signs once; the page itself costs one
 * `JSON.stringify` to serve. The receipt is decoration on that response, so
 * it is bounded RELATIVE to serving the page, not by a wall-clock number
 * that varies with the runner: producing the receipt must cost no more than
 * a small multiple of serializing the page.
 *
 * Measured on the dev container (2026-10-05), same page, same harness:
 *   before (sequential awaited crypto.subtle digest per event): ~71–85 ms
 *   after  (synchronous JCS + node:crypto SHA-256):               ~30–38 ms
 *     of which JCS canonicalization of the entries is most; the receipt
 *     body's own JCS + Ed25519 signature ~3–5 ms
 *   page JSON.stringify:                                          ~4 ms
 * The bound below (≤ 8 × stringify + 15 ms) holds the after-number with
 * margin and fails the before-number. That is the cost a NONCE-BEARING
 * request pays (Inc 2's clients).
 *
 * A request without a usable nonce gets no receipt and pays for none (spec
 * §4.1): `tryHoldReceipt` returns before the `held` thunk. The deterministic
 * proof is the zero-work spies in `sync-hold-receipt-nonceless.test.ts`; the
 * timing sanity check here bounds the nonce-less call at ≤ 0.15 × the page's
 * own stringify (+ 0.5 ms), i.e. within noise of main's serve path.
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import { tryHoldReceipt, type HeldEvent } from "../sync-hold-receipt.js";
import type { RelayIdentity } from "../federation.js";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe("hold receipt cost on a full page", () => {
  it("1000 × ~2 KB page: receipt ≤ 8 × page stringify + 15 ms (median of 7)", async () => {
    const kp = await generateKeypair();
    const relay: RelayIdentity = {
      relayMotebitId: "relay-perf",
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: "did:key:perf",
    };
    const held: HeldEvent[] = Array.from({ length: 1000 }, (_, i) => {
      const served: EventLogEntry = {
        event_id: crypto.randomUUID(),
        motebit_id: "m",
        device_id: "d",
        event_type: EventType.StateUpdated,
        payload: { i, blob: "x".repeat(1900), nested: { a: 1, b: [1, 2, 3] } },
        version_clock: i + 1,
        timestamp: 1_760_000_000_000 + i,
        tombstoned: false,
      };
      return { event_id: served.event_id, served, redacted: false, seq: i + 1 };
    });
    const NONCE = "pF3s9Kq2LmZ0xWb4nYp1sKdE6a";
    const pageBody = { events: held.map((h) => ({ ...h.served, seq: h.seq })) };
    const page = { after_seq: 0, next_seq: 1000, has_more: false, latest_seq: 1000 };

    // Warm both paths (JIT), then measure.
    for (let k = 0; k < 2; k++) {
      JSON.stringify(pageBody);
      await tryHoldReceipt({
        relay,
        door: "http_pull",
        motebitId: "m",
        nonce: NONCE,
        held: () => held,
        page,
      });
    }
    const stringify: number[] = [];
    const receipt: number[] = [];
    for (let k = 0; k < 7; k++) {
      let t = performance.now();
      JSON.stringify(pageBody);
      stringify.push(performance.now() - t);
      t = performance.now();
      const r = await tryHoldReceipt({
        relay,
        door: "http_pull",
        motebitId: "m",
        nonce: NONCE,
        held: () => held,
        page,
      });
      receipt.push(performance.now() - t);
      expect(r?.events).toHaveLength(1000);
    }
    const s = median(stringify);
    const r = median(receipt);
    console.log(`hold-receipt perf: receipt ${r.toFixed(1)} ms, page stringify ${s.toFixed(1)} ms`);
    expect(r).toBeLessThanOrEqual(8 * s + 15);
  });

  it("a nonce-less request does no receipt work: ≤ 0.15 × page stringify + 0.5 ms", async () => {
    const kp = await generateKeypair();
    const relay: RelayIdentity = {
      relayMotebitId: "relay-perf",
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: "did:key:perf",
    };
    let thunkCalls = 0;
    const pageBody = {
      events: Array.from({ length: 1000 }, (_, i) => ({ i, blob: "x".repeat(1900) })),
    };
    const stringify: number[] = [];
    const nonceless: number[] = [];
    for (let k = 0; k < 9; k++) {
      let t = performance.now();
      JSON.stringify(pageBody);
      stringify.push(performance.now() - t);
      t = performance.now();
      const r = await tryHoldReceipt({
        relay,
        door: "http_pull",
        motebitId: "m",
        nonce: k % 2 === 0 ? undefined : "short",
        held: () => {
          thunkCalls++;
          return [];
        },
        page: { after_seq: 0, next_seq: 1000, has_more: false, latest_seq: 1000 },
      });
      nonceless.push(performance.now() - t);
      expect(r).toBeUndefined();
    }
    expect(thunkCalls).toBe(0);
    const s = median(stringify);
    const n = median(nonceless);
    console.log(
      `hold-receipt perf: nonce-less ${n.toFixed(3)} ms, page stringify ${s.toFixed(1)} ms`,
    );
    expect(n).toBeLessThanOrEqual(0.15 * s + 0.5);
  });
});

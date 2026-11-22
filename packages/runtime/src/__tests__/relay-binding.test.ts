/**
 * Relay equality and the binding generation (design runtime-relay-binding
 * rev 6 §3.1): two URLs are the same relay when both pin keys are non-null
 * and equal, or both are null and the raw strings are equal. A same-relay
 * rebind keeps the generation; a different relay, a key change or a path
 * change starts a new one.
 *
 * `relayPinKey` is a function of the raw string, so "the same raw string
 * with different non-null pin keys" cannot occur; the cases below cover
 * every pairing that can: equal keys from different spellings, different
 * keys, null keys equal / different raw strings, and one null with one
 * non-null.
 */
import { describe, expect, it } from "vitest";
import { relayPinKey } from "../relay-key-pin.js";
import { sameRelay, startsNewGeneration, type RelayBindingSnapshot } from "../relay-binding.js";

const authToken = async (): Promise<string> => "t";

function snap(syncUrl: string, extra: Partial<RelayBindingSnapshot> = {}): RelayBindingSnapshot {
  return { syncUrl, authToken, tools: true, invokeCapability: false, generation: 1, ...extra };
}

describe("sameRelay", () => {
  it("different spellings with the same non-null pin key are the same relay", () => {
    const a = "https://Relay-A.invalid/";
    const b = "https://relay-a.invalid";
    expect(a).not.toBe(b);
    expect(relayPinKey(a)).not.toBeNull();
    expect(relayPinKey(a)).toBe(relayPinKey(b));
    expect(sameRelay(a, b)).toBe(true);
  });

  it("different non-null pin keys are different relays", () => {
    expect(sameRelay("https://relay-a.invalid", "https://relay-b.invalid")).toBe(false);
    // The path is part of the key: two relays on one host stay distinct.
    expect(sameRelay("https://host.invalid/a", "https://host.invalid/b")).toBe(false);
  });

  it("null pin keys compare the raw strings", () => {
    // A space makes a URL unpinnable (relayPinKey → null); so does "".
    expect(relayPinKey("relay a")).toBeNull();
    expect(sameRelay("relay a", "relay a")).toBe(true);
    expect(sameRelay("relay a", "relay b")).toBe(false);
    expect(sameRelay("", "")).toBe(true);
  });

  it("a null pin key and a non-null one are different relays", () => {
    expect(sameRelay("", "https://relay-a.invalid")).toBe(false);
    expect(sameRelay("https://relay-a.invalid", "relay a")).toBe(false);
  });
});

describe("startsNewGeneration", () => {
  it("keeps the generation for the same relay under another spelling", () => {
    expect(
      startsNewGeneration(snap("https://relay-a.invalid"), snap("https://RELAY-A.invalid/")),
    ).toBe(false);
  });

  it("starts one for another relay, a key change, a path change, or from unbound", () => {
    const prev = snap("https://relay-a.invalid");
    expect(startsNewGeneration(prev, snap("https://relay-b.invalid"))).toBe(true);
    expect(
      startsNewGeneration(prev, snap("https://relay-a.invalid", { relayPublicKey: "ab" })),
    ).toBe(true);
    expect(startsNewGeneration(prev, snap("https://relay-a.invalid", { tools: false }))).toBe(true);
    expect(
      startsNewGeneration(prev, snap("https://relay-a.invalid", { invokeCapability: true })),
    ).toBe(true);
    expect(startsNewGeneration(null, prev)).toBe(true);
  });
});

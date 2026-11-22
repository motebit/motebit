/**
 * `MotebitRuntime.getDelegationRelay()` reports the runtime's ONE relay
 * binding: its URL and whether a key is pinned for it, or null while unbound
 * (design runtime-relay-binding rev 6, claim 6 and test 12).
 *
 * On main it reported only the task-query coordinates — set while empty by
 * any `enableInteractiveDelegation` and by the first-ever
 * `enableInvokeCapability`, cleared by `disableInteractiveDelegation` — so
 * after enable(A), enable(B) it said A while granted spend could be on B, and
 * after enable-invoke(A), disable, enable-invoke(B) it said null while taps
 * still went to A. Those enable/disable APIs are removed; this file pins the
 * binding's getter instead. The CLI's `/connect` reads it to decide whether a
 * session is already on a relay. Nothing in this file makes a request.
 */
import { describe, expect, it } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

const A = "https://a.relay.test";
const B = "https://b.relay.test";
const KEY = "ab".repeat(32);
const authToken = (): Promise<string> => Promise.resolve("t");

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "getter-000", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

describe("getDelegationRelay: the one relay binding", () => {
  it("null unbound; every bind reports its relay and pin; unbind clears it", () => {
    const runtime = makeRuntime();
    expect(runtime.getDelegationRelay()).toBeNull();

    runtime.bindRelay({ syncUrl: A, authToken, tools: true, invokeCapability: false });
    expect(runtime.getDelegationRelay()).toEqual({ url: A, pinned: false });

    // A rebind to another relay moves it — the last bind wins.
    runtime.bindRelay({
      syncUrl: B,
      authToken,
      relayPublicKey: KEY,
      tools: true,
      invokeCapability: true,
    });
    expect(runtime.getDelegationRelay()).toEqual({ url: B, pinned: true });

    // The same relay without a key: still B, no longer pinned.
    runtime.bindRelay({ syncUrl: B, authToken, tools: true, invokeCapability: true });
    expect(runtime.getDelegationRelay()).toEqual({ url: B, pinned: false });

    runtime.unbindRelay();
    expect(runtime.getDelegationRelay()).toBeNull();
    // Idempotent.
    runtime.unbindRelay();
    expect(runtime.getDelegationRelay()).toBeNull();

    // A tap-only binding is still the binding (main reported null here).
    const tapOnly = makeRuntime();
    tapOnly.bindRelay({ syncUrl: A, authToken, tools: false, invokeCapability: true });
    expect(tapOnly.getDelegationRelay()).toEqual({ url: A, pinned: false });
    tapOnly.unbindRelay();
    expect(tapOnly.getDelegationRelay()).toBeNull();
    tapOnly.bindRelay({ syncUrl: B, authToken, tools: false, invokeCapability: true });
    expect(tapOnly.getDelegationRelay()).toEqual({ url: B, pinned: false });
  });
});

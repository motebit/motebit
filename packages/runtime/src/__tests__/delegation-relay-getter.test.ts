/**
 * `MotebitRuntime.getDelegationRelay()` reports the relay of the runtime's
 * task-query coordinates and nothing else: set only while empty by any
 * `enableInteractiveDelegation` call and by the first-ever
 * `enableInvokeCapability` call, cleared by `disableInteractiveDelegation`.
 *
 * The CLI's `/connect` reads it to decide whether a session is already on a
 * relay, so the first-wins and cleared-on-disable behaviour is pinned here.
 * Nothing in this file makes a request.
 */
import { describe, expect, it } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

const A = "https://a.relay.test";
const B = "https://b.relay.test";
const authToken = (): Promise<string> => Promise.resolve("t");

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "getter-000", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

describe("getDelegationRelay: the relay of the task-query coordinates", () => {
  it("null before any enable; the first enable wins; a disable clears it; a first-ever enable-invoke sets it and a later one does not", () => {
    const runtime = makeRuntime();
    expect(runtime.getDelegationRelay()).toBeNull();

    runtime.enableInteractiveDelegation({ syncUrl: A, authToken });
    expect(runtime.getDelegationRelay()).toEqual({ url: A });

    // A second enable for another relay does not move it.
    runtime.enableInteractiveDelegation({ syncUrl: B, authToken });
    expect(runtime.getDelegationRelay()).toEqual({ url: A });

    runtime.disableInteractiveDelegation();
    expect(runtime.getDelegationRelay()).toBeNull();

    // Empty again, so a re-enable of interactive delegation binds the new relay.
    runtime.enableInteractiveDelegation({ syncUrl: B, authToken });
    expect(runtime.getDelegationRelay()).toEqual({ url: B });

    // enable-invoke(A), disable, enable-invoke(B): the second enable-invoke
    // returns before it reaches the coordinates, so nothing is reported.
    const tapOnly = makeRuntime();
    tapOnly.enableInvokeCapability({ syncUrl: A, authToken });
    expect(tapOnly.getDelegationRelay()).toEqual({ url: A });
    tapOnly.disableInteractiveDelegation();
    expect(tapOnly.getDelegationRelay()).toBeNull();
    tapOnly.enableInvokeCapability({ syncUrl: B, authToken });
    expect(tapOnly.getDelegationRelay()).toBeNull();
  });
});

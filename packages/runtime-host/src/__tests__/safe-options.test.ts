/**
 * The wire→runtime option narrowing is a privilege boundary: an
 * attached process is authenticated as this device, but authority
 * fields (`verifiedGrant`, `userActionAttestation`, `goalContext`)
 * must never be assertable over the socket — only the coordinator's
 * own verification paths may produce them
 * (docs/doctrine/memory-never-confers-authority.md).
 */
import { describe, expect, it } from "vitest";
import { pickSafeChatOptions, pickSafeInvokeOptions } from "../safe-options.js";

describe("pickSafeChatOptions", () => {
  it("passes the safe rendering subset through", () => {
    expect(pickSafeChatOptions({ delegationScope: "scope:x", suppressHistory: true })).toEqual({
      delegationScope: "scope:x",
      suppressHistory: true,
    });
  });

  it("strips authority fields a wire peer must never assert", () => {
    const picked = pickSafeChatOptions({
      verifiedGrant: { grant_id: "g-1", verified_at: 123 },
      userActionAttestation: { kind: "tap" },
      goalContext: { goal_id: "g", goal_prompt: "p" },
      suppressHistory: true,
    });
    expect(picked).toEqual({ suppressHistory: true });
    expect(picked).not.toHaveProperty("verifiedGrant");
    expect(picked).not.toHaveProperty("userActionAttestation");
    expect(picked).not.toHaveProperty("goalContext");
  });

  it("ignores wrong-typed values rather than forwarding them", () => {
    expect(pickSafeChatOptions({ delegationScope: 42, suppressHistory: "yes" })).toEqual({});
  });

  it("passes undefined through untouched", () => {
    expect(pickSafeChatOptions(undefined)).toBeUndefined();
  });
});

describe("pickSafeInvokeOptions", () => {
  it("passes targetWorkerId and acknowledgeNoHistoryRisk", () => {
    expect(
      pickSafeInvokeOptions({ targetWorkerId: "w-1", acknowledgeNoHistoryRisk: true }),
    ).toEqual({ targetWorkerId: "w-1", acknowledgeNoHistoryRisk: true });
  });

  it("returns an empty picked set for undefined", () => {
    expect(pickSafeInvokeOptions(undefined)).toEqual({});
  });

  it("never forwards invocationOrigin, a signal, or wrong-typed fields", () => {
    const picked = pickSafeInvokeOptions({
      invocationOrigin: "model-initiated",
      signal: "fake",
      targetWorkerId: 7,
      acknowledgeNoHistoryRisk: "yes",
    });
    expect(picked).toEqual({});
  });
});

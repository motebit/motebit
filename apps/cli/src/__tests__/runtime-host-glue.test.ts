/**
 * The wire→runtime option narrowing is a privilege boundary: an
 * attached process is authenticated as this device, but authority
 * fields (`verifiedGrant`, `userActionAttestation`, `goalContext`) must
 * never be assertable over the socket — only the coordinator's own
 * verification paths may produce them
 * (docs/doctrine/memory-never-confers-authority.md).
 */
import { describe, expect, it } from "vitest";
import { pickChatOptions, pickInvokeOptions } from "../runtime-host.js";

describe("pickChatOptions", () => {
  it("passes the safe rendering subset through", () => {
    expect(pickChatOptions({ delegationScope: "scope:x", suppressHistory: true })).toEqual({
      delegationScope: "scope:x",
      suppressHistory: true,
    });
  });

  it("strips authority fields a wire peer must never assert", () => {
    const picked = pickChatOptions({
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
    expect(pickChatOptions({ delegationScope: 42, suppressHistory: "yes" })).toEqual({});
  });

  it("passes undefined through untouched", () => {
    expect(pickChatOptions(undefined)).toBeUndefined();
  });
});

describe("pickInvokeOptions", () => {
  it("passes targetWorkerId and acknowledgeNoHistoryRisk", () => {
    expect(pickInvokeOptions({ targetWorkerId: "w-1", acknowledgeNoHistoryRisk: true })).toEqual({
      targetWorkerId: "w-1",
      acknowledgeNoHistoryRisk: true,
    });
  });

  it("never forwards invocationOrigin or a signal from the wire", () => {
    const picked = pickInvokeOptions({
      invocationOrigin: "model-initiated",
      signal: "fake",
      targetWorkerId: "w-1",
    });
    expect(picked).toEqual({ targetWorkerId: "w-1" });
    expect(picked).not.toHaveProperty("invocationOrigin");
    expect(picked).not.toHaveProperty("signal");
  });
});

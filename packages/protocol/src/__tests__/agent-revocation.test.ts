import { describe, it, expect } from "vitest";
import {
  ALL_AGENT_REVOCATION_REASONS,
  isAgentRevocationReason,
  isAgentRevocationRecord,
  AGENT_REVOCATION_SUITE,
  AGENT_REVOCATION_SPEC_ID,
  type AgentRevocationReason,
  type AgentRevocationRecord,
} from "../agent-revocation.js";

// `AgentRevocationReason` canonical-registry tests — the ninth registered
// registry per `docs/doctrine/registry-pattern-canonical.md`. The
// per-registry coverage gate (`check-agent-revocation-reason-canonical`)
// enforces sibling-alignment with the union; this file locks the iteration
// + guard primitives, plus the signed-record structural guard.

describe("ALL_AGENT_REVOCATION_REASONS", () => {
  it("is a frozen array (registry pattern)", () => {
    expect(Object.isFrozen(ALL_AGENT_REVOCATION_REASONS)).toBe(true);
  });

  it("enumerates the closed set in canonical order", () => {
    expect(ALL_AGENT_REVOCATION_REASONS).toEqual([
      "operator_test_cleanup",
      "spam",
      "abuse",
      "malware",
      "policy_violation",
      "dmca",
      "reinstated",
    ]);
  });

  it("contains every literal in the AgentRevocationReason union", () => {
    // Exhaustive switch — TypeScript catches a missing arm at compile time.
    const acc: AgentRevocationReason[] = [];
    for (const reason of ALL_AGENT_REVOCATION_REASONS) {
      switch (reason) {
        case "operator_test_cleanup":
        case "spam":
        case "abuse":
        case "malware":
        case "policy_violation":
        case "dmca":
        case "reinstated":
          acc.push(reason);
          break;
      }
    }
    expect(acc).toHaveLength(ALL_AGENT_REVOCATION_REASONS.length);
  });

  it("contains no duplicates", () => {
    expect(new Set(ALL_AGENT_REVOCATION_REASONS).size).toBe(ALL_AGENT_REVOCATION_REASONS.length);
  });
});

describe("isAgentRevocationReason", () => {
  it("returns true for every member", () => {
    for (const reason of ALL_AGENT_REVOCATION_REASONS) {
      expect(isAgentRevocationReason(reason)).toBe(true);
    }
  });

  it("returns false for unknown / malformed values", () => {
    expect(isAgentRevocationReason("censorship")).toBe(false);
    expect(isAgentRevocationReason("SPAM")).toBe(false); // case-sensitive
    expect(isAgentRevocationReason("")).toBe(false);
    expect(isAgentRevocationReason(null)).toBe(false);
    expect(isAgentRevocationReason(undefined)).toBe(false);
    expect(isAgentRevocationReason(0)).toBe(false);
    expect(isAgentRevocationReason(["spam"])).toBe(false);
  });
});

describe("isAgentRevocationRecord", () => {
  const valid: AgentRevocationRecord = {
    spec: AGENT_REVOCATION_SPEC_ID,
    motebit_id: "019dd011-0000-7000-8000-00000000be7c",
    revoked: true,
    reason: "operator_test_cleanup",
    actor: "operator",
    effective_at: 1_780_000_000_000,
    relay_id: "019d6828-969e-7e9b-baa2-481ece0f80c2",
    relay_public_key: "a".repeat(64),
    hash: "b".repeat(64),
    suite: AGENT_REVOCATION_SUITE,
    signature: "c".repeat(128),
  };

  it("accepts a well-formed revoke record", () => {
    expect(isAgentRevocationRecord(valid)).toBe(true);
  });

  it("accepts an unrevoke record (revoked:false, reason reinstated)", () => {
    expect(isAgentRevocationRecord({ ...valid, revoked: false, reason: "reinstated" })).toBe(true);
  });

  it("accepts an optional note", () => {
    expect(isAgentRevocationRecord({ ...valid, note: "leftover smoke-test agent" })).toBe(true);
  });

  it("rejects an unrecognized reason (fails closed on the signed surface)", () => {
    expect(isAgentRevocationRecord({ ...valid, reason: "censorship" })).toBe(false);
  });

  it("rejects an unknown actor", () => {
    expect(isAgentRevocationRecord({ ...valid, actor: "anonymous" })).toBe(false);
  });

  it("rejects a non-boolean revoked", () => {
    expect(isAgentRevocationRecord({ ...valid, revoked: "true" })).toBe(false);
  });

  it("rejects a non-string note", () => {
    expect(isAgentRevocationRecord({ ...valid, note: 42 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isAgentRevocationRecord(null)).toBe(false);
    expect(isAgentRevocationRecord("revoked")).toBe(false);
  });
});

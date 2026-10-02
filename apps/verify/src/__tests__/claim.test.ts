import { describe, it, expect } from "vitest";
import { buildClaim, claimTime, RESULT_PREVIEW_CHARS } from "../claim.js";

describe("buildClaim", () => {
  const base = {
    task_id: "t-1",
    motebit_id: "m-1",
    status: "completed",
    result: "hello",
    submitted_at: 1790000000000,
    completed_at: 1790000002000,
    tools_used: ["read_url", 7, "web_search"],
    memories_formed: 3,
  };

  it("maps the signed fields to plain words", () => {
    const c = buildClaim(base, { integrity: true, binding: "sovereign" })!;
    expect(c.status).toBe("completed");
    expect(c.result).toBe("hello");
    expect(c.resultTruncated).toBe(false);
    expect(c.submitted?.iso).toBe("2026-09-21T14:13:20.000Z");
    expect(c.completed?.iso).toBe("2026-09-21T14:13:22.000Z");
    expect(c.submitted?.local.length).toBeGreaterThan(0);
    expect(c.toolsUsed).toEqual(["read_url", "web_search"]); // non-strings dropped
    expect(c.memoriesFormed).toBe(3);
    expect(c.delegatedScope).toBeUndefined();
    expect(c.delegationCount).toBe(0);
    expect(c.verdict).toBe("valid");
  });

  it("verdict is invalid without a view or when integrity is false", () => {
    expect(buildClaim(base)!.verdict).toBe("invalid");
    expect(buildClaim(base, { integrity: false, binding: "unverified" })!.verdict).toBe("invalid");
  });

  it("truncates a long result but keeps the full text", () => {
    const long = "a".repeat(RESULT_PREVIEW_CHARS + 10);
    const c = buildClaim({ ...base, result: long })!;
    expect(c.resultTruncated).toBe(true);
    expect(c.resultPreview).toBe("a".repeat(RESULT_PREVIEW_CHARS) + "…");
    expect(c.result).toBe(long);
  });

  it("pairs delegation_receipts[i] with view.delegations[i], recursively", () => {
    const grandchild = { task_id: "gc", delegated_scope: "read_url" };
    const child = { task_id: "c", delegated_scope: "research", delegation_receipts: [grandchild] };
    const c = buildClaim(
      { ...base, delegation_receipts: [child, "junk"] },
      {
        integrity: false,
        binding: "unverified",
        delegations: [
          {
            integrity: true,
            binding: "integrity-only",
            delegations: [{ integrity: false, binding: "unverified" }],
          },
        ],
      },
    )!;
    expect(c.delegationCount).toBe(2); // as carried
    expect(c.delegations).toHaveLength(1); // the non-object entry has no claim
    expect(c.delegations[0]!.delegatedScope).toBe("research");
    expect(c.delegations[0]!.verdict).toBe("valid");
    expect(c.delegations[0]!.delegations[0]!.taskId).toBe("gc");
    expect(c.delegations[0]!.delegations[0]!.verdict).toBe("invalid");
  });

  it("rejects non-objects and ignores ill-typed fields", () => {
    expect(buildClaim(null)).toBeNull();
    expect(buildClaim([1])).toBeNull();
    const c = buildClaim({ status: 1, result: {}, submitted_at: "x", memories_formed: "2" })!;
    expect(c.status).toBeUndefined();
    expect(c.result).toBeUndefined();
    expect(c.submitted).toBeUndefined();
    expect(c.memoriesFormed).toBeUndefined();
    expect(claimTime(Number.NaN)).toBeUndefined();
    expect(claimTime(8.64e15 + 1)).toBeUndefined(); // out of Date range
  });
});

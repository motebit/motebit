import { describe, it, expect } from "vitest";
import { cmdRuns } from "../commands/runs.js";
import type { MotebitRuntime } from "../index.js";
import type { RunLedgerReader, RunLedgerDetail } from "@motebit/sdk";

/**
 * The return view, asked from a surface that did not do the work.
 *
 * What it must never do is answer as if it had looked. A phone that
 * cannot see the ledger and says "no runs recorded" tells its owner
 * their motebit did nothing, which is the failure this whole arc is
 * built around — so the two cases are asserted apart first.
 */
function runtimeWith(ledger: RunLedgerReader | null): MotebitRuntime {
  return {
    runLedger: ledger,
    // The membrane an approval's arguments already pass through. A stub
    // that masks a recognisable token proves the command routes through
    // it rather than around it.
    redactForRemoteDisclosure: (t: string) => t.replace(/sk-[A-Za-z0-9-]+/g, "[REDACTED]"),
  } as unknown as MotebitRuntime;
}

const DETAIL: RunLedgerDetail = {
  run_id: "run-abcdef0123",
  goal_id: "goal-123456",
  status: "completed",
  started_at: 1_000,
  signed: true,
  evidence_count: 1,
  withheld_count: 1,
  outcomes: [{ status: "completed", summary_preview: "Reviewed three filings.", signed: true }],
  tool_calls: [{ tool: "read_url", verdict: "ok" }],
  evidence: [
    {
      tool: "read_url",
      ref: "https://example.gov/filing",
      digest: "sha-256:" + "a".repeat(64),
      projection: "agency.html-text.v1",
    },
  ],
  withheld: [{ tool: "read_url", reason: "the source carried a credential" }],
};

describe("runs — the return view from another surface", () => {
  it("a surface without the ledger says so, and does NOT say nothing happened", () => {
    const r = cmdRuns(runtimeWith(null));
    expect(r.summary).toContain("cannot see the run ledger");
    expect(r.summary).not.toContain("No runs");
    expect(r.detail).toContain("not the same as nothing having happened");
  });

  it("an empty ledger is allowed to say the ledger is empty", () => {
    // The other absence, and it IS knowable here: this process holds
    // the record and the record is empty.
    const r = cmdRuns(runtimeWith({ listRecent: () => [], get: () => null }));
    expect(r.summary).toBe("No runs recorded yet.");
  });

  it("a list says, per run, whether it is signed and how much is checkable", () => {
    const r = cmdRuns(
      runtimeWith({
        listRecent: () => [
          {
            run_id: "run-abcdef0123",
            goal_id: "goal-123456",
            status: "completed",
            started_at: 1,
            signed: true,
            evidence_count: 2,
            withheld_count: 1,
          },
        ],
        get: () => null,
      }),
    );
    expect(r.detail).toContain("signed");
    expect(r.detail).toContain("2 checkable");
    expect(r.detail).toContain("1 withheld");
  });

  it("does NOT send the verbatim result — a signature is checked where it was made", () => {
    // A copy crossing a relay cannot be checked against the signature by
    // the surface that receives it, so presenting it as the result would
    // offer proof that is not there.
    const r = cmdRuns(runtimeWith({ listRecent: () => [], get: () => DETAIL }), "run-abcd");
    expect(r.detail).toContain("read it in full on the machine that signed it");
    expect(r.detail).toContain("Reviewed three filings.");
    expect(r.detail).not.toContain("response_full");
  });

  it("carries the source and the WHOLE digest, so the pointer can be acted on", () => {
    const r = cmdRuns(runtimeWith({ listRecent: () => [], get: () => DETAIL }), "run-abcd");
    expect(r.detail).toContain("https://example.gov/filing");
    expect(r.detail).toContain("sha-256:" + "a".repeat(64));
    expect(r.detail).toContain("agency.html-text.v1");
  });

  it("shows a withholding as a withholding, not as an absence", () => {
    const r = cmdRuns(runtimeWith({ listRecent: () => [], get: () => DETAIL }), "run-abcd");
    expect(r.detail).toContain("Withheld (1)");
    expect(r.detail).toContain("deliberately not kept");
  });

  it("every text that crosses the relay goes through the membrane", () => {
    const leaky: RunLedgerDetail = {
      ...DETAIL,
      note: "paused on sk-live-AAAAAAAAAAAAAAAA",
      outcomes: [
        { status: "failed", error_message: "key sk-live-BBBBBBBBBBBBBBBB", signed: false },
      ],
      evidence: [
        { tool: "read_url", ref: "https://host/x?k=sk-live-CCCCCCCCCCCCCCCC", digest: "sha-256:x" },
      ],
    };
    const r = cmdRuns(runtimeWith({ listRecent: () => [], get: () => leaky }), "run-abcd");
    expect(r.detail).not.toContain("sk-live");
    expect(r.detail).toContain("[REDACTED]");
  });

  it("an unknown run is not reported as an empty one", () => {
    const r = cmdRuns(runtimeWith({ listRecent: () => [], get: () => null }), "nope");
    expect(r.summary).toContain('No run matching "nope"');
  });
});

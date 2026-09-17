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
  holding: false,
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
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "missing" as const }) }),
    );
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
            holding: false,
            signed: true,
            evidence_count: 2,
            withheld_count: 1,
          },
        ],
        get: () => ({ kind: "missing" as const }),
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
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "found" as const, run: DETAIL }) }),
      "run-abcd",
    );
    expect(r.detail).toContain("read it in full on the machine that signed it");
    expect(r.detail).toContain("Reviewed three filings.");
    expect(r.detail).not.toContain("response_full");
  });

  it("carries the source and the WHOLE digest, so the pointer can be acted on", () => {
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "found" as const, run: DETAIL }) }),
      "run-abcd",
    );
    expect(r.detail).toContain("https://example.gov/filing");
    expect(r.detail).toContain("sha-256:" + "a".repeat(64));
    expect(r.detail).toContain("agency.html-text.v1");
  });

  it("shows a withholding as a withholding, not as an absence", () => {
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "found" as const, run: DETAIL }) }),
      "run-abcd",
    );
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
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "found" as const, run: leaky }) }),
      "run-abcd",
    );
    expect(r.detail).not.toContain("sk-live");
    expect(r.detail).toContain("[REDACTED]");
  });

  it("the structured payload passes the membrane too, not just the text", () => {
    // `data` is serialized whole and returned through the relay, so a
    // redacted string beside a raw object is no protection at all —
    // the defect this arc found in the approvals command, reproduced
    // here until both were derived from one redacted value. The first
    // version of the test above asserted only on `detail`, which is
    // exactly how it went unnoticed.
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
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "found" as const, run: leaky }) }),
      "run-abcd",
    );
    expect(JSON.stringify(r.data)).not.toContain("sk-live");
    expect(JSON.stringify(r.data)).toContain("[REDACTED]");
  });

  it("an ambiguous prefix is refused, not reported as no such run", () => {
    // It matched several. Saying "no run matching" would deny a run the
    // list had just printed.
    const r = cmdRuns(
      runtimeWith({
        listRecent: () => [],
        get: () => ({ kind: "ambiguous" as const, matches: ["run-a1", "run-a2"] }),
      }),
      "run-a",
    );
    expect(r.summary).toContain("matches 2 runs");
    expect(r.summary).not.toContain("No run matching");
  });

  it("the list payload crosses the membrane too, not only the detail's", () => {
    // `note` is written from a caught error, so a run that failed
    // against a token-bearing URL carried that token into the summary
    // row — and `data` is serialized whole through the relay. The
    // detail path was fixed first and this sibling was not.
    const r = cmdRuns(
      runtimeWith({
        listRecent: () => [
          {
            run_id: "run-abcdef0123",
            goal_id: "goal-123456",
            status: "interrupted",
            started_at: 1,
            holding: true,
            signed: false,
            evidence_count: 0,
            withheld_count: 0,
            note: "fetch failed for key sk-live-AAAAAAAAAAAAAAAA",
          },
        ],
        get: () => ({ kind: "missing" as const }),
      }),
    );
    expect(JSON.stringify(r.data)).not.toContain("sk-live");
    expect(r.detail).not.toContain("sk-live");
    // And it is RENDERED, not merely fetched and dropped: a line that
    // says `interrupted` without saying why sends the reader looking
    // for a reason the row already holds.
    expect(r.detail).toContain("fetch failed");
  });

  it("`list` and `show <id>` are verbs, not run ids", () => {
    // Every word after the verb used to be read as an id, so `runs
    // list` answered "No run matching \"list\"" — an absence about a
    // run nobody asked about, from the command built to stop exactly
    // that.
    const ledger = {
      listRecent: () => [],
      get: (id: string) =>
        id === "run-abcd"
          ? ({ kind: "found", run: DETAIL } as const)
          : ({ kind: "missing" } as const),
    };
    expect(cmdRuns(runtimeWith(ledger), "list").summary).toBe("No runs recorded yet.");
    expect(cmdRuns(runtimeWith(ledger), "show run-abcd").summary).toContain("run-abcd");
    expect(cmdRuns(runtimeWith(ledger), "run-abcd").summary).toContain("run-abcd");
  });

  it("a held run is marked as needing a person, and every line carries a time", () => {
    // `status` alone cannot say it: an `interrupted` run that has been
    // acknowledged and one still waiting read identically, and only one
    // of them is something the returning owner has to act on. The
    // reader sorted these first and nothing rendered the fact.
    const r = cmdRuns(
      runtimeWith({
        listRecent: () => [
          {
            run_id: "run-held0001",
            goal_id: "goal-1",
            status: "interrupted",
            started_at: Date.now() - 3 * 60 * 60 * 1000,
            holding: true,
            signed: false,
            evidence_count: 0,
            withheld_count: 0,
          },
        ],
        get: () => ({ kind: "missing" as const }),
      }),
    );
    expect(r.detail).toContain("needs you");
    expect(r.detail).toContain("3h ago");
  });

  it("a refusal is redacted and bounded in that order, not bounded and then read", () => {
    // Every credential pattern is length-anchored, so a secret
    // straddling the cut is reduced to a stub nothing matches. The
    // reader hands the body over whole precisely so the membrane reads
    // it whole; bounding first put the tail of a key on the wire.
    const straddling: RunLedgerDetail = {
      ...DETAIL,
      outcomes: [
        {
          status: "completed",
          summary_preview: `${"x".repeat(275)}sk-live-AAAAAAAAAAAAAAAAAAAA tail`,
          signed: false,
        },
      ],
    };
    const r = cmdRuns(
      runtimeWith({
        listRecent: () => [],
        get: () => ({ kind: "found" as const, run: straddling }),
      }),
      "run-abcd",
    );
    expect(JSON.stringify(r.data)).not.toContain("sk-live");
    // Still bounded — the redaction does not license an unbounded body.
    const preview = (r.data as { run: RunLedgerDetail }).run.outcomes[0]?.summary_preview ?? "";
    expect(preview.length).toBeLessThanOrEqual(281);
  });

  it("`ack` is answered as a local act, not as a missing run", () => {
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "missing" as const }) }),
      "ack run-abcd",
    );
    expect(r.summary).not.toContain("No run matching");
    expect(r.detail).toContain("motebit runs ack");
  });

  it("a stray word after `show` does not become part of the id", () => {
    // Anchoring on a single trailing token meant `show abc123 please`
    // fell through and was read whole as an id, answering `No run
    // matching "show abc123 please"` — the manufactured absence this
    // parser was written to remove, one stray word away.
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "found" as const, run: DETAIL }) }),
      "show run-abcd please",
    );
    expect(r.summary).toContain("run-abcd");
    expect(r.summary).not.toContain("No run matching");
  });

  it("a bare `show` is the list, not a run called show", () => {
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "missing" as const }) }),
      "show",
    );
    expect(r.summary).toBe("No runs recorded yet.");
  });

  it("an unknown run is not reported as an empty one", () => {
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "missing" as const }) }),
      "nope",
    );
    expect(r.summary).toContain('No run matching "nope"');
  });
});

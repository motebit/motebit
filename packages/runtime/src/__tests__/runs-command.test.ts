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
    // The REPORT seam, wider than the decision seam beside it.
    redactReportForRemoteDisclosure: (t: string) => t.replace(/sk-[A-Za-z0-9-]+/g, "[REDACTED]"),
    // And the SOURCE seam: a URL the owner is told to re-fetch, which
    // has to survive masking to be worth anything. The real one splits
    // path from query; this stub only has to prove the command routes
    // through it rather than around it.
    redactSourceForRemoteDisclosure: (t: string) => t.replace(/sk-[A-Za-z0-9-]+/g, "[REDACTED]"),
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

  it("the detail is bounded, and says what it left out", () => {
    // Everything else in this view is bounded — ten runs, a 280-char
    // preview — and the detail was not: neither query carries a LIMIT.
    // An overnight run with hundreds of tool calls produced a response
    // of hundreds of lines, through a 30-second relay timeout, rendered
    // on a phone as one message.
    const many: RunLedgerDetail = {
      ...DETAIL,
      tool_calls: Array.from({ length: 120 }, (_, i) => ({ tool: `t${i}`, verdict: "ok" })),
      evidence: Array.from({ length: 60 }, (_, i) => ({
        tool: "read_url",
        ref: `https://example.gov/${i}`,
        digest: "sha-256:x",
      })),
    };
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "found" as const, run: many }) }),
      "run-abcd",
    );
    const payload = r.data as { run: RunLedgerDetail };
    expect(payload.run.tool_calls.length).toBeLessThanOrEqual(40);
    expect(payload.run.evidence.length).toBeLessThanOrEqual(20);
    // The COUNT in the header stays the run's true total — a bounded
    // list must not read as a complete one.
    expect(r.detail).toContain("Tool calls (120)");
    expect(r.detail).toContain("Evidence (60)");
    expect(r.detail).toMatch(/and 80 more/);
    expect(r.detail).toMatch(/and 40 more/);
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
    // And it does not tell someone standing on the machine that holds
    // the record to go somewhere else — this reader is wired on the
    // interactive terminal too, so the sentence has to be true read
    // from either side.
    expect(r.summary).not.toMatch(/happens where the run is/i);
    expect(r.detail).not.toMatch(/on that machine|run it there/i);
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

  it("a word after a verb is never read as an id in its own right", () => {
    // `runs list abc123` answered `No run matching "list"` — an absence
    // about a run nobody named, from the parser written to stop that.
    const ledger = {
      listRecent: () => [],
      get: () => ({ kind: "missing" as const }),
    };
    expect(cmdRuns(runtimeWith(ledger), "list abc123").summary).toBe("No runs recorded yet.");
    expect(cmdRuns(runtimeWith(ledger), "list abc123").summary).not.toContain("No run matching");
  });

  it("a bare `show` is the list, not a run called show", () => {
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "missing" as const }) }),
      "show",
    );
    expect(r.summary).toBe("No runs recorded yet.");
  });

  it("asked at the terminal, the owner reads their own record unmasked", () => {
    // Nothing is crossing a wire. Masking here protects no one and made
    // `/runs <id>` in the REPL disagree with `motebit runs show <id>`
    // in the same shell about the same run.
    const leaky: RunLedgerDetail = {
      ...DETAIL,
      outcomes: [{ status: "completed", summary_preview: "key sk-live-AAAA", signed: false }],
    };
    const ledger = { listRecent: () => [], get: () => ({ kind: "found" as const, run: leaky }) };
    expect(cmdRuns(runtimeWith(ledger), "run-abcd", "local").detail).toContain("sk-live-AAAA");
    expect(cmdRuns(runtimeWith(ledger), "run-abcd", "remote").detail).not.toContain("sk-live-AAAA");
    // And the default is the closed one, so a caller that forgets
    // redacts rather than discloses.
    expect(cmdRuns(runtimeWith(ledger), "run-abcd").detail).not.toContain("sk-live-AAAA");
  });

  it("keeps an ordinary evidence source legible — it is the affordance", () => {
    // The prose beside it says to re-fetch the source and hash it, so a
    // digest next to an erased URL proves nothing to anybody. The
    // report set would mask a long object key as base64 and a nine-digit
    // document id as an SSN; the credential-class set leaves both.
    const r = cmdRuns(
      runtimeWith({
        listRecent: () => [],
        get: () => ({
          kind: "found" as const,
          run: {
            ...DETAIL,
            evidence: [
              {
                tool: "read_url",
                ref: "https://example.gov/edgar/data/320193/000032019324000123-index.htm",
                digest: "d",
              },
            ],
          },
        }),
      }),
      "run-abcd",
    );
    expect(r.detail).toContain(
      "https://example.gov/edgar/data/320193/000032019324000123-index.htm",
    );
  });

  it("an unknown run is not reported as an empty one", () => {
    // Run ids are uuids, so a miss on a hex-shaped target is a real
    // absence: this id was looked for and is not there.
    const r = cmdRuns(
      runtimeWith({ listRecent: () => [], get: () => ({ kind: "missing" as const }) }),
      "abc123",
    );
    expect(r.summary).toContain('No run matching "abc123"');
  });

  it("a word that was never a run id is told so, not reported as a missing run", () => {
    // `runs help`, `runs recent`, `runs all` answered `No run matching
    // "help"` — an absence about a run nobody asked about, which is the
    // thing the verb handling exists to stop, left open for every word
    // but `ack`. Judged AFTER the lookup, never before it: the ledger
    // is the authority on what exists, and the shape only chooses the
    // wording of a miss.
    const ledger = { listRecent: () => [], get: () => ({ kind: "missing" as const }) };
    for (const word of ["help", "recent", "all", "status"]) {
      const r = cmdRuns(runtimeWith(ledger), word);
      expect(r.summary).not.toContain("No run matching");
      expect(r.summary).toContain("is not a run id");
    }
  });
});

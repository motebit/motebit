/**
 * `runs` — what happened while you were away, from a surface that is
 * not the one that did the work.
 *
 * The last clause of the unattended arc reached only the machine
 * running the daemon, because that is where the run ledger, the
 * outcomes and the evidence live. A person coming back to their motebit
 * is usually holding a phone, and the phone is already the consent
 * root: it can stop the motebit and decide an approval, and could see
 * nothing of what either was about.
 *
 * So the return view reaches it the same way stopping does — a signed
 * request to the runtime that has the answer. The envelope is signed by
 * the motebit's own identity key, so no privilege is added; what is
 * added is reach.
 *
 * Two things this deliberately does NOT do. It does not send the
 * verbatim result: a signed artifact is fetched from the machine that
 * signed it, because a summary crossing a relay cannot be checked
 * against the signature by the surface that reads it, and offering it as
 * the result would be offering proof that is not there. And every piece
 * of text that does cross goes through the same credential-class
 * membrane as an approval's arguments, because the relay is not a
 * sovereign party.
 */

import type { MotebitRuntime } from "../index.js";
import type { CommandResult } from "./types.js";

/** How many runs a list answers with. A return view, not an archive. */
const RECENT_LIMIT = 10;

function noLedger(): CommandResult {
  return {
    summary: "This surface cannot see the run ledger.",
    detail:
      "It is kept by the process that runs goals unattended. That is not the same as nothing having happened — ask the runtime that does the work, or run `motebit runs` on that machine.",
  };
}

/**
 * `runs` — the list, newest first, with what is holding a goal first.
 *
 * Each line says whether that run's result is signed and how much of it
 * can be re-checked, because those are the two questions a returning
 * owner actually has and the two a list can answer honestly.
 */
export function cmdRuns(runtime: MotebitRuntime, args?: string): CommandResult {
  const ledger = runtime.runLedger;
  if (ledger == null) return noLedger();

  const target = (args ?? "").trim();
  if (target !== "") return showRun(runtime, ledger, target);

  const runs = ledger.listRecent(RECENT_LIMIT);
  if (runs.length === 0) {
    return {
      summary: "No runs recorded yet.",
      data: { runs: [] },
    };
  }

  const lines = runs.map((r) => {
    const marks: string[] = [];
    if (r.signed) marks.push("signed");
    if (r.evidence_count > 0) marks.push(`${r.evidence_count} checkable`);
    if (r.withheld_count > 0) marks.push(`${r.withheld_count} withheld`);
    const suffix = marks.length > 0 ? ` · ${marks.join(" · ")}` : "";
    return `${r.run_id.slice(0, 8)}  ${r.goal_id.slice(0, 8)}  ${r.status}${suffix}`;
  });

  return {
    summary: `${runs.length} recent run(s).`,
    detail: `${lines.join("\n")}\n\nOne run in full: runs <run_id>`,
    data: { runs },
  };
}

function showRun(
  runtime: MotebitRuntime,
  ledger: NonNullable<MotebitRuntime["runLedger"]>,
  target: string,
): CommandResult {
  const run = ledger.get(target);
  if (run == null) {
    return { summary: `No run matching "${target}".` };
  }

  // Every piece of text below crosses the relay, so every piece of it
  // goes through the membrane — the same one an approval's arguments
  // pass through. The membrane is applied HERE rather than trusted from
  // the reader, because this is the boundary.
  const redact = (t: string): string => runtime.redactForRemoteDisclosure(t);

  const sections: string[] = [];

  sections.push(
    [
      `run     ${run.run_id}`,
      `goal    ${run.goal_id}`,
      `status  ${run.status}`,
      ...(run.note != null && run.note !== "" ? [`note    ${redact(run.note)}`] : []),
    ].join("\n"),
  );

  if (run.outcomes.length === 0) {
    sections.push("Result\n  none recorded — the run did not reach an outcome row.");
  } else {
    const body = run.outcomes
      .map((o) => {
        const rows = [`  status  ${o.status}`];
        if (o.error_message != null && o.error_message !== "") {
          rows.push(`  reason  ${redact(o.error_message)}`);
        }
        if (o.summary_preview != null && o.summary_preview !== "") {
          rows.push(`  ${redact(o.summary_preview)}`);
        }
        rows.push(
          o.signed
            ? "  signed — read it in full on the machine that signed it"
            : "  NOT signed — this is the motebit's own account, not a signed artifact",
        );
        return rows.join("\n");
      })
      .join("\n  ──\n");
    sections.push(`Result\n${body}`);
  }

  sections.push(
    run.tool_calls.length === 0
      ? "Tool calls (0)\n  none recorded."
      : `Tool calls (${run.tool_calls.length})\n` +
          run.tool_calls.map((c) => `  ${c.tool}  ${c.verdict}`).join("\n") +
          "\n  The tool's own verdict — attribution, never proof of an outside effect.",
  );

  sections.push(
    run.evidence.length === 0
      ? "Evidence (0)\n  none recorded. That is not 'nothing was read' — it means no tool in\n  this run content-addressed what it retrieved."
      : `Evidence (${run.evidence.length})\n` +
          run.evidence
            .map(
              (e) =>
                `  ${e.tool} · ${redact(e.ref)}\n    ${e.digest}` +
                (e.projection != null ? `\n    projection ${e.projection}` : ""),
            )
            .join("\n") +
          "\n  Re-fetch the source and hash its UTF-8 text to confirm the digest.\n" +
          "  It proves the bytes were read — never that what they say is true.",
  );

  if (run.withheld.length > 0) {
    sections.push(
      `Withheld (${run.withheld.length})\n` +
        run.withheld.map((w) => `  ${w.tool} · ${w.reason}`).join("\n") +
        "\n  Read and deliberately not kept, so there is nothing here to re-check.",
    );
  }

  return {
    summary: `Run ${run.run_id.slice(0, 8)} — ${run.status}.`,
    detail: sections.join("\n\n"),
    // The same view, structured. No surface renders it yet — every
    // remote consumer today reads `summary` + `detail` as text — so
    // this is the shape a panel would bind to, carried now so a surface
    // that wants it does not need a protocol change to get it.
    data: { run },
  };
}

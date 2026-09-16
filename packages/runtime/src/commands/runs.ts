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
import type { RunLedgerDetail } from "@motebit/sdk";

/** How many runs a list answers with. A return view, not an archive. */
const RECENT_LIMIT = 10;

/**
 * The run this was asked about, or "" for the list.
 *
 * `runs`, `runs list`, `runs show <id>` and the bare `runs <id>` all
 * reach the same two answers. An id is never one of the verbs: run ids
 * are uuids, so nothing is shadowed by accepting them.
 */
function parseTarget(args?: string): string {
  const raw = (args ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "list") return "";
  const show = /^show\s+(\S+)$/i.exec(raw);
  if (show?.[1] != null) return show[1];
  return raw;
}

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

  // `runs list` and `runs show <id>` are what a person types who has
  // ever used another tool, and every word after the verb was being
  // read as a run id — so the list verb answered `No run matching
  // "list"`, an absence about a run nobody asked for. The absence
  // vocabulary this file is careful about is worth nothing if the
  // parser manufactures one.
  const target = parseTarget(args);
  if (target !== "") return showRun(runtime, ledger, target);

  // The LIST crosses the membrane too, not only the detail.
  //
  // Fixed on one of two paths first. `note` is free text written from a
  // caught error — the scheduler sets it to `err.message` — so a run
  // that failed against a token-bearing URL put that token in the
  // summary, and `data` is serialized whole and returned through the
  // relay. Same defect, same file, one function along.
  const redact = (t: string): string => runtime.redactForRemoteDisclosure(t);
  const runs = ledger
    .listRecent(RECENT_LIMIT)
    .map((r) => (r.note != null ? { ...r, note: redact(r.note) } : r));
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
    // The note is rendered, not merely fetched. Blocking runs are listed
    // first BECAUSE they are waiting on a person, and a line that says
    // `interrupted` without saying what is needed sends that person
    // looking for the reason the row already has.
    const why = r.note != null && r.note !== "" ? `\n    ${r.note}` : "";
    return `${r.run_id.slice(0, 8)}  ${r.goal_id.slice(0, 8)}  ${r.status}${suffix}${why}`;
  });

  return {
    summary: `${runs.length} recent run(s).`,
    detail: `${lines.join("\n")}\n\nOne run in full: runs <run_id>`,
    data: { runs },
  };
}

/**
 * Pass a run through the membrane, field by field, once.
 *
 * Explicit rather than a blanket walk so that adding a field to
 * `RunLedgerDetail` without deciding what it means here is a type error
 * rather than a quiet leak.
 */
function redactRun(run: RunLedgerDetail, redact: (t: string) => string): RunLedgerDetail {
  return {
    run_id: run.run_id,
    goal_id: run.goal_id,
    status: run.status,
    started_at: run.started_at,
    ...(run.note != null ? { note: redact(run.note) } : {}),
    signed: run.signed,
    evidence_count: run.evidence_count,
    withheld_count: run.withheld_count,
    outcomes: run.outcomes.map((o) => ({
      status: o.status,
      ...(o.error_message != null ? { error_message: redact(o.error_message) } : {}),
      ...(o.summary_preview != null ? { summary_preview: redact(o.summary_preview) } : {}),
      signed: o.signed,
    })),
    tool_calls: run.tool_calls.map((c) => ({ tool: c.tool, verdict: c.verdict })),
    evidence: run.evidence.map((e) => ({
      tool: e.tool,
      ref: redact(e.ref),
      digest: e.digest,
      ...(e.projection != null ? { projection: e.projection } : {}),
    })),
    withheld: run.withheld.map((w) => ({ tool: w.tool, reason: w.reason })),
  };
}

function showRun(
  runtime: MotebitRuntime,
  ledger: NonNullable<MotebitRuntime["runLedger"]>,
  target: string,
): CommandResult {
  const found = ledger.get(target);
  if (found.kind === "ambiguous") {
    // Not "no such run" — it matched several, and saying otherwise
    // would deny the existence of a run the list had just printed.
    return {
      summary: `"${target}" matches ${found.matches.length} runs — name one exactly.`,
      detail: found.matches.map((id) => `  ${id}`).join("\n"),
    };
  }
  if (found.kind === "missing") {
    return { summary: `No run matching "${target}".` };
  }
  const raw = found.run;

  // ONE redacted object, and both outputs derive from it.
  //
  // The first version redacted while building the text and assigned the
  // reader's object to `data` untouched — and `data` is serialized whole
  // and returned through the relay, so every field the prose was careful
  // about rode along beside it in the clear. That is the same defect
  // this arc's second increment found in the approvals command, whose
  // comment says it in as many words: the raw object must not ride
  // beside a redacted string. Deriving both from one redacted value is
  // what stops a field added later from arriving unredacted by default.
  const redact = (t: string): string => runtime.redactForRemoteDisclosure(t);
  const run = redactRun(raw, redact);

  const sections: string[] = [];

  sections.push(
    [
      `run     ${run.run_id}`,
      `goal    ${run.goal_id}`,
      `status  ${run.status}`,
      ...(run.note != null && run.note !== "" ? [`note    ${run.note}`] : []),
    ].join("\n"),
  );

  if (run.outcomes.length === 0) {
    sections.push("Result\n  none recorded — the run did not reach an outcome row.");
  } else {
    const body = run.outcomes
      .map((o) => {
        const rows = [`  status  ${o.status}`];
        if (o.error_message != null && o.error_message !== "") {
          rows.push(`  reason  ${o.error_message}`);
        }
        if (o.summary_preview != null && o.summary_preview !== "") {
          rows.push(`  ${o.summary_preview}`);
        }
        // Only for rows that could carry a signature. A `suspended` row
        // is written at every approval pause and can never hold a
        // manifest, so emitting this unconditionally showed an
        // approval-gated run as signed AND not signed — two verdicts for
        // one run, which the terminal view was already corrected for.
        if (o.status === "completed" || o.status === "partial") {
          rows.push(
            o.signed
              ? "  signed — read it in full on the machine that signed it"
              : "  NOT signed — this is the motebit's own account, not a signed artifact",
          );
        }
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
                `  ${e.tool} · ${e.ref}\n    ${e.digest}` +
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

/**
 * `motebit runs ...` — the durable-execution ledger of goal runs.
 *
 *   motebit runs            list runs that block their goal (paused on a
 *                           human, or interrupted with side effects nobody
 *                           has reviewed), then the most recent runs
 *   motebit runs ack <id> --allow-fresh-run
 *                           a human has reviewed an interrupted run and
 *                           accepts that the goal's NEXT run starts from
 *                           scratch — it may repeat effects the interrupted
 *                           run already caused. Without the flag the command
 *                           prints that consequence and releases nothing.
 *                           Nothing is retried by ack.
 *
 * An interrupted run is held because re-firing the goal would repeat the
 * tool calls that already completed, and nobody knows whether the ones
 * with no completion row reached the outside world. `ack` records that a
 * person looked; it does not retry anything.
 */

import { openMotebitDatabase } from "@motebit/persistence";
import type { GoalRun } from "@motebit/persistence";

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";
import { formatTimeAgo } from "../utils.js";
import { dim } from "../colors.js";
import { requireMotebitId } from "./_helpers.js";

export async function handleRunsList(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  try {
    const blocking = moteDb.goalRunStore.listBlocking(motebitId);
    const recent = moteDb.goalRunStore
      .listRecent(motebitId, 20)
      .filter((r) => !blocking.some((b) => b.run_id === r.run_id));

    if (blocking.length === 0 && recent.length === 0) {
      console.log("No goal runs recorded yet.");
      return;
    }

    const header = `  ${"RUN".padEnd(10)}${"GOAL".padEnd(10)}${"STATUS".padEnd(20)}${"STARTED".padEnd(16)}NOTE`;
    if (blocking.length > 0) {
      console.log("Holding their goal (needs you):");
      console.log(
        dim(
          "  interrupted runs: `motebit runs ack <run> --allow-fresh-run` releases the goal; its next run starts from scratch and may repeat the effects listed. Nothing is retried.",
        ),
      );
      console.log(header);
      console.log("  " + "-".repeat(header.length - 2));
      for (const r of blocking) console.log(formatRow(r));
      console.log("");
    }
    if (recent.length > 0) {
      console.log("Recent:");
      console.log(header);
      console.log("  " + "-".repeat(header.length - 2));
      for (const r of recent) console.log(dim(formatRow(r)));
    }
  } finally {
    moteDb.close();
  }
}

export async function handleRunsAck(config: CliConfig): Promise<void> {
  const runId = config.positionals[2];
  if (runId == null || runId === "") {
    console.error("Usage: motebit runs ack <run_id> --allow-fresh-run");
    process.exit(1);
  }
  const motebitId = requireMotebitId(loadFullConfig());
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  try {
    // Exact id: the indexed lookup, never a window. Prefix: the runs that
    // are holding a goal first (those are what a person is here to ack),
    // then a recent window.
    const match =
      moteDb.goalRunStore.get(runId) ??
      [
        ...moteDb.goalRunStore.listBlocking(motebitId),
        ...moteDb.goalRunStore.listRecent(motebitId, 200),
      ].find((r) => r.run_id.startsWith(runId));
    if (!match) {
      console.error(`Error: no run found matching "${runId}".`);
      process.exit(1);
    }
    if (match.status !== "interrupted") {
      console.error(
        `Error: run ${match.run_id.slice(0, 8)} is ${match.status}, not interrupted — nothing to acknowledge.`,
      );
      process.exit(1);
    }
    if (match.reviewed_at != null) {
      console.log(`Run ${match.run_id.slice(0, 8)} was already acknowledged.`);
      return;
    }
    const unknown = match.uncertain_actions?.length ?? 0;
    const consequence = `Releasing goal ${match.goal_id.slice(0, 8)} means its next run starts from scratch and may repeat effects run ${match.run_id.slice(0, 8)} already caused: ${match.completed_actions} completed action(s), ${unknown} with unknown effect${
      unknown > 0 ? ` (${(match.uncertain_actions ?? []).map((u) => u.tool).join(", ")})` : ""
    }. Nothing is retried by ack.`;
    if (!config.allowFreshRun) {
      // The consequence is shown BEFORE anything is released; the flag is
      // the explicit acceptance, not a post-hoc warning.
      console.error(consequence);
      console.error("Re-run with --allow-fresh-run to accept this and release the goal.");
      process.exit(1);
    }
    moteDb.goalRunStore.ack(match.run_id);
    console.log(`Acknowledged run ${match.run_id.slice(0, 8)}. ${consequence}`);
  } finally {
    moteDb.close();
  }
}

function describeStatus(r: GoalRun): string {
  if (r.status !== "interrupted") return r.status;
  const uncertain = r.uncertain_actions?.length ?? 0;
  const parts: string[] = [];
  if (r.completed_actions > 0) parts.push(`${r.completed_actions} done`);
  if (uncertain > 0) parts.push(`${uncertain} unknown`);
  const facts = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `interrupted${facts}${r.reviewed_at != null ? " ✓" : ""}`;
}

function formatRow(r: GoalRun): string {
  const status = describeStatus(r);
  const note = r.note ?? "";
  return `  ${r.run_id.slice(0, 8).padEnd(10)}${r.goal_id.slice(0, 8).padEnd(10)}${status.padEnd(20)}${formatTimeAgo(r.started_at).padEnd(16)}${note.length > 60 ? note.slice(0, 59) + "…" : note}`;
}

/**
 * `motebit runs show <run_id>` — what one unattended run actually did,
 * and what of it a stranger could check without trusting this motebit.
 *
 * The three sections are deliberately separate, because they carry
 * different weights of proof. The RESULT is what the motebit produced,
 * and it is either signed or it is the motebit's word. The TOOL CALLS
 * are attribution plus each tool's own verdict — never independent
 * proof that anything happened outside. The EVIDENCE is the only part a
 * third party can re-check: a content-addressed digest of bytes someone
 * else can fetch, and a span those bytes contain.
 *
 * Empty sections say so in those terms. "No evidence recorded" is not
 * "nothing was read" — a run whose tools never content-addressed what
 * they retrieved leaves nothing to re-check, and saying otherwise would
 * be the same overstatement this arc has spent itself removing.
 */
export async function handleRunsShow(config: CliConfig): Promise<void> {
  const target = config.positionals[2];
  if (target == null || target === "") {
    console.error("Usage: motebit runs show <run_id>");
    process.exit(1);
  }
  const motebitId = requireMotebitId(loadFullConfig());
  const moteDb = await openMotebitDatabase(getDbPath(config.dbPath));
  try {
    // Exact ids go through the indexed lookup, like `runs ack` does. A
    // window-only scan failed to find a full run id pasted from an older
    // run that `ack` resolves without trouble — two commands disagreeing
    // about whether the same row exists.
    // Scoped to THIS motebit, like the listing beside it. The indexed
    // lookup is not, and this is the first command that prints verbatim
    // result text, tool rows and evidence spans — so against a database
    // holding another identity's runs, a full run id would print that
    // identity's content while `motebit runs` listed nothing for it.
    const indexedRun = moteDb.goalRunStore.get(target);
    const indexed = indexedRun?.motebit_id === motebitId ? indexedRun : null;
    const recent = moteDb.goalRunStore.listRecent(motebitId, 200);
    const exact = indexed ?? recent.find((r) => r.run_id === target);
    const prefixed = recent.filter((r) => r.run_id.startsWith(target));
    if (exact == null && prefixed.length > 1) {
      console.error(`Error: "${target}" matches ${prefixed.length} runs — name one exactly.`);
      for (const r of prefixed) console.error(formatRow(r));
      process.exit(1);
    }
    const run = exact ?? prefixed[0];
    if (run == null) {
      console.error(`Error: no run matching "${target}".`);
      process.exit(1);
    }

    console.log(`Run ${run.run_id}`);
    console.log(`  goal      ${run.goal_id}`);
    console.log(`  status    ${describeStatus(run)}`);
    console.log(`  started   ${new Date(run.started_at).toISOString()}`);
    if (run.note != null && run.note !== "") console.log(`  note      ${run.note}`);

    // --- Result, and whether it is signed ---
    // By id, not by scanning a window of this goal's recent outcomes: a
    // goal on a short cadence pushes its own outcome out of any fixed
    // window within hours, and this command would then report "the run
    // did not reach an outcome row" about a row that exists and is
    // signed. Stated that confidently, a false negative is worse here
    // than a vague answer.
    // By the run LINK, not by id-equality. The live paths key the
    // outcome by the run id and the recovery paths mint a fresh one on
    // purpose, so an id lookup found only half of them — and reported
    // "the run did not reach an outcome row" for exactly the interrupted
    // and recovered runs this command exists to explain.
    // EVERY outcome for the run, not the newest one.
    //
    // A run can leave more than one row: the result, and then a failure
    // written by a catch that wraps the successful path too. Those were
    // given distinct ids precisely so the failure could not overwrite
    // the signed result — and then taking `[0]` by recency hid the
    // result behind the failure anyway, printing "NOT signed" while the
    // manifest sat in a sibling row no reader could reach. Preserving a
    // record and then not showing it is the same outcome as losing it.
    const outcomes = moteDb.goalOutcomeStore.listForRun(run.run_id);
    const fallback = moteDb.goalOutcomeStore.get(run.run_id);
    const all = outcomes.length > 0 ? outcomes : fallback != null ? [fallback] : [];
    console.log("\nResult");
    if (all.length === 0) {
      console.log(dim("  none recorded — the run did not reach an outcome row."));
    }
    for (const [i, outcome] of all.entries()) {
      if (i > 0) console.log(dim("  ── and also ──"));
      // The outcome's own status and reason, before its text. A failed
      // or partial outcome rendered under a bare "Result" heading with
      // an empty body reads as a run that produced nothing, when what
      // happened is recorded right here.
      console.log(`  status    ${outcome.status}`);
      if (outcome.error_message != null && outcome.error_message !== "") {
        console.log(`  reason    ${outcome.error_message}`);
      }
      const body = outcome.response_full ?? outcome.summary;
      if (body == null || body === "") {
        console.log(dim("  empty."));
      } else {
        for (const line of body.split("\n")) console.log(`  ${line}`);
        // Only a COMPLETED run was ever expected to carry a whole
        // result. A halted or failed run stores a summary by design, so
        // this line would date a run that happened today to before a
        // feature that shipped with it.
        if (outcome.response_full == null && outcome.status === "completed") {
          console.log(dim("  (summary only — this run predates full-result retention)"));
        }
      }
      // The signature line belongs only to rows that could carry one. A
      // `suspended` row is written at every approval pause, so an
      // approval-gated run rendered its real result as "signed" and then,
      // under "and also", the pause row as "NOT signed — the motebit's
      // own account". Two verdicts for one run, from the command whose
      // job is that a reader cannot misread the record.
      if (outcome.status === "completed" || outcome.status === "partial") {
        console.log(
          outcome.signed_manifest != null
            ? // Not "verify with <command>": that subcommand needs the body
              // as a file and the manifest, and this view prints an
              // indented body and no manifest at all. Naming a command the
              // reader cannot run from what is on screen is an affordance
              // that does not exist.
              dim("  signed — a manifest over this result is stored with the outcome.")
            : dim("  NOT signed — this is the motebit's own account, not a signed artifact."),
        );
      }
    }

    // --- Tool calls: attribution, not proof ---
    const calls = moteDb.toolAuditSink.queryByRunId?.(run.run_id) ?? [];
    console.log(`\nTool calls (${calls.length})`);
    if (calls.length === 0) {
      console.log(dim("  none recorded."));
    } else {
      for (const c of calls) {
        const verdict =
          c.result == null ? "prepared; effect unknown" : c.result.ok ? "ok" : "failed";
        console.log(`  ${c.callId.slice(0, 8)}  ${c.tool.padEnd(20)}${verdict}`);
      }
      console.log(dim("  The tool's own verdict — attribution, never proof of an outside effect."));
    }

    // --- Evidence: the only re-checkable part ---
    const all_evidence = moteDb.runEvidenceStore.listForRun(run.run_id);
    // A refusal is not a pointer and must not be counted as one, but it
    // must not vanish either — the two absences it used to collapse into
    // ("we would not keep this" and "nothing was read") are the exact
    // pair this record exists to keep apart.
    const withheld = all_evidence.filter((e) => e.withheld_reason != null);
    const evidence = all_evidence.filter((e) => e.withheld_reason == null);
    console.log(`\nEvidence (${evidence.length})`);
    if (evidence.length === 0) {
      console.log(
        dim(
          "  none recorded. That is not 'nothing was read' — it means no tool in this run\n" +
            "  content-addressed what it retrieved, so there is nothing to re-check.",
        ),
      );
    } else {
      for (const e of evidence) {
        const p = e.evidence.provenance;
        if (p == null) continue;
        // The source first, and the WHOLE digest. The instruction below
        // says to re-fetch the record and compare — an abbreviated
        // digest cannot be compared, and without the source there is
        // nothing to fetch, which left the affordance unusable from the
        // only reader that ships.
        console.log(`  ${e.tool} · ${e.evidence.ref}`);
        console.log(dim(`    ${p.digest.algorithm}:${p.digest.value}`));
        if (p.projection != null) console.log(dim(`    projection ${p.projection}`));
        const preview = p.span.replace(/\s+/g, " ").slice(0, 100);
        console.log(dim(`    span "${preview}${p.span.length > 100 ? "…" : ""}"`));
      }
      // The instruction has to match the pointer. A projection-bearing
      // span lives in the RECIPE's output, not in the raw bytes, so
      // "hash the bytes and check the span is present" returns absent on
      // a perfectly valid pointer — and a reader following it literally
      // would conclude the motebit made the span up. That is the exact
      // wrong conclusion for this command to cause.
      const anyProjection = evidence.some((e) => e.evidence.provenance?.projection != null);
      console.log(
        dim(
          "  Re-fetch the source and hash its UTF-8 text to confirm the digest.\n" +
            (anyProjection
              ? "  Where a projection is named, apply that recipe to the bytes first —\n" +
                "  the span lives in the recipe's output, not in the raw bytes.\n"
              : "  The span is located in the bytes directly.\n") +
            "  (The digest is over the decoded text, so a source served in another\n" +
            "  encoding will not match byte-for-byte — a producer-side convention,\n" +
            "  named here rather than left for a stranger to discover.)\n" +
            "  It proves the bytes were read — never that what they say is true.",
        ),
      );
    }

    if (withheld.length > 0) {
      console.log(`\nWithheld (${withheld.length})`);
      for (const w of withheld) {
        const why =
          w.withheld_reason === "credential_in_source"
            ? "the source carried a credential"
            : "the retrieved text carried a credential";
        console.log(`  ${w.tool} · ${why}`);
      }
      console.log(
        dim(
          "  Something was read and deliberately not kept, so there is nothing\n" +
            "  here to re-check. This is NOT the same as nothing having been read —\n" +
            "  and if it appears where you would not expect it, the guard is wrong,\n" +
            "  which is the only way anyone finds that out.",
        ),
      );
    }
  } finally {
    moteDb.close();
  }
}

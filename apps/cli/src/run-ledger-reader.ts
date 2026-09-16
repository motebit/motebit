/**
 * The daemon's answer to "what happened while I was away".
 *
 * Built here rather than in the runtime because this is the process
 * that holds the ledger: the run rows, the outcomes, the tool audit and
 * the evidence all live in this machine's database, and no other
 * surface has them. The runtime holds the port; the process that did the
 * work supplies the answer — the same arrangement as the goal-id
 * resolver.
 *
 * What it deliberately does not return is the verbatim result. A signed
 * artifact is read on the machine that signed it, because a copy
 * crossing a relay cannot be checked against that signature by whatever
 * surface receives it, and presenting it as the result would offer proof
 * that is not there. A bounded preview travels instead, and says so.
 */
import type { MotebitDatabase } from "@motebit/persistence";
import type {
  RunLedgerReader,
  RunLedgerSummary,
  RunLedgerDetail,
  RunLedgerLookup,
} from "@motebit/sdk";

/** Enough of a result to recognise it; far short of standing in for it. */
const PREVIEW_MAX_CHARS = 280;

export function createRunLedgerReader(moteDb: MotebitDatabase, motebitId: string): RunLedgerReader {
  /**
   * Every outcome a run produced — the run-linked rows AND the legacy
   * one keyed by the run id.
   *
   * Live paths key the outcome by the run; recovery paths mint a fresh
   * id on purpose. Reading only the linked set made the LIST say a
   * result was unsigned while the DETAIL, which unions both, said it was
   * signed: the same run, two answers, and the list's was wrong.
   */
  const outcomesFor = (runId: string) => {
    const linked = moteDb.goalOutcomeStore.listForRun(runId);
    const byId = moteDb.goalOutcomeStore.get(runId);
    return byId != null && !linked.some((o) => o.outcome_id === byId.outcome_id)
      ? [...linked, byId]
      : linked;
  };

  const summarise = (
    runId: string,
    goalId: string,
    status: string,
    startedAt: number,
    note: string | null,
  ): RunLedgerSummary => {
    const outcomes = outcomesFor(runId);
    const evidence = moteDb.runEvidenceStore.listForRun(runId);
    return {
      run_id: runId,
      goal_id: goalId,
      status,
      started_at: startedAt,
      ...(note != null && note !== "" ? { note } : {}),
      signed: outcomes.some((o) => o.signed_manifest != null),
      evidence_count: evidence.filter((e) => e.withheld_reason == null).length,
      withheld_count: evidence.filter((e) => e.withheld_reason != null).length,
    };
  };

  return {
    listRecent(limit: number): RunLedgerSummary[] {
      // Runs holding their goal first — those are the ones waiting on a
      // person, which is what a returning owner needs to see before
      // anything that already finished.
      const blocking = moteDb.goalRunStore.listBlocking(motebitId);
      const recent = moteDb.goalRunStore
        .listRecent(motebitId, limit)
        .filter((r) => !blocking.some((b) => b.run_id === r.run_id));
      return [...blocking, ...recent]
        .slice(0, limit)
        .map((r) => summarise(r.run_id, r.goal_id, r.status, r.started_at, r.note));
    },

    get(target: string): RunLedgerLookup {
      const indexed = moteDb.goalRunStore.get(target);
      const scoped = indexed?.motebit_id === motebitId ? indexed : null;
      // The same set the LIST draws from, not a window. A held run is
      // exactly the kind that stays open while newer runs accumulate, so
      // on a short cadence it scrolls out of any fixed window within a
      // day — and then the list shows it and asking for it by the id
      // printed right there answers "no run matching". A view whose two
      // halves disagree about what exists is worse than one that shows
      // less.
      const searchable = [
        ...moteDb.goalRunStore.listBlocking(motebitId),
        ...moteDb.goalRunStore.listRecent(motebitId, 200),
      ];
      const prefixed = searchable.filter(
        (r, i, xs) =>
          r.run_id.startsWith(target) && xs.findIndex((y) => y.run_id === r.run_id) === i,
      );
      // An ambiguous prefix is refused, not resolved to whichever came
      // first. The list prints 8-character prefixes, so that is what a
      // person types back, and this view returns result text, tool rows
      // and evidence pointers — the wrong run's, silently, if it guesses.
      if (scoped == null && prefixed.length > 1) {
        return { kind: "ambiguous", matches: prefixed.map((r) => r.run_id) };
      }
      const run = scoped ?? prefixed[0];
      if (run == null) return { kind: "missing" };

      const all = outcomesFor(run.run_id);
      const evidence = moteDb.runEvidenceStore.listForRun(run.run_id);
      const calls = moteDb.toolAuditSink.queryByRunId?.(run.run_id) ?? [];

      const detail = {
        ...summarise(run.run_id, run.goal_id, run.status, run.started_at, run.note),
        outcomes: all.map((o) => {
          const body = o.response_full ?? o.summary;
          return {
            status: o.status,
            ...(o.error_message != null ? { error_message: o.error_message } : {}),
            ...(body != null && body !== ""
              ? {
                  summary_preview:
                    body.length > PREVIEW_MAX_CHARS ? `${body.slice(0, PREVIEW_MAX_CHARS)}…` : body,
                }
              : {}),
            signed: o.signed_manifest != null,
          };
        }),
        tool_calls: calls.map((c) => ({
          tool: c.tool,
          verdict: c.result == null ? "prepared; effect unknown" : c.result.ok ? "ok" : "failed",
        })),
        evidence: evidence
          .filter((e) => e.withheld_reason == null)
          .map((e) => {
            const p = e.evidence.provenance;
            return {
              tool: e.tool,
              ref: e.evidence.ref,
              digest: p != null ? `${p.digest.algorithm}:${p.digest.value}` : "",
              ...(p?.projection != null ? { projection: p.projection } : {}),
            };
          }),
        withheld: evidence
          .filter((e) => e.withheld_reason != null)
          .map((e) => ({
            tool: e.tool,
            reason:
              e.withheld_reason === "credential_in_source"
                ? "the source carried a credential"
                : "the retrieved text carried a credential",
          })),
      } satisfies RunLedgerDetail;
      return { kind: "found", run: detail };
    },
  };
}

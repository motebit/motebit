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
import type { RunLedgerReader, RunLedgerSummary, RunLedgerDetail } from "@motebit/sdk";

/** Enough of a result to recognise it; far short of standing in for it. */
const PREVIEW_MAX_CHARS = 280;

export function createRunLedgerReader(moteDb: MotebitDatabase, motebitId: string): RunLedgerReader {
  const summarise = (
    runId: string,
    goalId: string,
    status: string,
    startedAt: number,
    note: string | null,
  ): RunLedgerSummary => {
    const outcomes = moteDb.goalOutcomeStore.listForRun(runId);
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

    get(target: string): RunLedgerDetail | null {
      const indexed = moteDb.goalRunStore.get(target);
      const scoped = indexed?.motebit_id === motebitId ? indexed : null;
      const recent = moteDb.goalRunStore.listRecent(motebitId, 200);
      const run = scoped ?? recent.find((r) => r.run_id.startsWith(target));
      if (run == null) return null;

      const outcomes = moteDb.goalOutcomeStore.listForRun(run.run_id);
      const fallback = moteDb.goalOutcomeStore.get(run.run_id);
      const all = [...outcomes];
      if (fallback != null && !all.some((o) => o.outcome_id === fallback.outcome_id)) {
        all.push(fallback);
      }
      const evidence = moteDb.runEvidenceStore.listForRun(run.run_id);
      const calls = moteDb.toolAuditSink.queryByRunId?.(run.run_id) ?? [];

      return {
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
      };
    },
  };
}

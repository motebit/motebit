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

  /**
   * A pointer only counts as checkable if it can actually be re-checked.
   *
   * A row with no provenance has no digest, so counting it and then
   * printing "re-fetch the source and hash its text" under a blank one
   * instructs the owner to verify something that was never recorded.
   * Not withheld either — withholding is a decision, this is an absence.
   */
  const checkable = (e: { withheld_reason?: string | null; evidence: { provenance?: unknown } }) =>
    e.withheld_reason == null && e.evidence.provenance != null;

  const summarise = (
    runId: string,
    goalId: string,
    status: string,
    startedAt: number,
    note: string | null,
    holding: boolean,
  ): RunLedgerSummary => {
    const outcomes = outcomesFor(runId);
    const evidence = moteDb.runEvidenceStore.listForRun(runId);
    return {
      run_id: runId,
      goal_id: goalId,
      status,
      started_at: startedAt,
      holding,
      ...(note != null && note !== "" ? { note } : {}),
      signed: outcomes.some((o) => o.signed_manifest != null),
      evidence_count: evidence.filter(checkable).length,
      withheld_count: evidence.filter((e) => e.withheld_reason != null).length,
    };
  };

  return {
    listRecent(limit: number): RunLedgerSummary[] {
      // Runs holding their goal first — those are the ones waiting on a
      // person, which is what a returning owner needs to see before
      // anything that already finished.
      //
      // Each group is bounded separately, and the held group is newest
      // first like the other. Prepending an UNBOUNDED held group before
      // one slice meant a motebit with ten or more runs waiting answered
      // "what happened while you were away" with ten held runs and
      // nothing that happened — and, because the store returns held runs
      // oldest-first, with the ten oldest, under a reader documented
      // "newest first".
      const half = Math.max(1, Math.ceil(limit / 2));
      const blocking = moteDb.goalRunStore
        .listBlocking(motebitId)
        .slice()
        .sort((a, b) => b.started_at - a.started_at);
      const heldIds = new Set(blocking.map((b) => b.run_id));
      const recent = moteDb.goalRunStore
        .listRecent(motebitId, limit)
        .filter((r) => !heldIds.has(r.run_id));
      // The held group may take the whole page when there is nothing
      // else to show, but never crowds out everything that finished.
      const heldShown = blocking.slice(0, Math.max(half, limit - recent.length));
      return [...heldShown, ...recent]
        .slice(0, limit)
        .map((r) =>
          summarise(r.run_id, r.goal_id, r.status, r.started_at, r.note, heldIds.has(r.run_id)),
        );
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

      const holding = moteDb.goalRunStore
        .listBlocking(motebitId)
        .some((b) => b.run_id === run.run_id);
      const all = outcomesFor(run.run_id);
      const evidence = moteDb.runEvidenceStore.listForRun(run.run_id);
      const calls = moteDb.toolAuditSink.queryByRunId?.(run.run_id) ?? [];

      const detail = {
        ...summarise(run.run_id, run.goal_id, run.status, run.started_at, run.note, holding),
        outcomes: all.map((o) => {
          const body = o.response_full ?? o.summary;
          return {
            status: o.status,
            ...(o.error_message != null ? { error_message: o.error_message } : {}),
            // Whole, not cut. The bound is applied AFTER the membrane,
            // in `cmdRuns`, because every credential pattern is
            // length-anchored — a vendor key needs sixteen more
            // characters after its separator, a seed phrase twelve
            // whole words — so a secret straddling a cut made here is
            // reduced to a stub no pattern matches, and crosses the
            // relay in the clear through the one boundary built to stop
            // it. This hands the whole body across a function call
            // inside one process; the wire sees only what the redactor
            // has already read in full.
            ...(body != null && body !== "" ? { summary_preview: body } : {}),
            signed: o.signed_manifest != null,
          };
        }),
        tool_calls: calls.map((c) => ({
          tool: c.tool,
          // A refusal is not an unknown. The gate writes its audit row
          // BEFORE execution, so a denied call — deny-list, out of
          // delegated scope, over the risk ceiling, out of budget — has
          // a decision and never a result. Reading the result alone
          // reported every one of those to a returning owner as
          // "prepared; effect unknown", which says the outside world may
          // have been touched by a call that was refused before it ran.
          //
          // A row still marked `requiresApproval` with no result is the
          // other certainty. The gate appends `recordApprovalSatisfied`
          // under the SAME call id when a person approves, and the
          // table replaces on that key — so a row that still says it is
          // waiting is a call whose approval was never satisfied. It
          // may still be waiting or the owner may have refused it, and
          // either way it did not run. Reporting the call the owner
          // personally refused as "effect unknown" was the same
          // misreport as the one above, on the refusal that matters
          // most.
          verdict: !c.decision.allowed
            ? "refused by the policy gate — never attempted"
            : c.decision.requiresApproval && c.result == null
              ? "stopped for your approval — never executed"
              : c.result == null
                ? "prepared; effect unknown"
                : c.result.ok
                  ? "ok"
                  : "failed",
        })),
        evidence: evidence.filter(checkable).map((e) => {
          const p = e.evidence.provenance;
          return {
            tool: e.tool,
            ref: e.evidence.ref,
            // Non-null by `checkable`; the fallback keeps the shape
            // total rather than asserting.
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

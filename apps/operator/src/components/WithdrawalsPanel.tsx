import React, { useState, useEffect, useCallback } from "react";
import {
  fetchPendingWithdrawals,
  completeWithdrawal,
  failWithdrawal,
  reconcileWithdrawal,
  reconcilableAt,
  isPayoutInFlight,
  inFlightOpensAt,
  inFlightReason,
  reconcileClosedReason,
  type ReconcileOutcome,
  type WithdrawalRequest,
  ApiError,
} from "../api";

/**
 * Fallback for a relay that does not report its reconcile window. The relay
 * enforces the real one either way; this only decides when the button lights.
 */
const DEFAULT_RECONCILE_MIN_AGE_MS = 15 * 60 * 1000;

/** How often the panel re-reads the clock, so a row's reconcile action lights on time. */
const CLOCK_TICK_MS = 30_000;

const PRE_CLAIM_WARNING = "a payout may have been attempted — check the chain before failing";

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

/** Decimal USD, as the relay's admin listing reports it. */
function formatUsd(n: number): string {
  return n.toFixed(6);
}

function formatAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface ReconcileDraft {
  withdrawalId: string;
  outcome: ReconcileOutcome;
  attestation: string;
  payoutReference: string;
  /** Inline state after the relay answered "payout in flight" (#921). */
  notice?: string;
}

export function WithdrawalsPanel(): React.ReactElement {
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [minAgeMs, setMinAgeMs] = useState(DEFAULT_RECONCILE_MIN_AGE_MS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<ReconcileDraft | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetchPendingWithdrawals(signal);
      setWithdrawals(res.withdrawals);
      if (typeof res.reconcile_min_age_ms === "number") setMinAgeMs(res.reconcile_min_age_ms);
      setNow(Date.now());
      setError(null);
      setLoaded(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : String(err));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    // Re-read the clock AND the queue: an in-flight row settles (or its
    // horizon arrives) without the operator reloading.
    const tick = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, CLOCK_TICK_MS);
    return () => {
      controller.abort();
      clearInterval(tick);
    };
  }, [refresh]);

  /**
   * Run an operator action. A 409 "payout in flight" is not an error: the
   * row became `processing` under the operator — re-read, and the row itself
   * shows the state.
   */
  const act = useCallback(
    async (id: string, run: () => Promise<unknown>): Promise<boolean> => {
      setBusy(id);
      try {
        await run();
        await refresh();
        return true;
      } catch (err) {
        if (isPayoutInFlight(err)) {
          await refresh();
          return false;
        }
        setError(err instanceof ApiError ? err.message : String(err));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const onComplete = useCallback(
    async (id: string) => {
      const ref = window.prompt("Payout reference (rail tx id, etc.)?");
      if (ref == null || ref.length === 0) return;
      await act(id, () => completeWithdrawal(id, ref));
    },
    [act],
  );

  const onFail = useCallback(
    async (w: WithdrawalRequest) => {
      const reason = window.prompt("Failure reason (will refund the agent)?");
      if (reason == null || reason.length === 0) return;
      const question =
        w.payout_may_have_been_attempted === true
          ? `Mark withdrawal ${w.withdrawal_id} as failed and refund? Warning: ${PRE_CLAIM_WARNING}.`
          : `Mark withdrawal ${w.withdrawal_id} as failed and refund?`;
      if (!window.confirm(question)) return;
      await act(w.withdrawal_id, () => failWithdrawal(w.withdrawal_id, reason));
    },
    [act],
  );

  /**
   * Submit the reconcile. A 409 "payout in flight" keeps the form and says,
   * inline, when the door opens — the operator's attestation is not lost and
   * the answer is a state, not an error.
   */
  const onSubmitReconcile = useCallback(async () => {
    if (draft == null) return;
    const d = draft;
    setBusy(d.withdrawalId);
    try {
      await reconcileWithdrawal(d.withdrawalId, {
        outcome: d.outcome,
        attestation: d.attestation.trim(),
        payoutReference: d.payoutReference.trim(),
      });
      setDraft(null);
      await refresh();
    } catch (err) {
      if (isPayoutInFlight(err)) {
        const opensAt = inFlightOpensAt(err);
        setDraft({
          ...d,
          notice:
            opensAt != null
              ? `payout still in flight — opens in ${formatAge(opensAt - Date.now())}`
              : inFlightReason(err) === "undetermined"
                ? "cannot open yet — the relay can't determine the payout's horizon"
                : "payout still in flight — the relay is still handling it",
        });
        await refresh();
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setBusy(null);
    }
  }, [draft, refresh]);

  if (!loaded) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Withdrawals"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  const inFlightCount = withdrawals.filter((w) => w.status === "processing").length;
  const preClaimCount = withdrawals.filter((w) => w.payout_may_have_been_attempted === true).length;

  const statusCell = (w: WithdrawalRequest): React.ReactElement => {
    if (w.status === "processing") {
      const age = w.claimed_at != null ? `claimed ${formatAge(now - w.claimed_at)} ago` : "claimed";
      return React.createElement(
        "td",
        { className: "withdrawal-status processing" },
        React.createElement("span", { style: { color: "var(--yellow)" } }, "payout in flight"),
        React.createElement("br"),
        React.createElement(
          "span",
          { className: "muted", title: w.claimed_at != null ? formatTimestamp(w.claimed_at) : "" },
          age,
        ),
        w.failure_reason != null && w.failure_reason !== ""
          ? React.createElement(
              "div",
              { className: "muted", style: { fontSize: "0.85em" } },
              w.failure_reason,
            )
          : null,
      );
    }
    return React.createElement(
      "td",
      { className: "withdrawal-status pending" },
      "pending",
      w.payout_may_have_been_attempted === true
        ? React.createElement(
            "div",
            {
              className: "pre-claim-warning",
              style: { color: "var(--yellow)", fontSize: "0.85em" },
            },
            PRE_CLAIM_WARNING,
          )
        : null,
    );
  };

  const actionsCell = (w: WithdrawalRequest): React.ReactElement => {
    if (w.status === "processing") {
      const at = reconcilableAt(w, minAgeMs) ?? 0;
      const ready = now >= at;
      const waitText =
        reconcileClosedReason(w) ??
        (at === Number.POSITIVE_INFINITY
          ? "Cannot open yet — the relay can't determine the payout's horizon"
          : `Reconcile opens in ${formatAge(at - now)} — the payout may still land`);
      return React.createElement(
        "td",
        null,
        React.createElement(
          "button",
          {
            className: "action-btn",
            disabled: !ready || busy === w.withdrawal_id,
            title: ready ? "Settle this payout from what the chain shows" : waitText,
            onClick: () =>
              setDraft({
                withdrawalId: w.withdrawal_id,
                outcome: "not_paid",
                attestation: "",
                payoutReference: "",
              }),
          },
          "reconcile",
        ),
      );
    }
    return React.createElement(
      "td",
      null,
      React.createElement(
        "button",
        {
          className: "action-btn",
          disabled: busy === w.withdrawal_id,
          onClick: () => {
            void onComplete(w.withdrawal_id);
          },
        },
        "complete",
      ),
      React.createElement(
        "button",
        {
          className: "action-btn danger",
          disabled: busy === w.withdrawal_id,
          onClick: () => {
            void onFail(w);
          },
          style: { marginLeft: 4 },
        },
        "fail",
      ),
    );
  };

  const reconcileForm = (): React.ReactElement | null => {
    if (draft == null) return null;
    const d = draft;
    const canSubmit =
      d.attestation.trim() !== "" &&
      (d.outcome === "not_paid" || d.payoutReference.trim() !== "") &&
      busy !== d.withdrawalId;
    return React.createElement(
      "form",
      {
        className: "reconcile-form",
        "aria-label": "reconcile withdrawal",
        onSubmit: (e: React.FormEvent) => {
          e.preventDefault();
          void onSubmitReconcile();
        },
      },
      React.createElement("h3", null, `Reconcile ${d.withdrawalId.slice(0, 12)}…`),
      d.notice != null
        ? React.createElement(
            "p",
            { className: "reconcile-notice", style: { color: "var(--yellow)" } },
            d.notice,
          )
        : null,
      React.createElement(
        "label",
        null,
        "What the chain shows ",
        React.createElement(
          "select",
          {
            "aria-label": "outcome",
            value: d.outcome,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
              setDraft({ ...d, outcome: e.target.value as ReconcileOutcome }),
          },
          React.createElement("option", { value: "not_paid" }, "not paid — refund"),
          React.createElement("option", { value: "paid" }, "paid — complete"),
        ),
      ),
      React.createElement(
        "label",
        { style: { display: "block" } },
        "Attestation (what you verified on chain) ",
        React.createElement("textarea", {
          "aria-label": "attestation",
          value: d.attestation,
          required: true,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
            setDraft({ ...d, attestation: e.target.value }),
        }),
      ),
      React.createElement(
        "label",
        { style: { display: "block" } },
        d.outcome === "paid" ? "Payout reference (required) " : "Payout reference (optional) ",
        React.createElement("input", {
          "aria-label": "payout reference",
          value: d.payoutReference,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
            setDraft({ ...d, payoutReference: e.target.value }),
        }),
      ),
      React.createElement(
        "button",
        { type: "submit", className: "action-btn", disabled: !canSubmit },
        "submit reconcile",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "action-btn",
          style: { marginLeft: 4 },
          onClick: () => setDraft(null),
        },
        "cancel",
      ),
    );
  };

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Withdrawals"),
    React.createElement(
      "p",
      { className: "count" },
      inFlightCount > 0
        ? `${withdrawals.length} open withdrawal(s), ${inFlightCount} payout(s) in flight`
        : `${withdrawals.length} pending withdrawal(s)`,
    ),
    preClaimCount > 0
      ? React.createElement(
          "p",
          { className: "pre-claim-summary", style: { color: "var(--yellow)" } },
          `${preClaimCount} withdrawal(s) predate claim-before-send: ${PRE_CLAIM_WARNING}.`,
        )
      : null,
    error != null
      ? React.createElement(
          "p",
          { className: "empty", style: { color: "var(--red)" } },
          `Error: ${error}`,
        )
      : null,
    withdrawals.length === 0
      ? React.createElement("p", { className: "empty" }, "(queue is empty)")
      : React.createElement(
          "table",
          { className: "fleet-table" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              React.createElement("th", null, "Withdrawal"),
              React.createElement("th", null, "Motebit"),
              React.createElement("th", null, "Amount (USD)"),
              React.createElement("th", null, "Destination"),
              React.createElement("th", null, "Requested"),
              React.createElement("th", null, "Status"),
              React.createElement("th", null, "Actions"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            withdrawals.map((w) =>
              React.createElement(
                "tr",
                { key: w.withdrawal_id },
                React.createElement("td", null, w.withdrawal_id.slice(0, 12) + "…"),
                React.createElement("td", null, w.motebit_id.slice(0, 12) + "…"),
                React.createElement("td", null, formatUsd(w.amount)),
                React.createElement("td", null, w.destination.slice(0, 16) + "…"),
                React.createElement("td", null, formatTimestamp(w.requested_at)),
                statusCell(w),
                actionsCell(w),
              ),
            ),
          ),
        ),
    reconcileForm(),
  );
}

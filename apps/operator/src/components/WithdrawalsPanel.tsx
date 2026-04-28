import React, { useState, useEffect, useCallback } from "react";
import {
  fetchPendingWithdrawals,
  completeWithdrawal,
  failWithdrawal,
  type WithdrawalRequest,
  ApiError,
} from "../api";

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function formatMicro(n: number): string {
  return (n / 1_000_000).toFixed(6);
}

export function WithdrawalsPanel(): React.ReactElement {
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetchPendingWithdrawals(signal);
      setWithdrawals(res.withdrawals);
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
    return () => controller.abort();
  }, [refresh]);

  const onComplete = useCallback(
    async (id: string) => {
      const ref = window.prompt("Payout reference (rail tx id, etc.)?");
      if (ref == null || ref.length === 0) return;
      setBusy(id);
      try {
        await completeWithdrawal(id, ref);
        await refresh();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const onFail = useCallback(
    async (id: string) => {
      const reason = window.prompt("Failure reason (will refund the agent)?");
      if (reason == null || reason.length === 0) return;
      if (!window.confirm(`Mark withdrawal ${id} as failed and refund?`)) return;
      setBusy(id);
      try {
        await failWithdrawal(id, reason);
        await refresh();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  if (!loaded) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Withdrawals"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Withdrawals"),
    React.createElement("p", { className: "count" }, `${withdrawals.length} pending withdrawal(s)`),
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
              React.createElement("th", null, "Amount (micro)"),
              React.createElement("th", null, "Destination"),
              React.createElement("th", null, "Requested"),
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
                React.createElement("td", null, formatMicro(w.amount)),
                React.createElement("td", null, w.destination.slice(0, 16) + "…"),
                React.createElement("td", null, formatTimestamp(w.requested_at)),
                React.createElement(
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
                        void onFail(w.withdrawal_id);
                      },
                      style: { marginLeft: 4 },
                    },
                    "fail",
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}

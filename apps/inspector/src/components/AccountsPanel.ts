import React, { useState, useEffect, useCallback } from "react";
import { fetchBalance, fetchPendingWithdrawals, completeWithdrawal, failWithdrawal } from "../api";
import type { AccountTransaction, WithdrawalRequest } from "../api";

// === Helpers ===

function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id;
  return id.slice(0, len) + "...";
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

const thStyle: React.CSSProperties = { padding: "6px 8px" };
const tdStyle: React.CSSProperties = { padding: "6px 8px" };
const tdMonoStyle: React.CSSProperties = { padding: "6px 8px", fontFamily: "monospace" };
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "12px",
  marginBottom: "16px",
};
const headRowStyle: React.CSSProperties = {
  borderBottom: "1px solid rgba(255,255,255,0.1)",
  textAlign: "left" as const,
};
const bodyRowStyle: React.CSSProperties = {
  borderBottom: "1px solid rgba(255,255,255,0.05)",
};

const btnStyle: React.CSSProperties = {
  padding: "3px 10px",
  fontSize: "11px",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: "3px",
  cursor: "pointer",
  marginRight: "4px",
  background: "transparent",
  color: "inherit",
};

// === Component ===

export function AccountsPanel(): React.ReactElement {
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string>("credits");
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [balanceRes, withdrawalsRes] = await Promise.all([
        fetchBalance(signal).catch(() => null),
        fetchPendingWithdrawals(signal).catch(() => ({
          withdrawals: [] as WithdrawalRequest[],
          count: 0,
        })),
      ]);

      if (balanceRes != null) {
        setBalance(balanceRes.balance);
        setCurrency(balanceRes.currency);
        setTransactions(balanceRes.transactions);
        setError(false);
      } else {
        setError(true);
      }

      setWithdrawals(withdrawalsRes.withdrawals);
      setLoaded(true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(true);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = setInterval(() => {
      void refresh(controller.signal);
    }, 2000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [refresh]);

  const handleComplete = useCallback((withdrawalId: string) => {
    const payoutReference = window.prompt("Enter payout reference:");
    if (payoutReference == null || payoutReference.trim() === "") return;
    setActionError(null);
    void completeWithdrawal(withdrawalId, payoutReference.trim())
      .then(() => {
        setWithdrawals((prev) => prev.filter((w) => w.withdrawal_id !== withdrawalId));
      })
      .catch((err: unknown) => {
        setActionError(
          `Failed to complete withdrawal: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, []);

  const handleFail = useCallback((withdrawalId: string) => {
    const reason = window.prompt("Enter failure reason:");
    if (reason == null || reason.trim() === "") return;
    setActionError(null);
    void failWithdrawal(withdrawalId, reason.trim())
      .then(() => {
        setWithdrawals((prev) => prev.filter((w) => w.withdrawal_id !== withdrawalId));
      })
      .catch((err: unknown) => {
        setActionError(
          `Failed to reject withdrawal: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, []);

  if (!loaded) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Accounts"),
      React.createElement("div", { className: "count" }, "Loading..."),
    );
  }

  if (error && balance == null) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Accounts"),
      React.createElement(
        "div",
        { className: "count" },
        "Balance endpoint unreachable or not enabled.",
      ),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },

    // ── Agent Balance ──
    React.createElement("h2", null, "Agent Balance"),
    balance != null
      ? React.createElement(
          "div",
          {
            className: "event-entry",
            style: { marginBottom: "16px", fontSize: "14px" },
          },
          React.createElement(
            "span",
            { style: { fontWeight: "bold", fontSize: "20px" } },
            `${balance.toFixed(4)} ${currency}`,
          ),
        )
      : null,

    // ── Transaction History ──
    React.createElement("h2", { style: { marginTop: "24px" } }, "Transaction History"),
    React.createElement(
      "div",
      { className: "count" },
      `${transactions.length} transaction${transactions.length !== 1 ? "s" : ""}`,
    ),
    transactions.length > 0
      ? React.createElement(
          "table",
          { style: tableStyle },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              { style: headRowStyle },
              React.createElement("th", { style: thStyle }, "Type"),
              React.createElement("th", { style: thStyle }, "Amount"),
              React.createElement("th", { style: thStyle }, "Balance After"),
              React.createElement("th", { style: thStyle }, "Reference"),
              React.createElement("th", { style: thStyle }, "Timestamp"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            ...transactions.map((tx, i) =>
              React.createElement(
                "tr",
                { key: `${tx.reference_id}-${i}`, style: bodyRowStyle },
                React.createElement("td", { style: tdStyle }, tx.type),
                React.createElement(
                  "td",
                  {
                    style: {
                      ...tdStyle,
                      color: tx.amount >= 0 ? "#4caf50" : "#f44336",
                      fontFamily: "monospace",
                    },
                  },
                  tx.amount >= 0 ? `+${tx.amount.toFixed(4)}` : tx.amount.toFixed(4),
                ),
                React.createElement("td", { style: tdMonoStyle }, tx.balance_after.toFixed(4)),
                React.createElement("td", { style: tdMonoStyle }, truncateId(tx.reference_id)),
                React.createElement("td", { style: tdStyle }, formatTimestamp(tx.timestamp)),
              ),
            ),
          ),
        )
      : null,

    // ── Pending Withdrawals ──
    React.createElement("h2", { style: { marginTop: "24px" } }, "Pending Withdrawals"),
    React.createElement(
      "div",
      { className: "count" },
      `${withdrawals.length} pending withdrawal${withdrawals.length !== 1 ? "s" : ""}`,
    ),
    actionError != null
      ? React.createElement(
          "div",
          {
            style: {
              color: "#f44336",
              fontSize: "12px",
              padding: "6px 8px",
              marginBottom: "8px",
            },
          },
          actionError,
        )
      : null,
    withdrawals.length > 0
      ? React.createElement(
          "table",
          { style: tableStyle },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              { style: headRowStyle },
              React.createElement("th", { style: thStyle }, "Agent"),
              React.createElement("th", { style: thStyle }, "Amount"),
              React.createElement("th", { style: thStyle }, "Destination"),
              React.createElement("th", { style: thStyle }, "Requested"),
              React.createElement("th", { style: thStyle }, "Actions"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            ...withdrawals.map((w) =>
              React.createElement(
                "tr",
                { key: w.withdrawal_id, style: bodyRowStyle },
                React.createElement("td", { style: tdMonoStyle }, truncateId(w.motebit_id)),
                React.createElement("td", { style: tdMonoStyle }, w.amount.toFixed(4)),
                React.createElement("td", { style: tdMonoStyle }, truncateId(w.destination, 20)),
                React.createElement("td", { style: tdStyle }, formatTimestamp(w.requested_at)),
                React.createElement(
                  "td",
                  { style: tdStyle },
                  React.createElement(
                    "button",
                    {
                      style: { ...btnStyle, borderColor: "#4caf50", color: "#4caf50" },
                      onClick: () => handleComplete(w.withdrawal_id),
                    },
                    "Complete",
                  ),
                  React.createElement(
                    "button",
                    {
                      style: { ...btnStyle, borderColor: "#f44336", color: "#f44336" },
                      onClick: () => handleFail(w.withdrawal_id),
                    },
                    "Fail",
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

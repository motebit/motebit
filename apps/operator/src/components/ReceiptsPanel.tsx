import React, { useState, useCallback } from "react";
import { fetchReceipt, ApiError } from "../api";

export function ReceiptsPanel(): React.ReactElement {
  const [motebitId, setMotebitId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLookup = useCallback(async () => {
    if (!motebitId.trim() || !taskId.trim()) {
      setError("Both motebit ID and task ID are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setBody(null);
    try {
      const text = await fetchReceipt(motebitId.trim(), taskId.trim());
      setBody(text);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [motebitId, taskId]);

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Receipts"),
    React.createElement(
      "p",
      { className: "count" },
      "Look up a stored ExecutionReceipt by (motebit_id, task_id). The relay returns the byte-identical canonical JSON it persisted at ingestion — re-canonicalize and re-verify offline against the receipt's `public_key` to confirm the chain.",
    ),
    React.createElement(
      "div",
      { style: { display: "flex", gap: 8, marginBottom: 12 } },
      React.createElement("input", {
        type: "text",
        placeholder: "motebit_id",
        value: motebitId,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMotebitId(e.target.value),
        style: {
          flex: 1,
          padding: "6px 10px",
          fontFamily: "monospace",
          fontSize: 12,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 4,
        },
      }),
      React.createElement("input", {
        type: "text",
        placeholder: "task_id",
        value: taskId,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTaskId(e.target.value),
        style: {
          flex: 1,
          padding: "6px 10px",
          fontFamily: "monospace",
          fontSize: 12,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 4,
        },
      }),
      React.createElement(
        "button",
        {
          className: "action-btn",
          disabled: loading,
          onClick: () => {
            void onLookup();
          },
        },
        loading ? "loading…" : "lookup",
      ),
    ),
    error != null
      ? React.createElement(
          "p",
          { className: "empty", style: { color: "var(--red)" } },
          `Error: ${error}`,
        )
      : null,
    body != null
      ? React.createElement(
          "div",
          null,
          React.createElement("h3", null, "Canonical JSON"),
          React.createElement("pre", { className: "json-block" }, body),
        )
      : null,
  );
}

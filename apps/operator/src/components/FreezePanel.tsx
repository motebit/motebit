import React, { useState, useEffect, useCallback } from "react";
import {
  fetchFreezeStatus,
  triggerFreeze,
  triggerUnfreeze,
  type FreezeStatus,
  ApiError,
} from "../api";

export function FreezePanel(): React.ReactElement {
  const [status, setStatus] = useState<FreezeStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetchFreezeStatus(signal);
      setStatus(res);
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

  const onFreeze = useCallback(async () => {
    const reason = window.prompt(
      "Freeze the relay — all write operations suspended.\n\nReason (required, will be logged):",
    );
    if (reason == null || reason.trim().length === 0) return;
    if (
      !window.confirm(
        `Confirm: freeze relay with reason "${reason.trim()}"?\n\nAll write endpoints will return 503 until unfrozen.`,
      )
    )
      return;
    setBusy(true);
    try {
      await triggerFreeze(reason.trim());
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const onUnfreeze = useCallback(async () => {
    if (!window.confirm("Unfreeze the relay? Write operations will resume.")) return;
    setBusy(true);
    try {
      await triggerUnfreeze();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!loaded) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Freeze"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  const frozen = status?.frozen ?? false;
  const stateColor = frozen ? "var(--red)" : "var(--green)";
  const stateLabel = frozen ? "✗ FROZEN" : "✓ active";

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Freeze"),
    React.createElement(
      "p",
      { className: "count" },
      "Emergency kill switch. When frozen, every write endpoint on the relay returns 503 until unfrozen. The signed bearer token still works for reads. Use during incidents — see ",
      React.createElement(
        "a",
        {
          href: "https://github.com/motebit/motebit/blob/main/docs/ops/RUNBOOK.md#7-emergency-freeze-kill-switch",
          target: "_blank",
          rel: "noreferrer",
          style: { color: "var(--accent)" },
        },
        "RUNBOOK §7",
      ),
      " for the full procedure.",
    ),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Relay state"),
        React.createElement(
          "div",
          { className: "value", style: { color: stateColor } },
          stateLabel,
        ),
      ),
      frozen && status?.reason
        ? React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Reason"),
            React.createElement(
              "div",
              {
                className: "value",
                style: { fontSize: 13, fontFamily: "monospace", color: "var(--yellow)" },
              },
              status.reason,
            ),
          )
        : null,
    ),
    error != null
      ? React.createElement(
          "p",
          { className: "empty", style: { color: "var(--red)" } },
          `Error: ${error}`,
        )
      : null,
    React.createElement(
      "div",
      { style: { display: "flex", gap: 8, marginTop: 12 } },
      frozen
        ? React.createElement(
            "button",
            {
              className: "action-btn",
              disabled: busy,
              onClick: () => {
                void onUnfreeze();
              },
            },
            busy ? "working…" : "unfreeze (resume writes)",
          )
        : React.createElement(
            "button",
            {
              className: "action-btn danger",
              disabled: busy,
              onClick: () => {
                void onFreeze();
              },
            },
            busy ? "working…" : "freeze (suspend writes)",
          ),
    ),
  );
}

/**
 * Renderer-aware runtime logger — the calm channel for runtime warnings.
 *
 * Without an injected logger the runtime falls back to
 * `console.warn("[motebit] …", JSON.stringify(ctx))`, which is how
 * `delegation poll failed {"taskId":…,"status":503,"body":""}` dumped raw
 * JSON into the input line mid-edit during the 2026-07-29 relay incident
 * (#456). Everything here flows through the terminal renderer, so a warning
 * can never corrupt the prompt — and poll trouble folds into the live
 * status row as "relay hiccup, still waiting (attempt N)" instead of
 * printing a new line per retry.
 */

import { writeLine } from "./terminal.js";
import { activeStatus } from "./statusline.js";
import { meta, warn } from "./colors.js";

export interface RuntimeLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

const POLL_TROUBLE = new Set(["delegation poll failed", "delegation poll token mint failed"]);

/** Compact human rendering of a context object: `key=value` pairs, bounded. */
export function formatContext(context: Record<string, unknown> | undefined): string {
  if (!context) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === "") continue;
    let rendered = typeof value === "string" ? value : JSON.stringify(value);
    if (rendered.length > 60) rendered = rendered.slice(0, 57) + "…";
    parts.push(`${key}=${rendered}`);
  }
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

export function createCliLogger(): RuntimeLogger {
  // Poll-failure attempts per task, session-scoped. Delegations are few;
  // the cap is a leak guard, not a policy.
  const pollAttempts = new Map<string, number>();

  return {
    warn(message: string, context?: Record<string, unknown>): void {
      if (POLL_TROUBLE.has(message)) {
        const taskId = typeof context?.taskId === "string" ? context.taskId : "unknown";
        if (pollAttempts.size > 100) pollAttempts.clear();
        const attempt = (pollAttempts.get(taskId) ?? 0) + 1;
        pollAttempts.set(taskId, attempt);

        const note = `relay hiccup, still waiting (attempt ${attempt})`;
        const status = activeStatus();
        if (status) {
          // The status row owns the in-flight moment — trouble is the
          // current step, not a fresh scrollback line per retry.
          status.note(note);
        } else {
          writeLine(meta(`  · ${note} — task ${taskId.slice(0, 8)}`));
        }
        return;
      }

      // Everything else: one calm dim line through the renderer — full
      // information, never raw JSON into the input line.
      writeLine(`  ${warn("·")} ${meta(message + formatContext(context))}`);
    },
  };
}

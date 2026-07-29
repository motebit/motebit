/**
 * Approval-request rendering — the decision moment made legible.
 *
 * The approval prompt is the single most consequential surface in the CLI:
 * it is where a human authorizes an irreversible act, sometimes a real-money
 * one. It previously rendered as raw implementation —
 * `delegate_to_agent({"prompt":"Research the Open…})` — in the same dim gray
 * as every other line, naming neither the stakes nor the source of funds. A
 * founder approved a $0.26 onchain spend from that prompt without the amount,
 * the recipient, or the word "money" appearing anywhere (#432).
 *
 * Calm software is not silent software. Motebit's own felt-interior doctrine
 * draws the line: minimum display ≠ minimum legibility to the owner — "an
 * interior the sovereign cannot feel is, to them, no interior." The money
 * decision is exactly where the owner must feel what is happening.
 *
 * Honesty constraint (load-bearing): a delegation's price is LATE-BOUND — it
 * materializes at quote resolution inside execution, not in the tool args
 * (`moneyBinding: "late"`), so at approval time the exact amount is genuinely
 * unknown. This renderer therefore states the funding SOURCE and the pricing
 * RULE rather than inventing a number. Displaying a fabricated or stale
 * figure at a consent boundary would be worse than displaying none.
 *
 * Pure: takes the request, returns lines. No I/O, no color decisions the
 * caller cannot override — testable as data.
 */

import { warn, dim, bold, action, meta } from "./colors.js";

/** `RiskLevel.R4_MONEY` — the band whose side effect is spending. */
const RISK_MONEY = 4;

export interface ApprovalRequestView {
  name: string;
  args: Record<string, unknown>;
  riskLevel?: number;
  quorum?: { required: number; approvers: string[]; collected: string[] };
  /** Hard ceiling from `--budget`, in USD, when the session set one. */
  budgetUsd?: number;
}

/** Truncate for display without lying about it. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Human-readable statement of what the tool will DO, in the second person.
 * Falls back to the tool name plus its most salient argument — never raw
 * JSON, which is implementation detail leaking into a consent decision.
 */
function describeAction(name: string, args: Record<string, unknown>): string[] {
  if (name === "delegate_to_agent") {
    const prompt = typeof args.prompt === "string" ? args.prompt : "(no prompt)";
    const caps = Array.isArray(args.required_capabilities)
      ? (args.required_capabilities as unknown[]).filter((c) => typeof c === "string")
      : [];
    return [
      "Hire an agent on the motebit network to:",
      `  "${clip(prompt, 120)}"`,
      ...(caps.length > 0 ? [`  capability: ${caps.join(", ")}`] : []),
    ];
  }

  // Generic: name the tool, then its arguments one per line as key: value.
  const entries = Object.entries(args);
  if (entries.length === 0) return [`Run ${name}`];
  return [
    `Run ${name} with:`,
    ...entries.map(
      ([k, v]) => `  ${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), 100)}`,
    ),
  ];
}

/**
 * Render the approval context block. The caller writes these lines, then
 * prompts on a SINGLE line — a multi-line prompt string is redrawn by the
 * line editor on every keystroke, which is what duplicated the block on
 * screen when the user answered (#432).
 */
export function renderApprovalRequest(req: ApprovalRequestView): string[] {
  const lines: string[] = [""];
  const isMoney = (req.riskLevel ?? 0) >= RISK_MONEY;

  if (isMoney) {
    // The stakes lead. A money act must never be visually indistinguishable
    // from a read — this is the line the founder's $0.26 slipped past.
    lines.push(`  ${warn(bold("⚠ MONEY · IRREVERSIBLE"))}`);
  }

  for (const [i, line] of describeAction(req.name, req.args).entries()) {
    lines.push(`  ${i === 0 ? action("?") + " " + bold(line) : dim(line)}`);
  }

  if (isMoney) {
    lines.push(`  ${dim("Pays from your sovereign wallet — onchain, not refundable.")}`);
    lines.push(
      req.budgetUsd != null
        ? `  ${dim(`Amount: the worker's listing price, capped at $${req.budgetUsd.toFixed(2)} by --budget.`)}`
        : // No ceiling set: say so plainly rather than implying one exists.
          `  ${dim("Amount: set by the worker's listing at hire time (no --budget ceiling set).")}`,
    );
    // Route honesty (#458): the route is LATE-BOUND, like the amount. The
    // 2026-07-29 validation run approved under the sovereign-wallet framing
    // and the delegation then degraded to relay routing with nothing said.
    // Consent must describe what can actually happen.
    lines.push(
      `  ${dim("If peer payment is unavailable, this reroutes through the relay with no wallet payment — the switch is named in the result.")}`,
    );
  }

  if (req.quorum && req.quorum.required > 1) {
    lines.push(
      `  ${meta(`[${req.quorum.collected.length}/${req.quorum.required} approvals collected]`)}`,
    );
  }

  lines.push("");
  return lines;
}

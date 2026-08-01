/**
 * The approval prompt is a consent boundary — what it shows (and what it
 * refuses to invent) is a correctness property, not styling. Locked here
 * because the live failure was a founder approving a $0.26 irreversible
 * onchain spend from a prompt that never said "money" (#432).
 */
import { describe, it, expect } from "vitest";
import { renderApprovalRequest } from "../approval-render.js";

/** Strip ANSI so assertions read the text a human sees, not the escapes. */
// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const plain = (lines: string[]): string => lines.join("\n").replace(/\[[0-9;]*m/g, "");

describe("renderApprovalRequest", () => {
  it("names MONEY and IRREVERSIBLE for an R4 spend", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "Research the Open Secure AI Alliance" },
        riskLevel: 4,
      }),
    );
    expect(out).toContain("MONEY");
    expect(out).toContain("IRREVERSIBLE");
    // The funding source is the fact the founder most needed and least had.
    expect(out).toMatch(/sovereign wallet/i);
  });

  it("states the route is late-bound — the relay-reroute possibility is part of consent (#458)", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "do research" },
        riskLevel: 4,
      }),
    );
    // Witnessed live 2026-07-29: approval framed as sovereign-wallet payment,
    // the P2P pre-flight failed closed, and the task ran relay-routed under
    // that consent. The band must describe what can actually happen — the
    // route, like the amount, is late-bound.
    expect(out).toMatch(/If peer payment is unavailable/);
    expect(out).toMatch(/no wallet payment/);
  });

  it("states the pricing RULE instead of inventing an amount (late-bound spend)", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "do research" },
        riskLevel: 4,
      }),
    );
    // A delegation's price materializes at quote resolution inside execution,
    // so no exact figure exists at consent time. Displaying a fabricated or
    // stale number at a consent boundary is worse than displaying none.
    expect(out).toMatch(/worker's listing at hire time/);
    expect(out).toMatch(/no --budget ceiling set/);
    expect(out).not.toMatch(/\$\d/); // no dollar figure when none is known
  });

  it("shows the --budget ceiling when the session set one", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "do research" },
        riskLevel: 4,
        budgetUsd: 0.5,
      }),
    );
    expect(out).toContain("$0.50");
    expect(out).not.toMatch(/no --budget ceiling set/);
  });

  it("renders the action in human language, never raw tool JSON", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "Research OSAIA", required_capabilities: ["research"] },
        riskLevel: 4,
      }),
    );
    expect(out).toContain("Hire an agent on the motebit network to:");
    expect(out).toContain('"Research OSAIA"');
    expect(out).toContain("capability: research");
    // The old rendering leaked implementation into a consent decision.
    expect(out).not.toContain('{"prompt"');
    expect(out).not.toContain("delegate_to_agent(");
  });

  it("stays quiet about money for a non-money tool", () => {
    const out = plain(
      renderApprovalRequest({ name: "web_search", args: { query: "solana" }, riskLevel: 0 }),
    );
    expect(out).not.toMatch(/MONEY/);
    expect(out).not.toMatch(/wallet/i);
    expect(out).toContain("Run web_search with:");
    expect(out).toContain("query: solana");
  });

  it("surfaces quorum progress when multi-party approval is required", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "x" },
        riskLevel: 4,
        quorum: { required: 3, approvers: ["a", "b", "c"], collected: ["a"] },
      }),
    );
    expect(out).toContain("1/3 approvals collected");
  });

  // #522 — witnessed 2026-08-01: a re-spend proposal rendered with nothing
  // saying money had already moved this exchange.
  it("names same-turn settled spend when the runtime stamped it", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "x" },
        riskLevel: 4,
        priorSettledThisTurn: 1,
      }),
    );
    expect(out).toContain("already completed this turn");
    expect(out).toContain("another spend");
  });

  it("pluralizes multiple settled spends", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "x" },
        riskLevel: 4,
        priorSettledThisTurn: 2,
      }),
    );
    expect(out).toContain("2 paid hires already completed");
  });

  it("no stamp — no history line", () => {
    const out = plain(
      renderApprovalRequest({ name: "delegate_to_agent", args: { prompt: "x" }, riskLevel: 4 }),
    );
    expect(out).not.toContain("already completed this turn");
  });

  it("clips a long prompt without letting it wrap the decision off-screen", () => {
    const out = plain(
      renderApprovalRequest({
        name: "delegate_to_agent",
        args: { prompt: "x".repeat(500) },
        riskLevel: 4,
      }),
    );
    expect(out).toContain("…");
    for (const line of out.split("\n")) expect(line.length).toBeLessThan(140);
  });
});

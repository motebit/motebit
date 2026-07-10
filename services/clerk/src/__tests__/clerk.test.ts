/**
 * The Clerk's pure engine + spend-shaping, tested without a runtime, wallet, or
 * relay. The metered R4 AND is proven in @motebit/runtime's
 * execute-granted-delegation suite; here we prove the service SHAPES a spend
 * result correctly — refusal honesty (denial CODE only), dry-run settlement,
 * and live receipt nesting. Doctrine: agent-archetypes.md §6.
 */
import { describe, it, expect, vi } from "vitest";
import { parseClerkPrompt, ClerkRefusal, runClerkSpend } from "../clerk.js";
import type { MoleculeSpendHandle, ExecutionReceipt } from "@motebit/molecule-runner";

function spendStub(result: unknown): MoleculeSpendHandle {
  return {
    heldGrant: {} as MoleculeSpendHandle["heldGrant"],
    spend: vi.fn(async () => result as Awaited<ReturnType<MoleculeSpendHandle["spend"]>>),
  };
}

describe("parseClerkPrompt", () => {
  it("bare text ⇒ default capability + the text as sub-prompt", () => {
    expect(parseClerkPrompt("survey agent identity", "research")).toEqual({
      capability: "research",
      prompt: "survey agent identity",
    });
  });

  it("JSON ⇒ explicit capability + prompt", () => {
    expect(parseClerkPrompt('{"capability":"summarize","prompt":"do X"}', "research")).toEqual({
      capability: "summarize",
      prompt: "do X",
    });
  });

  it("JSON without capability ⇒ default capability", () => {
    expect(parseClerkPrompt('{"prompt":"do Y"}', "research")).toEqual({
      capability: "research",
      prompt: "do Y",
    });
  });

  it("empty prompt ⇒ refusal", () => {
    expect(() => parseClerkPrompt("   ", "research")).toThrow(ClerkRefusal);
  });

  it("malformed JSON ⇒ refusal", () => {
    expect(() => parseClerkPrompt("{not json", "research")).toThrow(ClerkRefusal);
  });

  it("JSON with empty prompt ⇒ refusal", () => {
    expect(() => parseClerkPrompt('{"capability":"research","prompt":""}', "research")).toThrow(
      ClerkRefusal,
    );
  });
});

describe("runClerkSpend — receipt shaping", () => {
  const task = { capability: "research", prompt: "survey" };

  it("refusal ⇒ ok:false, denial CODE only, NO overage, no nested receipt", async () => {
    const spend = spendStub({ ok: false, code: "lifetime_exceeded" });
    const outcome = await runClerkSpend(spend, task, true);
    expect(outcome.ok).toBe(false);
    expect(outcome.delegationReceipts).toEqual([]);
    const payload = JSON.parse(outcome.result) as Record<string, unknown>;
    expect(payload).toEqual({ ok: false, code: "lifetime_exceeded" });
    // Owner-safe: nothing resembling the overage quantity leaks into the receipt.
    expect(outcome.result).not.toContain("micro");
    expect(outcome.result).not.toContain("overage");
  });

  it("dry-run OK ⇒ settlement facts, NO worker receipt (no worker ran)", async () => {
    const spend = spendStub({
      ok: true,
      dryRun: true,
      settlement: { mode: "p2p", paidMicro: 50_000 },
    });
    const outcome = await runClerkSpend(spend, task, true);
    expect(outcome.ok).toBe(true);
    expect(outcome.delegationReceipts).toEqual([]);
    const payload = JSON.parse(outcome.result) as Record<string, unknown>;
    expect(payload.dry_run).toBe(true);
    expect(payload.settlement).toEqual({ mode: "p2p", paidMicro: 50_000 });
  });

  it("live OK ⇒ nests the worker receipt into delegationReceipts", async () => {
    const receipt = { task_id: "t", signature: "sig" } as unknown as ExecutionReceipt;
    const spend = spendStub({
      ok: true,
      dryRun: false,
      receipt,
      settlement: { mode: "p2p", paidMicro: 50_000 },
    });
    const outcome = await runClerkSpend(spend, task, false);
    expect(outcome.ok).toBe(true);
    expect(outcome.delegationReceipts).toEqual([receipt]);
    const payload = JSON.parse(outcome.result) as Record<string, unknown>;
    expect(payload.dry_run).toBe(false);
  });

  it("threads dryRun through to the spend handle", async () => {
    const spend = spendStub({ ok: true, dryRun: true, settlement: { mode: "p2p" } });
    await runClerkSpend(spend, task, true);
    expect(spend.spend).toHaveBeenCalledWith({
      capability: "research",
      prompt: "survey",
      dryRun: true,
    });
  });
});

/**
 * Bare-name capability routing (#430, surface-determinism): typing
 * `wallet` or `motebit wallet` in the REPL must invoke the capability,
 * not feed the AI loop — while ordinary chat must stay chat. The
 * resolver is deliberately narrow; these tests lock both directions.
 */
import { describe, it, expect } from "vitest";
import { resolveBareCommand } from "../slash-commands.js";
import { renderIdentityCard } from "../subcommands/id.js";

describe("resolveBareCommand", () => {
  it("routes the exact read-only capability names", () => {
    expect(resolveBareCommand("wallet")).toBe("/wallet");
    expect(resolveBareCommand("id")).toBe("/id");
    expect(resolveBareCommand("balance")).toBe("/balance");
    expect(resolveBareCommand("help")).toBe("/help");
  });

  it("routes the shell-habit form (`motebit wallet` — the witnessed case)", () => {
    expect(resolveBareCommand("motebit wallet")).toBe("/wallet");
    expect(resolveBareCommand("motebit id")).toBe("/id");
  });

  it("ledger takes exactly one argument, the goal id", () => {
    expect(resolveBareCommand("ledger goal-123")).toBe("/ledger goal-123");
    expect(resolveBareCommand("motebit ledger goal-123")).toBe("/ledger goal-123");
    expect(resolveBareCommand("ledger")).toBeNull();
    expect(resolveBareCommand("ledger a b")).toBeNull();
  });

  it("questions are chat, even when they start with a capability name", () => {
    expect(resolveBareCommand("wallet?")).toBeNull();
    expect(resolveBareCommand("what is a wallet?")).toBeNull();
  });

  it("sentences are chat — extra words never match", () => {
    expect(resolveBareCommand("wallet addresses are derived from keys")).toBeNull();
    expect(resolveBareCommand("check my wallet")).toBeNull();
    expect(resolveBareCommand("id like to know more")).toBeNull();
  });

  it("money/mutating commands never route from bare text", () => {
    expect(resolveBareCommand("delegate")).toBeNull();
    expect(resolveBareCommand("withdraw")).toBeNull();
    expect(resolveBareCommand("grant")).toBeNull();
    expect(resolveBareCommand("motebit delegate")).toBeNull();
  });

  it("case-insensitive on the name, null on empty", () => {
    expect(resolveBareCommand("Wallet")).toBe("/wallet");
    expect(resolveBareCommand("")).toBeNull();
  });
});

describe("renderIdentityCard", () => {
  it("null when no identity — each surface picks its own failure posture", () => {
    expect(renderIdentityCard({})).toBeNull();
  });

  it("renders the card fields that exist", () => {
    const lines = renderIdentityCard({
      motebit_id: "mid-1",
      device_public_key: "a".repeat(64),
      device_id: "dev-1",
    })!;
    const text = lines.join("\n");
    expect(text).toContain("motebit_id   mid-1");
    expect(text).toContain("public_key   aaaaaaaaaaaaaaaa...");
    expect(text).toContain("device_id    dev-1");
  });
});

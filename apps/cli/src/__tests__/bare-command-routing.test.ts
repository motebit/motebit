/**
 * Bare-name capability routing (#430, surface-determinism): typing
 * `wallet` or `motebit wallet` in the REPL must invoke the capability,
 * not feed the AI loop — while ordinary chat must stay chat. The
 * resolver is deliberately narrow; these tests lock both directions.
 */
import { describe, it, expect } from "vitest";
import { detectShellInvocation, resolveBareCommand } from "../slash-commands.js";
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

/**
 * Shell-invocation detector (#500): a full CLI invocation typed at the
 * chat prompt teaches instead of reaching the model. Witnessed live: the
 * fall-through let a weak model fabricate an R4 money intent from
 * `motebit --provider anthropic`. Vocabulary comes from the committed
 * cli-surface baseline, never a hand-list.
 */
describe("detectShellInvocation", () => {
  const TEACH = "shell command";

  it("detects the witnessed incident input — known flag after the motebit prefix", () => {
    expect(detectShellInvocation("motebit --provider anthropic")).toContain(TEACH);
  });

  it("detects known subcommand invocations, with flags and args", () => {
    expect(detectShellInvocation("motebit seed reveal")).toContain(TEACH);
    expect(detectShellInvocation("motebit run --price 5")).toContain(TEACH);
    expect(detectShellInvocation("motebit doctor")).toContain(TEACH);
    expect(detectShellInvocation("motebit balance extra words")).toContain(TEACH);
  });

  it("detects --flag=value shapes", () => {
    expect(detectShellInvocation("motebit --model=claude-opus-5")).toContain(TEACH);
  });

  it("ordinary sentences starting with 'motebit' stay chat", () => {
    expect(detectShellInvocation("motebit is a droplet of intelligence")).toBeNull();
    expect(detectShellInvocation("motebit please research quantum computing")).toBeNull();
  });

  it("unknown flags and subcommands stay chat — only the real surface teaches", () => {
    expect(detectShellInvocation("motebit --frobnicate now")).toBeNull();
    expect(detectShellInvocation("motebit frobnicate")).toBeNull();
  });

  it("questions stay chat even when command-shaped", () => {
    expect(detectShellInvocation("motebit --provider anthropic?")).toBeNull();
  });

  it("no motebit prefix or bare 'motebit' stays chat", () => {
    expect(detectShellInvocation("--provider anthropic")).toBeNull();
    expect(detectShellInvocation("motebit")).toBeNull();
    expect(detectShellInvocation("run --price 5")).toBeNull();
  });

  it("never resolves to an executed command — the return is a teach line only", () => {
    const line = detectShellInvocation("motebit seed reveal")!;
    expect(line.startsWith("/")).toBe(false);
    expect(line).toContain("run it in your terminal");
  });

  it("read-only bare names still route deterministically first (caller ordering contract)", () => {
    // `motebit wallet` matches BOTH the resolver and the detector; the
    // caller runs resolveBareCommand first, so the deterministic slash
    // wins. This test documents that both halves match it.
    expect(resolveBareCommand("motebit wallet")).toBe("/wallet");
    expect(detectShellInvocation("motebit wallet")).toContain(TEACH);
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

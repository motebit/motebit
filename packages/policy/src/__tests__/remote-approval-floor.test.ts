/**
 * #880 C — a tool's own `requiresApproval: true` binds every REMOTE caller.
 *
 * The triage repro: `/serve --operator` with the autonomous preset
 * (requireApprovalAbove R3, denyAbove R4). Band mode derived approval from
 * risk alone, so `write_file` (R2, `requiresApproval: true`) auto-executed
 * for a remote Verified caller — the tool's own floor was ignored — and a
 * Trusted caller cleared it in every mode. The owner's own turns keep band
 * semantics: the autonomous preset still auto-runs `write_file` locally.
 */
import { describe, it, expect } from "vitest";
import { PolicyGate } from "../index.js";
import { AgentTrustLevel, RiskLevel, SideEffect } from "@motebit/protocol";
import type { ToolDefinition, TurnContext } from "@motebit/protocol";

const WRITE_FILE: ToolDefinition = {
  name: "write_file",
  description: "Write content to a file. Overwrites existing content.",
  inputSchema: { type: "object" },
  requiresApproval: true,
};
const SHELL_EXEC: ToolDefinition = {
  name: "shell_exec",
  description: "Execute a shell command.",
  inputSchema: { type: "object" },
  requiresApproval: true,
};
/** R2 with no tool-level flag — band semantics apply to remote callers as before. */
const PLAIN_WRITE: ToolDefinition = {
  name: "notes_update",
  description: "Update a note",
  inputSchema: { type: "object" },
};
/** R1 with the flag — the service-caller lowering must not clear it. */
const FLAGGED_DRAFT: ToolDefinition = {
  name: "draft_reply",
  description: "Draft a reply",
  inputSchema: { type: "object" },
  riskHint: { risk: RiskLevel.R1_DRAFT, sideEffect: SideEffect.NONE },
  requiresApproval: true,
};

function autonomousGate(): PolicyGate {
  return new PolicyGate({
    operatorMode: true,
    maxRiskLevel: RiskLevel.R4_MONEY,
    requireApprovalAbove: RiskLevel.R3_EXECUTE,
    denyAbove: RiskLevel.R4_MONEY,
  });
}

function ctx(over: Partial<TurnContext> = {}): TurnContext {
  return { turnId: "t", toolCallCount: 0, turnStartMs: Date.now(), costAccumulated: 0, ...over };
}

const remote = (trust: AgentTrustLevel): Partial<TurnContext> => ({
  callerMotebitId: "peer-mote",
  callerTrustLevel: trust,
});

describe("a tool's own approval floor binds remote callers (#880 C)", () => {
  it("the owner's own turn keeps band semantics: autonomous auto-runs write_file locally", () => {
    const d = autonomousGate().validate(WRITE_FILE, { path: "a", content: "b" }, ctx());
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it("the triage repro: a remote Verified caller's write_file needs approval under autonomous", () => {
    const d = autonomousGate().validate(
      WRITE_FILE,
      { path: "a", content: "b" },
      ctx(remote(AgentTrustLevel.Verified)),
    );
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });

  it("…and shell_exec (R3, flagged) likewise", () => {
    const d = autonomousGate().validate(
      SHELL_EXEC,
      { command: "ls" },
      ctx(remote(AgentTrustLevel.Verified)),
    );
    expect(d.requiresApproval).toBe(true);
  });

  it("the Trusted inbound bypass cannot clear the floor", () => {
    const d = autonomousGate().validate(
      WRITE_FILE,
      { path: "a", content: "b" },
      ctx(remote(AgentTrustLevel.Trusted)),
    );
    expect(d.requiresApproval).toBe(true);
    // Legacy (no bands) too.
    const legacy = new PolicyGate({ operatorMode: true }).validate(
      WRITE_FILE,
      {},
      ctx(remote(AgentTrustLevel.Trusted)),
    );
    expect(legacy.requiresApproval).toBe(true);
  });

  it("the service-caller lowering cannot clear the floor", () => {
    const d = autonomousGate().validate(
      FLAGGED_DRAFT,
      {},
      ctx({ callerMotebitId: "svc", remoteMotebitType: "service" }),
    );
    expect(d.requiresApproval).toBe(true);
  });

  it("a remote caller with only a type (no id, no trust level) is still remote", () => {
    const d = autonomousGate().validate(
      WRITE_FILE,
      {},
      ctx({ remoteMotebitType: "collaborative" }),
    );
    expect(d.requiresApproval).toBe(true);
  });

  it("does not widen: an unflagged R2 tool keeps band semantics for a Verified caller", () => {
    const d = autonomousGate().validate(PLAIN_WRITE, {}, ctx(remote(AgentTrustLevel.Verified)));
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it("does not convert a hard deny into an approval", () => {
    const d = new PolicyGate({
      operatorMode: true,
      requireApprovalAbove: RiskLevel.R1_DRAFT,
      denyAbove: RiskLevel.R1_DRAFT,
    }).validate(WRITE_FILE, {}, ctx(remote(AgentTrustLevel.Verified)));
    expect(d.allowed).toBe(false);
  });
});

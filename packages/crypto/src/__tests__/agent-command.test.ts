/**
 * Agent-command envelope convention — the first consumer binding of
 * signed-request-envelope@1.0. Every rejection path is fail-closed
 * with an honest reason; cross-agent replay is killed by the
 * target-bound audience; payload tamper by the detached digest.
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
  agentCommandAudience,
  agentCommandPayload,
  signAgentCommandEnvelope,
  verifyAgentCommandEnvelope,
} from "../agent-command.js";
import { bytesToHex, generateKeypair, type KeyPair } from "../signing.js";

const AGENT_A = "36080ffe-cmd-8000-a000-00000000000a";
const AGENT_B = "36080ffe-cmd-8000-a000-00000000000b";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

describe("agentCommandAudience / agentCommandPayload", () => {
  it("binds the audience to the target agent", () => {
    expect(agentCommandAudience(AGENT_A)).toBe(`agent-command/${AGENT_A}`);
  });

  it("normalizes absent args to null so signer and verifier hash identical bytes", () => {
    expect(agentCommandPayload("state")).toEqual({ command: "state", args: null });
    expect(agentCommandPayload("forget", "node-1")).toEqual({ command: "forget", args: "node-1" });
  });
});

describe("sign + verify round-trip", () => {
  it("accepts a well-formed self-command (bytes key)", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_A,
      identityPrivateKey: keys.privateKey,
    });
    const verdict = await verifyAgentCommandEnvelope({
      envelope,
      command: "state",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("accepts a hex-string public key (registry storage shape)", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "memories",
      args: "recent",
      motebitId: AGENT_A,
      identityPrivateKey: keys.privateKey,
    });
    const verdict = await verifyAgentCommandEnvelope({
      envelope,
      command: "memories",
      args: "recent",
      motebitId: AGENT_A,
      identityPublicKey: bytesToHex(keys.publicKey),
    });
    expect(verdict).toEqual({ ok: true });
  });
});

describe("fail-closed rejections", () => {
  it("rejects a missing envelope with an honest unsigned-rejected reason", async () => {
    const verdict = await verifyAgentCommandEnvelope({
      envelope: undefined,
      command: "state",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("unsigned remote commands are not accepted");
  });

  it("rejects an envelope signed by a different identity", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_B,
      identityPrivateKey: keys.privateKey,
    });
    const verdict = await verifyAgentCommandEnvelope({
      envelope,
      command: "state",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("not this agent's identity");
  });

  it("kills cross-agent replay: same identity string forged onto another target's envelope", async () => {
    // An attacker takes A's valid envelope and rewrites motebit_id to A
    // while presenting it at A — but it was signed with aud agent-command/B.
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_B,
      identityPrivateKey: keys.privateKey,
    });
    const forged = { ...envelope, motebit_id: AGENT_A };
    const verdict = await verifyAgentCommandEnvelope({
      envelope: forged,
      command: "state",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
    });
    expect(verdict.ok).toBe(false); // signature breaks AND audience mismatches
  });

  it("rejects payload tamper (command swapped after signing)", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_A,
      identityPrivateKey: keys.privateKey,
    });
    const verdict = await verifyAgentCommandEnvelope({
      envelope,
      command: "forget", // executed command differs from signed digest
      args: "node-1",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects args tamper (args injected onto an args-less envelope)", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "forget",
      motebitId: AGENT_A,
      identityPrivateKey: keys.privateKey,
    });
    const verdict = await verifyAgentCommandEnvelope({
      envelope,
      command: "forget",
      args: "every-memory",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a stale envelope outside the §4 freshness window", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_A,
      identityPrivateKey: keys.privateKey,
      now: () => 1_000_000,
    });
    const verdict = await verifyAgentCommandEnvelope({
      envelope,
      command: "state",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
      now: 1_000_000 + 300_001, // one ms past the default ±300s window
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a signature forged with a different key", async () => {
    const stranger = await generateKeypair();
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_A,
      identityPrivateKey: stranger.privateKey,
    });
    const verdict = await verifyAgentCommandEnvelope({
      envelope,
      command: "state",
      motebitId: AGENT_A,
      identityPublicKey: keys.publicKey,
    });
    expect(verdict.ok).toBe(false);
  });
});

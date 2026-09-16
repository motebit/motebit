/**
 * Remote command ingress hardening (daemon-desktop unification,
 * increment 4): POST /api/v1/agents/:motebitId/command requires a
 * signed-request-envelope@1.0 signed by the agent's OWN identity,
 * audience-bound to the target, digest-bound to {command, args}. The
 * relay verifies fail-closed at ingress and forwards the envelope
 * verbatim for the surface's authoritative re-verification.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex, signAgentCommandEnvelope } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { JSON_AUTH, createTestRelay } from "./test-helpers.js";

const AGENT_ID = "36080ffe-cmd4-8000-a000-0000000000aa";

let relay: SyncRelay;
let keys: KeyPair;

async function registerAgent(motebitId: string, publicKeyHex: string): Promise<void> {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
}

async function postCommand(
  motebitId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  // JSON_AUTH satisfies the route-level transport auth (dualAuth
  // middleware); the envelope is the END-TO-END command authorization
  // this test exercises — transport auth alone must not execute.
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/command`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  relay = await createTestRelay();
  keys = await generateKeypair();
  await registerAgent(AGENT_ID, bytesToHex(keys.publicKey));
});

afterEach(() => {
  void relay.close();
});

describe("command ingress envelope verification", () => {
  it("rejects an unsigned command_request with an honest 401", async () => {
    const { status, json } = await postCommand(AGENT_ID, { command: "balance" });
    expect(status).toBe(401);
    expect(
      String(
        (json.error as string | undefined) ??
          (json.message as string | undefined) ??
          JSON.stringify(json),
      ),
    ).toContain("unsigned remote commands are not accepted");
  });

  it("rejects a command for an unregistered agent identity", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "balance",
      motebitId: "36080ffe-cmd4-8000-a000-0000000000bb",
      identityPrivateKey: keys.privateKey,
    });
    const { status } = await postCommand("36080ffe-cmd4-8000-a000-0000000000bb", {
      command: "balance",
      envelope,
    });
    expect(status).toBe(401);
  });

  it("executes a command when the envelope verifies (info command, no DB)", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "withdraw",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    const { status, json } = await postCommand(AGENT_ID, { command: "withdraw", envelope });
    expect(status).toBe(200);
    expect(String(json.summary)).toContain("CLI");
  });

  it("rejects a command that differs from the signed payload digest", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "balance",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    const { status, json } = await postCommand(AGENT_ID, { command: "deposits", envelope });
    expect(status).toBe(401);
    expect(
      String((json.error as string | undefined) ?? (json.message as string | undefined) ?? ""),
    ).toContain("verification failed");
  });

  it("rejects an envelope signed by a key that is not the registered identity key", async () => {
    const stranger = await generateKeypair();
    const envelope = await signAgentCommandEnvelope({
      command: "balance",
      motebitId: AGENT_ID,
      identityPrivateKey: stranger.privateKey,
    });
    const { status } = await postCommand(AGENT_ID, { command: "balance", envelope });
    expect(status).toBe(401);
  });

  it("reaches the forwarding path (404 not-connected) only after verification", async () => {
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    const { status, json } = await postCommand(AGENT_ID, { command: "state", envelope });
    expect(status).toBe(404); // verified, but no connected device
    expect(String(json.summary)).toContain("not connected");
  });
});

/**
 * The mutating verbs must reach a runtime that can actually serve them.
 *
 * Every surface of a motebit holds an open socket and handles
 * `command_request` — the phone, the web app, the desktop app, the
 * daemon. Sending a halt to the phone that sent it would be answered
 * "this surface cannot be halted" while the daemon kept running, and an
 * approval decision sent to a surface with no queue would be answered
 * "no pending approval matching …". Both are indistinguishable from a
 * genuine refusal, on exactly the commands where a false negative costs
 * the most.
 */
describe("unattended-runtime commands are routed to a runtime that can serve them", () => {
  function fakePeer(deviceId: string, capabilities: string[]) {
    const sentTo: string[] = [];
    return {
      peer: {
        ws: {
          send: (payload: string) => {
            sentTo.push(payload);
          },
        },
        deviceId,
        capabilities,
      },
      sentTo,
    };
  }

  it("a halt is not sent to a surface that only watches — it fails as undelivered", async () => {
    const phone = fakePeer("phone", ["push_wake"]);
    relay.connections.set(AGENT_ID, [
      phone.peer as unknown as typeof relay.connections extends Map<string, (infer T)[]>
        ? T
        : never,
    ]);
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    const { status, json } = await postCommand(AGENT_ID, { command: "halt", envelope });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(json)).toMatch(/No unattended runtime is connected|not connected/i);
    // Crucially: the phone was never asked.
    expect(phone.sentTo).toEqual([]);
  });

  it("a halt IS sent to the peer that runs unattended work", async () => {
    const phone = fakePeer("phone", ["push_wake"]);
    const daemon = fakePeer("daemon", ["file_system", "background"]);
    relay.connections.set(AGENT_ID, [phone.peer, daemon.peer] as unknown as Parameters<
      typeof relay.connections.set
    >[1]);
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    // No response will come back, so this times out — what is asserted is
    // WHO was asked, not the answer.
    void postCommand(AGENT_ID, { command: "halt", envelope });
    await new Promise((r) => setTimeout(r, 50));
    expect(daemon.sentTo).toHaveLength(1);
    expect(phone.sentTo).toEqual([]);
    expect(daemon.sentTo[0]).toContain('"command":"halt"');
  });

  it("a read-only command may still be answered by any connected surface", async () => {
    const phone = fakePeer("phone", ["push_wake"]);
    relay.connections.set(AGENT_ID, [phone.peer] as unknown as Parameters<
      typeof relay.connections.set
    >[1]);
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    void postCommand(AGENT_ID, { command: "state", envelope });
    await new Promise((r) => setTimeout(r, 50));
    expect(phone.sentTo).toHaveLength(1);
  });
});

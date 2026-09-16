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
import {
  generateKeypair,
  bytesToHex,
  signAgentCommandEnvelope,
  mintAudienceToken,
} from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { KeyPair } from "@motebit/crypto";
import { JSON_AUTH, createTestRelay, createAgent } from "./test-helpers.js";

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
    // 404, not 500: a consent surface must be able to read this as
    // "nothing was delivered", which is not the same as "the relay broke".
    expect(status).toBe(404);
    expect(JSON.stringify(json)).toMatch(/No unattended runtime is connected|not connected/i);
    // Crucially: the phone was never asked.
    expect(phone.sentTo).toEqual([]);
  });

  it("a halt IS sent to the peer that runs unattended work", async () => {
    const phone = fakePeer("phone", ["push_wake"]);
    const daemon = fakePeer("daemon", ["file_system", "background", "unattended_runtime"]);
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

  it("a surface that merely works in the background is not treated as the runtime", async () => {
    // The desktop app announces `background` and wires neither the halt
    // store nor a decidable approval queue. Routing by `background`
    // would let it answer "this surface cannot be halted" while the
    // daemon kept running — indistinguishable from a refusal.
    const desktop = fakePeer("desktop", ["background", "file_system"]);
    relay.connections.set(AGENT_ID, [desktop.peer] as unknown as Parameters<
      typeof relay.connections.set
    >[1]);
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    const { status } = await postCommand(AGENT_ID, { command: "halt", envelope });
    expect(status).toBe(404); // not delivered — never a 500
    expect(desktop.sentTo).toEqual([]);
  });

  it("the legacy `approvals` fallback is used when exactly one peer could be the daemon", async () => {
    // Installed CLIs update on their own schedule, so a daemon older
    // than the capability still has to be reachable for one release.
    const daemon = fakePeer("old-daemon", ["stdio_mcp", "file_system", "keyring", "background"]);
    relay.connections.set(AGENT_ID, [daemon.peer] as unknown as Parameters<
      typeof relay.connections.set
    >[1]);
    const envelope = await signAgentCommandEnvelope({
      command: "approvals",
      args: "list",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    void postCommand(AGENT_ID, { command: "approvals", args: "list", envelope });
    await new Promise((r) => setTimeout(r, 50));
    expect(daemon.sentTo).toHaveLength(1);
  });

  it("the fallback refuses rather than guess between two indistinguishable peers", async () => {
    // The desktop app announces exactly the daemon's five capabilities,
    // so with both connected there is no signal that tells them apart.
    // Guessing wrong answers `/approve ap-1234` with "no pending
    // approval matching ap-1234" — which a person cannot distinguish
    // from the daemon genuinely refusing. A false refusal on the
    // consent vocabulary is worse than an undelivered one.
    const five = ["stdio_mcp", "http_mcp", "file_system", "keyring", "background"];
    const daemon = fakePeer("old-daemon", five);
    const desktop = fakePeer("desktop", five);
    relay.connections.set(AGENT_ID, [desktop.peer, daemon.peer] as unknown as Parameters<
      typeof relay.connections.set
    >[1]);
    const envelope = await signAgentCommandEnvelope({
      command: "approvals",
      args: "approve ap-1234",
      motebitId: AGENT_ID,
      identityPrivateKey: keys.privateKey,
    });
    const { status, json } = await postCommand(AGENT_ID, {
      command: "approvals",
      args: "approve ap-1234",
      envelope,
    });
    expect(status).toBe(404);
    expect(JSON.stringify(json)).toMatch(/cannot tell the daemon from a desktop app/i);
    expect(daemon.sentTo).toEqual([]);
    expect(desktop.sentTo).toEqual([]);
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

/**
 * The transport-auth contract, pinned from the side that defines it.
 *
 * This route sits behind the `/api/v1/agents/*` middleware and is not in
 * `PUBLIC_AGENT_ROUTES`, so it requires a device bearer with the
 * route's audience BEFORE the envelope is ever examined. The rest of
 * this file authenticates with the operator master token, which takes a
 * bypass branch — which is precisely why a client that sent no bearer,
 * and a phone that sent the `sync` audience, both shipped broken: every
 * test at every layer was talking to something that agreed with it.
 *
 * `packages/relay-client` asserts the other half (the client sends an
 * `admin:query` bearer). The two meet here rather than at a stub.
 */
describe("the command route's transport-auth contract", () => {
  // A coherent fixture: one identity, one registered device, and the
  // agent-registry row that envelope verification reads — all on the
  // same key, which is what a real daemon or phone has.
  let mid: string;
  let did: string;

  beforeEach(async () => {
    const agent = await createAgent(relay, bytesToHex(keys.publicKey));
    mid = agent.motebitId;
    did = agent.deviceId;
    await registerAgent(mid, bytesToHex(keys.publicKey));
  });

  async function postWith(aud: TokenAudience | null): Promise<number> {
    const envelope = await signAgentCommandEnvelope({
      command: "halt-status",
      motebitId: mid,
      identityPrivateKey: keys.privateKey,
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (aud != null) {
      const { token } = await mintAudienceToken({ mid, did, aud }, keys.privateKey);
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await relay.app.request(`/api/v1/agents/${mid}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "halt-status", envelope }),
    });
    return res.status;
  }

  it("refuses a request with no bearer — a valid envelope is not enough to get in the door", async () => {
    expect(await postWith(null)).toBe(401);
  });

  it("refuses the `sync` audience — the exact mistake that made every phone command fail", async () => {
    expect(await postWith("sync")).toBe(401);
  });

  it("accepts the audience the client actually sends", async () => {
    // Past the middleware and past envelope verification. 404 because no
    // unattended runtime is connected in this test — the handler
    // answering, not the door refusing.
    expect(await postWith("admin:query")).toBe(404);
  });
});

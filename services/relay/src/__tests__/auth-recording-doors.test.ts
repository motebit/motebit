/**
 * Every auth door records, once (#827 v2; relay rule 6).
 *
 * 1. The dualAuth doors — task submit, the account family, market candidates,
 *    the browser-sandbox grant — record master-token presentations and
 *    refusals. `registerAuthMiddleware` never received the recorder, so they
 *    recorded nothing; carving the browser-sandbox grant out of the `/api/v1/*`
 *    catch-all (which had recorded it) made that a regression on that path.
 * 2. Proposals respond enforces spec/proposals-v1.md §3.2: a non-participant
 *    is refused (403, recorded) and the initiator receives no frame.
 * 3. One request records one master-token row, however many auth layers wrap
 *    it (proposals' bare path; the account family's two layers).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import { AUTH_HEADER, JSON_AUTH, createTestRelay, createAgent } from "./test-helpers.js";

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

async function seedAgent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const { motebitId, deviceId } = await createAgent(relay, bytesToHex(kp.publicKey));
  return { motebitId, deviceId, privateKey: kp.privateKey };
}

async function mint(a: Agent, aud: TokenAudience): Promise<string> {
  return (await mintAudienceToken({ mid: a.motebitId, did: a.deviceId, aud }, a.privateKey)).token;
}

function rows(relay: SyncRelay, kind: string, path: string): Array<Record<string, unknown>> {
  return relay.moteDb.db
    .prepare("SELECT * FROM relay_auth_events WHERE kind = ? AND path = ?")
    .all(kind, path) as Array<Record<string, unknown>>;
}

describe("auth doors record, once (#827)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  describe("1 — dualAuth doors record", () => {
    const SANDBOX = "/api/v1/browser-sandbox/token";

    it.each(["POST", "GET"])(
      "%s browser-sandbox/token with the master token writes one master_token row",
      async (method) => {
        await relay.app.request(SANDBOX, {
          method,
          headers: JSON_AUTH,
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(rows(relay, "master_token", SANDBOX)).toHaveLength(1);
      },
    );

    it("a refused device token on browser-sandbox/token writes a refusal row", async () => {
      const a = await seedAgent(relay);
      const res = await relay.app.request(SANDBOX, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await mint(a, "sync")}`,
        },
        body: "{}",
      });
      expect(res.status).toBe(401);
      const refused = rows(relay, "device_token_rejected", SANDBOX);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        motebit_id: a.motebitId,
        audience: "browser-sandbox-grant",
      });
    });

    it("task submit and market candidates (dualAuth only) record the master token", async () => {
      const a = await seedAgent(relay);
      await relay.app.request(`/agent/${a.motebitId}/task`, {
        method: "POST",
        headers: JSON_AUTH,
        body: "{}",
      });
      await relay.app.request("/api/v1/market/candidates", { headers: AUTH_HEADER });
      expect(rows(relay, "master_token", `/agent/${a.motebitId}/task`)).toHaveLength(1);
      expect(rows(relay, "master_token", "/api/v1/market/candidates")).toHaveLength(1);
    });
  });

  describe("2 — proposals respond binds the responder (§3.2)", () => {
    async function seedProposal(initiator: Agent, participant: Agent): Promise<string> {
      const res = await relay.app.request("/api/v1/proposals", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          proposal_id: "prop-32",
          plan_id: "plan-32",
          initiator_motebit_id: initiator.motebitId,
          participants: [{ motebit_id: participant.motebitId, assigned_steps: [0] }],
        }),
      });
      expect(res.status).toBe(201);
      return "prop-32";
    }

    function captureFrames(motebitId: string): string[] {
      const frames: string[] = [];
      relay.connections.set(motebitId, [
        { ws: { send: (d: string) => frames.push(d), close: () => {} } } as never,
      ]);
      return frames;
    }

    it("a non-participant's `proposal` token → 403, recorded, nothing written, no frame", async () => {
      const initiator = await seedAgent(relay);
      const participant = await seedAgent(relay);
      const stranger = await seedAgent(relay);
      const id = await seedProposal(initiator, participant);
      const frames = captureFrames(initiator.motebitId);

      const res = await relay.app.request(`/api/v1/proposals/${id}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await mint(stranger, "proposal")}`,
        },
        body: JSON.stringify({ response: "reject" }),
      });
      expect(res.status).toBe(403);
      expect(frames).toEqual([]);
      const status = relay.moteDb.db
        .prepare("SELECT status FROM relay_proposals WHERE proposal_id = ?")
        .get(id) as { status: string };
      expect(status.status).toBe("pending");
      const refused = rows(relay, "agent_token_rejected", `/api/v1/proposals/${id}/respond`);
      expect(refused).toEqual([
        expect.objectContaining({
          motebit_id: stranger.motebitId,
          reason: "proposal:not_a_participant",
        }),
      ]);
    });

    it("withdraw by a non-initiator → 403, recorded as proposal:not_initiator, still pending", async () => {
      const initiator = await seedAgent(relay);
      const participant = await seedAgent(relay);
      const id = await seedProposal(initiator, participant);
      const res = await relay.app.request(`/api/v1/proposals/${id}/withdraw`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await mint(participant, "proposal")}` },
      });
      expect(res.status).toBe(403);
      expect(rows(relay, "agent_token_rejected", `/api/v1/proposals/${id}/withdraw`)).toEqual([
        expect.objectContaining({
          motebit_id: participant.motebitId,
          reason: "proposal:not_initiator",
        }),
      ]);
      const status = relay.moteDb.db
        .prepare("SELECT status FROM relay_proposals WHERE proposal_id = ?")
        .get(id) as { status: string };
      expect(status.status).toBe("pending");
    });

    it("step-result by a non-participant → 403, recorded as proposal:not_a_participant", async () => {
      const initiator = await seedAgent(relay);
      const participant = await seedAgent(relay);
      const stranger = await seedAgent(relay);
      const id = await seedProposal(initiator, participant);
      const res = await relay.app.request(`/api/v1/proposals/${id}/step-result`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await mint(stranger, "proposal")}`,
        },
        body: JSON.stringify({ step_id: "s0", status: "completed" }),
      });
      expect(res.status).toBe(403);
      expect(rows(relay, "agent_token_rejected", `/api/v1/proposals/${id}/step-result`)).toEqual([
        expect.objectContaining({
          motebit_id: stranger.motebitId,
          reason: "proposal:not_a_participant",
        }),
      ]);
    });

    it("§3.5: a participant's response after expires_at → 410, status unchanged, no frame", async () => {
      const initiator = await seedAgent(relay);
      const participant = await seedAgent(relay);
      const id = await seedProposal(initiator, participant);
      relay.moteDb.db
        .prepare("UPDATE relay_proposals SET expires_at = ? WHERE proposal_id = ?")
        .run(Date.now() - 1000, id);
      const frames = captureFrames(initiator.motebitId);
      const res = await relay.app.request(`/api/v1/proposals/${id}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await mint(participant, "proposal")}`,
        },
        body: JSON.stringify({ response: "accept" }),
      });
      expect(res.status).toBe(410);
      expect(frames).toEqual([]);
      const row = relay.moteDb.db
        .prepare("SELECT status FROM relay_proposals WHERE proposal_id = ?")
        .get(id) as { status: string };
      expect(row.status).toBe("pending");
      const resp = relay.moteDb.db
        .prepare(
          "SELECT response FROM relay_proposal_participants WHERE proposal_id = ? AND motebit_id = ?",
        )
        .get(id, participant.motebitId) as { response: string | null };
      expect(resp.response).toBeNull();
    });

    it("the master token naming a non-participant responder is refused too", async () => {
      const initiator = await seedAgent(relay);
      const participant = await seedAgent(relay);
      const stranger = await seedAgent(relay);
      const id = await seedProposal(initiator, participant);
      const res = await relay.app.request(`/api/v1/proposals/${id}/respond`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ responder_motebit_id: stranger.motebitId, response: "accept" }),
      });
      expect(res.status).toBe(403);
    });

    it("a named participant's response is accepted and the initiator is notified", async () => {
      const initiator = await seedAgent(relay);
      const participant = await seedAgent(relay);
      const id = await seedProposal(initiator, participant);
      const frames = captureFrames(initiator.motebitId);
      const res = await relay.app.request(`/api/v1/proposals/${id}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await mint(participant, "proposal")}`,
        },
        body: JSON.stringify({ response: "accept" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("accepted");
      expect(frames.some((f) => f.includes('"proposal_response"'))).toBe(true);
    });
  });

  describe("3 — one request, one master-token row", () => {
    it("GET /api/v1/proposals with the master token", async () => {
      const a = await seedAgent(relay);
      await relay.app.request(`/api/v1/proposals?motebit_id=${a.motebitId}`, {
        headers: AUTH_HEADER,
      });
      expect(rows(relay, "master_token", "/api/v1/proposals")).toHaveLength(1);
    });

    it("GET /api/v1/agents/:id/balance (agent middleware + account dualAuth)", async () => {
      const a = await seedAgent(relay);
      await relay.app.request(`/api/v1/agents/${a.motebitId}/balance`, { headers: AUTH_HEADER });
      expect(rows(relay, "master_token", `/api/v1/agents/${a.motebitId}/balance`)).toHaveLength(1);
    });

    it("a bare /api/v1/proposals with no token is still refused (the single registration covers it)", async () => {
      const res = await relay.app.request("/api/v1/proposals");
      expect(res.status).toBe(401);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/crypto";

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    verifyDeviceSignature: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
  });
}

async function createIdentityAndDevice(
  relay: SyncRelay,
): Promise<{ motebitId: string; deviceId: string }> {
  const keypair = await generateKeypair();
  const pubKeyHex = bytesToHex(keypair.publicKey);

  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const identity = (await identityRes.json()) as { motebit_id: string };

  const deviceRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "Test",
      public_key: pubKeyHex,
    }),
  });
  const device = (await deviceRes.json()) as { device_id: string };

  return { motebitId: identity.motebit_id, deviceId: device.device_id };
}

describe("Proposals — CRUD", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("POST creates a proposal and GET retrieves it", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: participant } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    const planId = crypto.randomUUID();

    const createRes = await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: planId,
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: participant, assigned_steps: [0, 1] }],
        plan_snapshot: { goal: "test" },
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { proposal_id: string; status: string };
    expect(createBody.proposal_id).toBe(proposalId);
    expect(createBody.status).toBe("pending");

    const getRes = await relay.app.request(`/api/v1/proposals/${proposalId}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(200);
    const proposal = (await getRes.json()) as {
      proposal_id: string;
      plan_id: string;
      initiator_motebit_id: string;
      status: string;
      plan_snapshot: unknown;
      participants: Array<{
        motebit_id: string;
        assigned_steps: number[];
        response: string | null;
      }>;
    };
    expect(proposal.proposal_id).toBe(proposalId);
    expect(proposal.plan_id).toBe(planId);
    expect(proposal.initiator_motebit_id).toBe(initiator);
    expect(proposal.status).toBe("pending");
    expect(proposal.plan_snapshot).toEqual({ goal: "test" });
    expect(proposal.participants).toHaveLength(1);
    const p0 = proposal.participants[0]!;
    expect(p0.motebit_id).toBe(participant);
    expect(p0.assigned_steps).toEqual([0, 1]);
    expect(p0.response).toBeNull();
  });

  it("GET returns 404 for nonexistent proposal", async () => {
    const res = await relay.app.request(`/api/v1/proposals/${crypto.randomUUID()}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("POST returns 400 when required fields are missing", async () => {
    const res = await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ proposal_id: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/v1/proposals lists proposals for a motebit", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: participant } = await createIdentityAndDevice(relay);

    // Create two proposals
    for (let i = 0; i < 2; i++) {
      await relay.app.request("/api/v1/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({
          proposal_id: crypto.randomUUID(),
          plan_id: crypto.randomUUID(),
          initiator_motebit_id: initiator,
          participants: [{ motebit_id: participant, assigned_steps: [i] }],
        }),
      });
    }

    const res = await relay.app.request(`/api/v1/proposals?motebit_id=${initiator}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposals: Array<{ proposal_id: string }> };
    expect(body.proposals).toHaveLength(2);
  });
});

describe("Proposals — Respond", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("accept from all participants → proposal accepted", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: p1 } = await createIdentityAndDevice(relay);
    const { motebitId: p2 } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [
          { motebit_id: p1, assigned_steps: [0] },
          { motebit_id: p2, assigned_steps: [1] },
        ],
      }),
    });

    // p1 accepts
    const r1 = await relay.app.request(`/api/v1/proposals/${proposalId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ responder_motebit_id: p1, response: "accept" }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { status: string; all_responded: boolean };
    expect(b1.status).toBe("pending");
    expect(b1.all_responded).toBe(false);

    // p2 accepts
    const r2 = await relay.app.request(`/api/v1/proposals/${proposalId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ responder_motebit_id: p2, response: "accept" }),
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { status: string; all_responded: boolean };
    expect(b2.status).toBe("accepted");
    expect(b2.all_responded).toBe(true);
  });

  it("reject from any participant → proposal rejected", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: p1 } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: p1, assigned_steps: [0] }],
      }),
    });

    const r1 = await relay.app.request(`/api/v1/proposals/${proposalId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ responder_motebit_id: p1, response: "reject" }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { status: string };
    expect(b1.status).toBe("rejected");
  });

  it("counter proposal → proposal countered when all respond", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: p1 } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: p1, assigned_steps: [0] }],
      }),
    });

    const r1 = await relay.app.request(`/api/v1/proposals/${proposalId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        responder_motebit_id: p1,
        response: "counter",
        counter_steps: [{ step: 0, note: "different approach" }],
      }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { status: string };
    expect(b1.status).toBe("countered");
  });

  it("409 on respond to non-pending proposal", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: p1 } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: p1, assigned_steps: [0] }],
      }),
    });

    // Reject first (transitions to rejected)
    await relay.app.request(`/api/v1/proposals/${proposalId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ responder_motebit_id: p1, response: "reject" }),
    });

    // Try to respond again → 409
    const r2 = await relay.app.request(`/api/v1/proposals/${proposalId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ responder_motebit_id: p1, response: "accept" }),
    });
    expect(r2.status).toBe(409);
  });
});

describe("Proposals — Withdraw", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("initiator can withdraw a pending proposal", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: participant } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: participant, assigned_steps: [0] }],
      }),
    });

    const res = await relay.app.request(`/api/v1/proposals/${proposalId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("withdrawn");

    // Verify proposal state
    const getRes = await relay.app.request(`/api/v1/proposals/${proposalId}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const proposal = (await getRes.json()) as { status: string };
    expect(proposal.status).toBe("withdrawn");
  });

  it("409 on withdraw of non-pending proposal", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: p1 } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: p1, assigned_steps: [0] }],
      }),
    });

    // Accept it first
    await relay.app.request(`/api/v1/proposals/${proposalId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ responder_motebit_id: p1, response: "accept" }),
    });

    // Try to withdraw → 409
    const res = await relay.app.request(`/api/v1/proposals/${proposalId}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(409);
  });

  it("404 on withdraw of nonexistent proposal", async () => {
    const res = await relay.app.request(`/api/v1/proposals/${crypto.randomUUID()}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(404);
  });
});

describe("Proposals — Step Results", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  it("participant can post step result", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: participant } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: participant, assigned_steps: [0] }],
      }),
    });

    const res = await relay.app.request(`/api/v1/proposals/${proposalId}/step-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        step_id: "step-0",
        motebit_id: participant,
        status: "completed",
        result_summary: "Step done successfully",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("recorded");
  });

  it("non-participant gets 403 on step result", async () => {
    const { motebitId: initiator } = await createIdentityAndDevice(relay);
    const { motebitId: participant } = await createIdentityAndDevice(relay);
    const { motebitId: outsider } = await createIdentityAndDevice(relay);

    const proposalId = crypto.randomUUID();
    await relay.app.request("/api/v1/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        proposal_id: proposalId,
        plan_id: crypto.randomUUID(),
        initiator_motebit_id: initiator,
        participants: [{ motebit_id: participant, assigned_steps: [0] }],
      }),
    });

    const res = await relay.app.request(`/api/v1/proposals/${proposalId}/step-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        step_id: "step-0",
        motebit_id: outsider,
        status: "completed",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("404 on step result for nonexistent proposal", async () => {
    const res = await relay.app.request(`/api/v1/proposals/${crypto.randomUUID()}/step-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        step_id: "step-0",
        motebit_id: "some-id",
        status: "completed",
      }),
    });
    expect(res.status).toBe(404);
  });
});

/**
 * End-to-end integration test for the collaborative plan proposal lifecycle:
 *   Create proposal → Accept/Reject/Counter/Withdraw → Post step results
 *
 * Tests the full relay proposal API using a real Hono relay (in-memory SQLite).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

describe("Collaborative Plan Proposals E2E", () => {
  let relay: SyncRelay;
  const MASTER_TOKEN = "test-collab-token";
  const MOTEBIT_A = "motebit-alice";
  const MOTEBIT_B = "motebit-bob";

  beforeAll(async () => {
    relay = await createSyncRelay({
      dbPath: ":memory:",
      apiToken: MASTER_TOKEN,
      enableDeviceAuth: false,
    });
  });

  afterAll(() => {
    relay.close();
  });

  function authHeaders() {
    return {
      Authorization: `Bearer ${MASTER_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  async function postJson(path: string, body: unknown) {
    const res = await relay.app.request(path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
  }

  async function getJson(path: string) {
    const res = await relay.app.request(path, {
      method: "GET",
      headers: authHeaders(),
    });
    return { res, json: await res.json() };
  }

  it("full lifecycle: create proposal → accept → post results", async () => {
    const proposalId = "prop-" + crypto.randomUUID();
    const planId = "plan-" + crypto.randomUUID();

    // 1. A creates proposal with 3 steps: 0,2 for A, 1 for B
    const { res: createRes, json: createJson } = await postJson("/api/v1/proposals", {
      proposal_id: proposalId,
      plan_id: planId,
      initiator_motebit_id: MOTEBIT_A,
      participants: [
        { motebit_id: MOTEBIT_A, assigned_steps: [0, 2] },
        { motebit_id: MOTEBIT_B, assigned_steps: [1] },
      ],
      plan_snapshot: { title: "Test collaborative plan" },
    });
    expect(createRes.status).toBe(201);
    expect(createJson.proposal_id).toBe(proposalId);
    expect(createJson.status).toBe("pending");

    // 2. Get proposal state
    const { json: getJson1 } = await getJson(`/api/v1/proposals/${proposalId}`);
    expect(getJson1.status).toBe("pending");
    expect(getJson1.participants).toHaveLength(2);

    // 3. B accepts
    const { json: respondJson } = await postJson(`/api/v1/proposals/${proposalId}/respond`, {
      responder_motebit_id: MOTEBIT_B,
      response: "accept",
    });
    // A hasn't responded yet, so not all responded
    expect(respondJson.status).toBe("pending");

    // 4. A accepts (initiator also needs to accept)
    const { json: respondJson2 } = await postJson(`/api/v1/proposals/${proposalId}/respond`, {
      responder_motebit_id: MOTEBIT_A,
      response: "accept",
    });
    expect(respondJson2.status).toBe("accepted");
    expect(respondJson2.all_responded).toBe(true);

    // 5. Both execute their steps and post results
    const { res: stepRes1 } = await postJson(`/api/v1/proposals/${proposalId}/step-result`, {
      step_id: "step-0",
      motebit_id: MOTEBIT_A,
      status: "completed",
      result_summary: "Step 0 done by A",
    });
    expect(stepRes1.status).toBe(200);

    const { res: stepRes2 } = await postJson(`/api/v1/proposals/${proposalId}/step-result`, {
      step_id: "step-1",
      motebit_id: MOTEBIT_B,
      status: "completed",
      result_summary: "Step 1 done by B",
    });
    expect(stepRes2.status).toBe(200);

    const { res: stepRes3 } = await postJson(`/api/v1/proposals/${proposalId}/step-result`, {
      step_id: "step-2",
      motebit_id: MOTEBIT_A,
      status: "completed",
      result_summary: "Step 2 done by A",
    });
    expect(stepRes3.status).toBe(200);

    // 6. Verify final proposal state
    const { json: finalState } = await getJson(`/api/v1/proposals/${proposalId}`);
    expect(finalState.status).toBe("accepted");
    expect(finalState.participants[0].response).toBe("accept");
    expect(finalState.participants[1].response).toBe("accept");
  });

  it("counter-proposal flow", async () => {
    const proposalId = "prop-counter-" + crypto.randomUUID();
    const planId = "plan-counter-" + crypto.randomUUID();

    await postJson("/api/v1/proposals", {
      proposal_id: proposalId,
      plan_id: planId,
      initiator_motebit_id: MOTEBIT_A,
      participants: [
        { motebit_id: MOTEBIT_A, assigned_steps: [0] },
        { motebit_id: MOTEBIT_B, assigned_steps: [1] },
      ],
    });

    // B counters
    const { json: counterJson } = await postJson(`/api/v1/proposals/${proposalId}/respond`, {
      responder_motebit_id: MOTEBIT_B,
      response: "counter",
      counter_steps: [
        { ordinal: 1, description: "Modified step", reason: "Need different approach" },
      ],
    });

    // Not all responded yet (A hasn't)
    expect(counterJson.status).toBe("pending");

    // A accepts
    const { json: acceptJson } = await postJson(`/api/v1/proposals/${proposalId}/respond`, {
      responder_motebit_id: MOTEBIT_A,
      response: "accept",
    });
    // B countered + A accepted = countered (not all accepted)
    expect(acceptJson.status).toBe("countered");

    const { json: state } = await getJson(`/api/v1/proposals/${proposalId}`);
    expect(state.status).toBe("countered");
    expect(
      state.participants.find((p: { motebit_id: string }) => p.motebit_id === MOTEBIT_B)
        .counter_steps,
    ).toHaveLength(1);
  });

  it("rejection flow", async () => {
    const proposalId = "prop-reject-" + crypto.randomUUID();
    const planId = "plan-reject-" + crypto.randomUUID();

    await postJson("/api/v1/proposals", {
      proposal_id: proposalId,
      plan_id: planId,
      initiator_motebit_id: MOTEBIT_A,
      participants: [{ motebit_id: MOTEBIT_B, assigned_steps: [0] }],
    });

    const { json: rejectJson } = await postJson(`/api/v1/proposals/${proposalId}/respond`, {
      responder_motebit_id: MOTEBIT_B,
      response: "reject",
    });
    expect(rejectJson.status).toBe("rejected");

    const { json: state } = await getJson(`/api/v1/proposals/${proposalId}`);
    expect(state.status).toBe("rejected");
  });

  it("withdrawal flow", async () => {
    const proposalId = "prop-withdraw-" + crypto.randomUUID();
    const planId = "plan-withdraw-" + crypto.randomUUID();

    await postJson("/api/v1/proposals", {
      proposal_id: proposalId,
      plan_id: planId,
      initiator_motebit_id: MOTEBIT_A,
      participants: [{ motebit_id: MOTEBIT_B, assigned_steps: [0] }],
    });

    const { res: withdrawRes, json: withdrawJson } = await postJson(
      `/api/v1/proposals/${proposalId}/withdraw`,
      {},
    );
    expect(withdrawRes.status).toBe(200);
    expect(withdrawJson.status).toBe("withdrawn");

    // Cannot respond to withdrawn proposal
    const { res: respondRes } = await postJson(`/api/v1/proposals/${proposalId}/respond`, {
      responder_motebit_id: MOTEBIT_B,
      response: "accept",
    });
    expect(respondRes.status).toBe(409);
  });

  it("list proposals with filters", async () => {
    const proposalId = "prop-list-" + crypto.randomUUID();

    await postJson("/api/v1/proposals", {
      proposal_id: proposalId,
      plan_id: "plan-list",
      initiator_motebit_id: MOTEBIT_A,
      participants: [{ motebit_id: MOTEBIT_B, assigned_steps: [0] }],
    });

    // List all for motebit A
    const { json: listA } = await getJson(`/api/v1/proposals?motebit_id=${MOTEBIT_A}`);
    expect(listA.proposals.length).toBeGreaterThanOrEqual(1);
    expect(listA.proposals.some((p: { proposal_id: string }) => p.proposal_id === proposalId)).toBe(
      true,
    );

    // List pending (scoped to initiator)
    const { json: listPending } = await getJson(
      `/api/v1/proposals?motebit_id=${MOTEBIT_A}&status=pending`,
    );
    expect(listPending.proposals.length).toBeGreaterThanOrEqual(1);
  });

  it("proposal expiry", async () => {
    const proposalId = "prop-expire-" + crypto.randomUUID();

    // Create with very short TTL
    await postJson("/api/v1/proposals", {
      proposal_id: proposalId,
      plan_id: "plan-expire",
      initiator_motebit_id: MOTEBIT_A,
      participants: [{ motebit_id: MOTEBIT_B, assigned_steps: [0] }],
      expires_in_ms: 1, // expires immediately
    });

    // Manually trigger expiry by setting expires_at in the past
    // (since the cleanup interval runs on 60s, we simulate it)
    // The proposal was created with expires_in_ms: 1, so it's already past
    // Wait a tiny bit to ensure expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Manually run the expiry logic (since we can't wait for the 60s interval in tests)
    // We can verify by trying to respond — if the cleanup hasn't run yet, we test the
    // created state with the expired TTL
    const { json: state } = await getJson(`/api/v1/proposals/${proposalId}`);
    // The proposal was created with a 1ms TTL, so expires_at is in the past
    expect(state.expires_at).toBeLessThanOrEqual(Date.now());
  });
});

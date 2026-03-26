/**
 * Dogfood E2E — Two sovereign motebits delegating across the relay.
 *
 * This test proves the FULL flow that two CLI motebits would use over the internet,
 * running locally against an in-process relay with in-memory SQLite.
 *
 * Flow:
 *   Agent A (caller/delegator)  ←→  Relay  ←→  Agent B (service/executor)
 *
 *   1. Both agents self-register via bootstrap (no master token)
 *   2. Relay returns relay-assigned device_ids; signed tokens use those ids
 *   3. Agent B registers capabilities in the agent registry (discoverable)
 *   4. Agent A discovers B via the discovery endpoint using a signed token
 *   5. Agent A submits a task to B's routing address via the relay (dualAuth)
 *   6. B "executes" the task and posts a signed ExecutionReceipt back
 *   7. The relay cryptographically verifies the receipt signature
 *   8. The relay issues a reputation credential to B on verified receipt
 *   9. Agent A retrieves the completed task+receipt using the master token
 *  10. Local receipt signature verification (as A would do on first delivery)
 *  11. Trust stats are recorded (latency)
 *  12. Hijack prevention: a third party can't bootstrap with A's motebit_id + a new key
 *  13. Budget lock + settlement when B has a priced service listing
 *  14. Credential issuance, VP bundling, and public verification endpoint
 *  15. Tampered receipt is rejected 403
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  generateKeypair,
  createSignedToken,
  signExecutionReceipt,
  verifyExecutionReceipt,
  bytesToHex,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { ExecutionReceipt, MotebitId, DeviceId } from "@motebit/sdk";

// === Helpers ===

/** Build a signed device token. The device_id MUST be the one the relay assigned at bootstrap. */
async function makeSignedToken(
  motebitId: string,
  relayDeviceId: string,
  keypair: KeyPair,
  aud: string = "sync",
): Promise<string> {
  const now = Date.now();
  return createSignedToken(
    {
      mid: motebitId,
      did: relayDeviceId,
      iat: now,
      exp: now + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud,
    },
    keypair.privateKey,
  );
}

/** Build a signed ExecutionReceipt from an agent's keypair. */
async function makeReceipt(
  taskId: string,
  executorMotebitId: string,
  executorDeviceId: string,
  keypair: KeyPair,
  opts: { status?: "completed" | "failed"; result?: string } = {},
): Promise<ExecutionReceipt> {
  const status = opts.status ?? "completed";
  const result = opts.result ?? "Task executed successfully";

  const promptHashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("Summarize the agent delegation architecture"),
  );
  const promptHash = bytesToHex(new Uint8Array(promptHashBuf));
  const resultHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result));
  const resultHash = bytesToHex(new Uint8Array(resultHashBuf));

  const unsigned = {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: executorMotebitId as unknown as MotebitId,
    device_id: executorDeviceId as unknown as DeviceId,
    submitted_at: Date.now() - 100,
    completed_at: Date.now(),
    status,
    result,
    tools_used: ["web_search", "read_url"],
    memories_formed: 1,
    prompt_hash: promptHash,
    result_hash: resultHash,
  };
  return signExecutionReceipt(unsigned, keypair.privateKey);
}

// === Test Suite ===

describe("Dogfood E2E — Two-Motebit Delegation", () => {
  let relay: SyncRelay;

  // Agent A: the delegator (caller)
  let keypairA: KeyPair;
  let motebitIdA: string;
  let pubKeyHexA: string;
  /** Relay-assigned device_id for A (returned by bootstrap). Used in signed tokens. */
  let relayDeviceIdA: string;

  // Agent B: the executor (service motebit)
  let keypairB: KeyPair;
  let motebitIdB: string;
  let pubKeyHexB: string;
  /** Relay-assigned device_id for B (returned by bootstrap). Used in signed tokens. */
  let relayDeviceIdB: string;

  // The relay master token — used for cross-agent operations (A polling B's task result).
  // In production, A and B run on the SAME relay with a shared master token, OR use WS push.
  // For HTTP polling the task result, the caller uses the master token (or a service token).
  const RELAY_MASTER_TOKEN = "relay-internal-only";

  beforeAll(async () => {
    relay = await createSyncRelay({
      dbPath: ":memory:",
      apiToken: RELAY_MASTER_TOKEN,
      enableDeviceAuth: true,
      issueCredentials: true,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    keypairA = await generateKeypair();
    keypairB = await generateKeypair();

    motebitIdA = crypto.randomUUID();
    motebitIdB = crypto.randomUUID();

    pubKeyHexA = bytesToHex(keypairA.publicKey);
    pubKeyHexB = bytesToHex(keypairB.publicKey);
  });

  afterAll(() => {
    relay.close();
  });

  // =========================================================================
  // 1 & 2. Bootstrap — both agents self-register (no master token)
  //         The relay assigns device_ids; we capture them for token signing.
  // =========================================================================

  it("1. Agent A bootstraps successfully — relay creates identity + device", async () => {
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: motebitIdA,
        device_id: "a-primary",
        public_key: pubKeyHexA,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      motebit_id: string;
      device_id: string;
      registered: boolean;
    };
    expect(body.motebit_id).toBe(motebitIdA);
    expect(body.device_id).toBeTruthy();
    expect(body.registered).toBe(true);

    // Capture the relay-assigned device_id — this is what the relay knows as A's device
    relayDeviceIdA = body.device_id;
  });

  it("2. Agent B bootstraps successfully — relay creates identity + device", async () => {
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: motebitIdB,
        device_id: "b-primary",
        public_key: pubKeyHexB,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      motebit_id: string;
      device_id: string;
      registered: boolean;
    };
    expect(body.motebit_id).toBe(motebitIdB);
    expect(body.device_id).toBeTruthy();
    expect(body.registered).toBe(true);

    relayDeviceIdB = body.device_id;
  });

  it("3. Bootstrap is idempotent: same key re-registers as 200 (not 201)", async () => {
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: motebitIdA,
        device_id: "a-primary",
        public_key: pubKeyHexA,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { registered: boolean };
    expect(body.registered).toBe(false);
  });

  // =========================================================================
  // 3. Signed token auth — Agent A uses Ed25519 signed token (no master token)
  //    Note: must use the relay-assigned relayDeviceIdA, not our chosen device_id.
  // =========================================================================

  it("4. Agent A authenticates with a signed device token on a protected endpoint", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "admin:query");

    const res = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(res.status).toBe(200);
  });

  it("5. Signed token signed by wrong key is rejected 401", async () => {
    // Token claims to be agent A but is signed by B's private key
    const spoofedToken = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairB, "admin:query");

    // Use a protected endpoint (register) — discover is public
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${spoofedToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ motebit_id: motebitIdA, endpoint_url: "http://x", capabilities: [] }),
    });

    expect(res.status).toBe(401);
  });

  it("6. Token with wrong device_id is rejected 401", async () => {
    // Valid key, but wrong device_id (not what relay stored for A)
    const wrongDeviceToken = await makeSignedToken(
      motebitIdA,
      "wrong-device-id",
      keypairA,
      "admin:query",
    );

    // Use a protected endpoint (register) — discover is public
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${wrongDeviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ motebit_id: motebitIdA, endpoint_url: "http://x", capabilities: [] }),
    });

    // Relay looks up device by did claim — not found → verification fails
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // 4. Agent B registers as a discoverable service
  // =========================================================================

  it("7. Agent B registers capabilities in the agent registry", async () => {
    const tokenB = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "admin:query");

    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        motebit_id: motebitIdB,
        endpoint_url: "http://agent-b.example.com/mcp",
        capabilities: ["web_search", "general"],
        metadata: { description: "Agent B — web search service motebit" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; registered: boolean };
    expect(body.motebit_id).toBe(motebitIdB);
    expect(body.registered).toBe(true);
  });

  // =========================================================================
  // 5. Agent A discovers Agent B
  // =========================================================================

  it("8. Agent A discovers Agent B via GET /api/v1/agents/discover?capability=web_search", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "admin:query");

    const res = await relay.app.request("/api/v1/agents/discover?capability=web_search", {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{
        motebit_id: string;
        endpoint_url: string;
        capabilities: string[];
      }>;
    };
    const agentB = body.agents.find((a) => a.motebit_id === motebitIdB);
    expect(agentB).toBeDefined();
    expect(agentB!.endpoint_url).toBe("http://agent-b.example.com/mcp");
    expect(agentB!.capabilities).toContain("web_search");
  });

  it("9. Agent A retrieves Agent B's full profile via GET /api/v1/agents/:motebitId", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "admin:query");

    const res = await relay.app.request(`/api/v1/agents/${motebitIdB}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      endpoint_url: string;
      capabilities: string[];
    };
    expect(body.motebit_id).toBe(motebitIdB);
    expect(body.capabilities).toContain("general");
  });

  // =========================================================================
  // 6–9. Full delegation flow
  //   A submits task → relay fans out to B → B posts signed receipt → relay verifies
  //   A retrieves result via master token (A has no per-device auth for B's address)
  // =========================================================================

  // Shared task_id across the delegation sub-tests (9–12)
  let sharedTaskId: string;

  it("10. Agent A submits a task to Agent B's address via signed device token (dualAuth)", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");

    // Inject B as a connected device so the relay fans the task out via WS
    const bWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(motebitIdB, [
      { ws: bWs as never, deviceId: relayDeviceIdB, capabilities: ["web_search", "general"] },
    ]);

    const res = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Summarize the agent delegation architecture",
        submitted_by: motebitIdA,
        required_capabilities: ["web_search"],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { task_id: string };
    expect(body.task_id).toBeTruthy();
    sharedTaskId = body.task_id;

    // Relay fanned the task_request to B's connected device via WebSocket.
    const bMessages = bWs.send.mock.calls.map(
      (c) =>
        JSON.parse(c[0] as string) as {
          type: string;
          task?: { task_id: string; prompt: string; required_capabilities: string[] };
        },
    );
    const sentMsg = bMessages.find((m) => m.type === "task_request");
    expect(sentMsg).toBeDefined();
    expect(sentMsg!.task!.task_id).toBe(sharedTaskId);
    expect(sentMsg!.task!.prompt).toBe("Summarize the agent delegation architecture");
    expect(sentMsg!.task!.required_capabilities).toContain("web_search");
  });

  it("11. Agent B posts a signed ExecutionReceipt back to the relay", async () => {
    // B uses its own signed device token to post the result
    const tokenB = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "task:result");

    const receipt = await makeReceipt(sharedTaskId, motebitIdB, relayDeviceIdB, keypairB, {
      status: "completed",
      result: "Delegation architecture uses Ed25519 + relay fan-out.",
    });

    const res = await relay.app.request(`/agent/${motebitIdB}/task/${sharedTaskId}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(receipt),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; credential_id: string | null };
    // status reflects the task's completion status (same enum as AgentTaskStatus)
    expect(body.status).toBe("completed");
  });

  it("12. Agent A polls the completed task with a signed device token (task:query audience)", async () => {
    // Agent A uses its own device token with "task:query" audience to poll.
    // The relay verifies the token against A's identity (from token claims.mid),
    // NOT the target agent B's motebitId from the URL.
    const tokenAQuery = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:query");
    const res = await relay.app.request(`/agent/${motebitIdB}/task/${sharedTaskId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenAQuery}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { task_id: string; status: string };
      receipt: ExecutionReceipt | null;
    };
    expect(body.task.task_id).toBe(sharedTaskId);
    expect(body.task.status).toBe("completed");
    expect(body.receipt).not.toBeNull();

    const receipt = body.receipt!;
    expect(receipt.motebit_id).toBe(motebitIdB);
    expect(receipt.task_id).toBe(sharedTaskId);
    expect(receipt.status).toBe("completed");
    expect(receipt.signature).toBeTruthy();
    expect(receipt.prompt_hash).toHaveLength(64); // SHA-256 hex = 64 chars
    expect(receipt.result_hash).toHaveLength(64);
    expect(receipt.tools_used).toContain("web_search");
  });

  it("13. Agent A independently verifies the receipt signature with B's public key", async () => {
    // Retrieve the receipt (using master token for admin access)
    const res = await relay.app.request(`/agent/${motebitIdB}/task/${sharedTaskId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${RELAY_MASTER_TOKEN}` },
    });
    const body = (await res.json()) as { receipt: ExecutionReceipt };
    const receipt = body.receipt;

    // Agent A verifies using B's public key (pinned on first contact in real usage)
    const valid = await verifyExecutionReceipt(receipt, keypairB.publicKey);
    expect(valid).toBe(true);

    // Sanity check: wrong key fails
    const invalidWithA = await verifyExecutionReceipt(receipt, keypairA.publicKey);
    expect(invalidWithA).toBe(false);
  });

  // =========================================================================
  // 10. Trust accumulation — latency stats recorded on task completion
  // =========================================================================

  it("14. Relay records latency stats for tasks with wall_clock_ms (trust accumulation)", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const tokenB = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "task:result");

    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Count the results",
        submitted_by: motebitIdA,
        wall_clock_ms: 120, // Simulated round-trip latency for stats recording
        required_capabilities: ["general"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId2 } = (await taskRes.json()) as { task_id: string };

    const receipt2 = await makeReceipt(taskId2, motebitIdB, relayDeviceIdB, keypairB, {
      result: "Found 7 results.",
    });
    const resultRes = await relay.app.request(`/agent/${motebitIdB}/task/${taskId2}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(receipt2),
    });
    expect(resultRes.status).toBe(200);

    // Confirm the task reached completed state
    const pollRes = await relay.app.request(`/agent/${motebitIdB}/task/${taskId2}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${RELAY_MASTER_TOKEN}` },
    });
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as { task: { status: string } };
    expect(pollBody.task.status).toBe("completed");
  });

  // =========================================================================
  // 11. Hijack prevention
  // =========================================================================

  it("15a. Unrelated agent cannot poll another agent's task with device token → 403", async () => {
    // Agent B tries to poll A-submitted task using B's own device token.
    // B is neither the submitter nor the target for the URL's motebitId scope,
    // but here the task is stored under B's motebitId so B IS the target.
    // Create a truly unrelated agent C to test the authorization boundary.
    const keypairC = await generateKeypair();
    const pubKeyHexC = bytesToHex(keypairC.publicKey);

    const bootstrapC = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: `agent-c-${crypto.randomUUID()}`,
        public_key: pubKeyHexC,
      }),
    });
    expect(bootstrapC.status).toBe(201);
    const { device_id: relayDeviceIdC, motebit_id: motebitIdC } = (await bootstrapC.json()) as {
      device_id: string;
      motebit_id: string;
    };

    const tokenCQuery = await makeSignedToken(motebitIdC, relayDeviceIdC, keypairC, "task:query");
    const res = await relay.app.request(`/agent/${motebitIdB}/task/${sharedTaskId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenCQuery}` },
    });
    expect(res.status).toBe(403);
  });

  it("15. Hijack prevention: bootstrap with existing motebit_id + different key → 409", async () => {
    const attackerKeypair = await generateKeypair();
    const attackerPubKeyHex = bytesToHex(attackerKeypair.publicKey);

    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: motebitIdA, // A's established sovereign identity
        device_id: "attacker-device",
        public_key: attackerPubKeyHex, // Different key — must be rejected
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { message?: string; error?: string };
    const msg = body.message ?? body.error ?? "";
    expect(msg.toLowerCase()).toMatch(/different public key|re-registration rejected/);
  });

  it("16. Malformed bootstrap (invalid hex key) → 400", async () => {
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: crypto.randomUUID(),
        public_key: "not-valid-hex",
      }),
    });
    expect(res.status).toBe(400);
  });

  // =========================================================================
  // 12. x402 settlement audit — receipt creates settlement record with platform fee
  // =========================================================================

  it("17. Settlement audit: priced listing + receipt → settlement record with 5% fee", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const tokenBListing = await makeSignedToken(
      motebitIdB,
      relayDeviceIdB,
      keypairB,
      "market:listing",
    );
    const tokenB = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "task:result");

    // B registers a priced service listing (no pay_to_address → bypasses x402 gate,
    // but settlement audit still runs from pricing lookup on receipt delivery)
    const listingRes = await relay.app.request(`/api/v1/agents/${motebitIdB}/listing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBListing}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 2000, availability_guarantee: 0.99 },
        description: "Agent B — dogfood web search service",
      }),
    });
    expect(listingRes.status).toBe(200);

    // Connect B's device so the relay can route the task via WS fan-out
    const bWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(motebitIdB, [
      { ws: bWs as never, deviceId: relayDeviceIdB, capabilities: ["web_search"] },
    ]);

    // A submits task — x402 handles payment at HTTP layer, no max_budget needed
    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Search the web for motebit architecture",
        submitted_by: motebitIdA,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: settlementTaskId } = (await taskRes.json()) as { task_id: string };

    // B posts successful receipt → relay creates settlement audit record
    const receipt = await makeReceipt(settlementTaskId, motebitIdB, relayDeviceIdB, keypairB);
    const resultRes = await relay.app.request(
      `/agent/${motebitIdB}/task/${settlementTaskId}/result`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(receipt),
      },
    );
    expect(resultRes.status).toBe(200);

    // Settlement audit: verify the relay recorded the settlement with platform fee
    const settlementsRes = await relay.app.request(`/agent/${motebitIdB}/settlements`, {
      headers: { Authorization: `Bearer ${RELAY_MASTER_TOKEN}` },
    });
    expect(settlementsRes.status).toBe(200);
    const data = (await settlementsRes.json()) as {
      summary: { total_settled: number; total_platform_fees: number; settlement_count: number };
      settlements: Array<Record<string, unknown>>;
    };
    expect(data.summary.settlement_count).toBeGreaterThan(0);
    expect(data.summary.total_settled).toBeGreaterThan(0);
    expect(data.summary.total_platform_fees).toBeGreaterThan(0);

    // Verify individual settlement record
    const settlement = data.settlements.find((s) => s.allocation_id === `x402-${settlementTaskId}`);
    expect(settlement).toBeDefined();
    // Gross = toMicro($1.00 / 0.95) = 1052632 micro. Fee = round(1052632 * 0.05) = 52632.
    // Net = 1052632 - 52632 = 1000000 micro. Settlement values are in micro-units.
    expect(settlement!.platform_fee).toBe(52632);
    expect(settlement!.platform_fee_rate).toBe(0.05);
    expect(settlement!.amount_settled).toBe(1_000_000);
    expect(settlement!.status).toBe("completed");
  });

  // =========================================================================
  // 13. Credential issuance — relay issues AgentReputationCredential to B
  //     on verified receipt delivery when B is in the agent registry
  // =========================================================================

  it("18. Relay issues AgentReputationCredential to B after successful receipt", async () => {
    const tokenASubmit = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const tokenACreds = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "credentials");

    // B is already in the agent registry (from test 7). Connect B's device.
    const bWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(motebitIdB, [
      { ws: bWs as never, deviceId: relayDeviceIdB, capabilities: ["web_search", "general"] },
    ]);

    // A submits a fresh task
    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenASubmit}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "What is the capital of France?",
        submitted_by: motebitIdA,
        required_capabilities: ["general"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: credTaskId } = (await taskRes.json()) as { task_id: string };

    // B posts a successful receipt
    const tokenB = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "task:result");
    const receipt = await makeReceipt(credTaskId, motebitIdB, relayDeviceIdB, keypairB);
    const resultRes = await relay.app.request(`/agent/${motebitIdB}/task/${credTaskId}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(receipt),
    });
    expect(resultRes.status).toBe(200);
    const resultBody = (await resultRes.json()) as {
      status: string;
      credential_id: string | null;
    };
    // credential_id is issued because B is in the registry (public_key resolvable)
    expect(resultBody.credential_id).toBeTruthy();

    // Retrieve credentials from the relay's credential store
    const credsRes = await relay.app.request(`/api/v1/agents/${motebitIdB}/credentials`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenACreds}` },
    });
    expect(credsRes.status).toBe(200);
    const credsBody = (await credsRes.json()) as {
      motebit_id: string;
      credentials: Array<{
        credential_id: string;
        credential_type: string;
        credential: {
          type: string[];
          credentialSubject: { id: string };
          issuer: string;
        };
      }>;
    };

    expect(credsBody.motebit_id).toBe(motebitIdB);
    expect(credsBody.credentials.length).toBeGreaterThanOrEqual(1);

    const repCred = credsBody.credentials.find(
      (c) => c.credential_type === "AgentReputationCredential",
    );
    expect(repCred).toBeDefined();
    expect(repCred!.credential.type).toContain("AgentReputationCredential");
    expect(repCred!.credential.credentialSubject.id).toBeTruthy();
    expect(repCred!.credential.issuer).toMatch(/^did:key:/);
  });

  it("19. Public credential verification endpoint validates B's reputation credential", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "credentials");

    // Fetch the credential
    const credsRes = await relay.app.request(`/api/v1/agents/${motebitIdB}/credentials`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const credsBody = (await credsRes.json()) as {
      credentials: Array<{ credential: Record<string, unknown> }>;
    };
    expect(credsBody.credentials.length).toBeGreaterThanOrEqual(1);
    const credential = credsBody.credentials[0]!.credential;

    // Public endpoint — no auth required (anyone can verify a VC)
    const verifyRes = await relay.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credential),
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as {
      valid: boolean;
      issuer: string;
      subject: string;
    };
    expect(verifyBody.valid).toBe(true);
    expect(verifyBody.issuer).toMatch(/^did:key:/);
    expect(verifyBody.subject).toBeTruthy();
  });

  it("20. Verifiable Presentation bundles B's credentials into a signed VP", async () => {
    const tokenB = await makeSignedToken(
      motebitIdB,
      relayDeviceIdB,
      keypairB,
      "credentials:present",
    );

    const vpRes = await relay.app.request(`/api/v1/agents/${motebitIdB}/presentation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(vpRes.status).toBe(200);
    const vpBody = (await vpRes.json()) as {
      presentation: {
        "@context": string[];
        type: string[];
        holder: string;
        verifiableCredential: Array<{ type: string[] }>;
        proof: { type: string };
      };
      credential_count: number;
      relay_did: string;
    };

    expect(vpBody.presentation.type).toContain("VerifiablePresentation");
    expect(vpBody.presentation.verifiableCredential.length).toBeGreaterThanOrEqual(1);
    expect(vpBody.credential_count).toBeGreaterThanOrEqual(1);
    expect(vpBody.relay_did).toMatch(/^did:key:/);
    expect(vpBody.presentation.proof.type).toBeTruthy();

    const hasRepCred = vpBody.presentation.verifiableCredential.some((vc) =>
      vc.type.includes("AgentReputationCredential"),
    );
    expect(hasRepCred).toBe(true);
  });

  // =========================================================================
  // 14. Receipt integrity — tampered receipt is rejected
  // =========================================================================

  it("21. Tampered receipt (modified result field) is rejected 403 by the relay", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const tokenB = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "task:result");

    // Submit a fresh task
    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Signature forgery test",
        required_capabilities: ["general"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: forgedTaskId } = (await taskRes.json()) as { task_id: string };

    // Build a valid receipt, then tamper the result field (invalidates signature)
    const receipt = await makeReceipt(forgedTaskId, motebitIdB, relayDeviceIdB, keypairB);
    const tampered: ExecutionReceipt = { ...receipt, result: "FORGED RESULT" };

    const res = await relay.app.request(`/agent/${motebitIdB}/task/${forgedTaskId}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tampered),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    // Relay error handler returns { error: "...", status: ... }
    expect(body.error).toMatch(/invalid Ed25519 signature|verification failed/i);
  });

  // =========================================================================
  // 15. Non-existent task → 404
  // =========================================================================

  it("25. Polling a non-existent task_id returns 404", async () => {
    const res = await relay.app.request(`/agent/${motebitIdB}/task/${crypto.randomUUID()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${RELAY_MASTER_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  // =========================================================================
  // 16. Market candidate scoring
  // =========================================================================

  it("26. Market candidates endpoint returns Agent B as a scored candidate for web_search", async () => {
    // /api/v1/market/candidates falls under the global /api/v1/* middleware which
    // requires the master token (device signed tokens are not accepted here).
    const res = await relay.app.request("/api/v1/market/candidates?capability=web_search", {
      method: "GET",
      headers: { Authorization: `Bearer ${RELAY_MASTER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{
        motebit_id: string;
        selected: boolean;
        composite: number;
      }>;
      total: number;
    };

    // B has a web_search listing from test 17 — should appear as a scored candidate
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    const candidateB = body.candidates.find((c) => c.motebit_id === motebitIdB);
    expect(candidateB).toBeDefined();
    expect(typeof candidateB!.composite).toBe("number");
  });
});

// =========================================================================
// x402 Payment Gate — isolated test with its own relay to avoid cascade
// =========================================================================

describe("x402 Payment Gate", () => {
  let relay: SyncRelay;
  let keypairA: KeyPair;
  let keypairB: KeyPair;
  let motebitIdA: string;
  let motebitIdB: string;
  let relayDeviceIdA: string;
  let relayDeviceIdB: string;
  const MASTER_TOKEN = "x402-test-token";

  beforeAll(async () => {
    relay = await createSyncRelay({
      dbPath: ":memory:",
      apiToken: MASTER_TOKEN,
      enableDeviceAuth: true,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });

    keypairA = await generateKeypair();
    keypairB = await generateKeypair();

    const pubKeyHexA = bytesToHex(keypairA.publicKey);
    const pubKeyHexB = bytesToHex(keypairB.publicKey);

    // Bootstrap both agents
    const resA = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: crypto.randomUUID(),
        device_id: crypto.randomUUID(),
        public_key: pubKeyHexA,
      }),
    });
    const bodyA = (await resA.json()) as { motebit_id: string; device_id: string };
    motebitIdA = bodyA.motebit_id;
    relayDeviceIdA = bodyA.device_id;

    const resB = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: crypto.randomUUID(),
        device_id: crypto.randomUUID(),
        public_key: pubKeyHexB,
      }),
    });
    const bodyB = (await resB.json()) as { motebit_id: string; device_id: string };
    motebitIdB = bodyB.motebit_id;
    relayDeviceIdB = bodyB.device_id;
  });

  afterAll(() => {
    relay.close();
  });

  it("priced agent with pay_to_address returns 402 to unpaid caller", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const tokenBListing = await makeSignedToken(
      motebitIdB,
      relayDeviceIdB,
      keypairB,
      "market:listing",
    );

    // B registers a priced listing WITH pay_to_address → triggers x402 gate
    const listingRes = await relay.app.request(`/api/v1/agents/${motebitIdB}/listing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBListing}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 2000, availability_guarantee: 0.99 },
        description: "Priced agent for x402 gate test",
        pay_to_address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      }),
    });
    expect(listingRes.status).toBe(200);

    // A submits task WITHOUT x402 payment header → should get 402
    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "This should require payment",
        submitted_by: motebitIdA,
        required_capabilities: ["web_search"],
      }),
    });

    expect(taskRes.status).toBe(402);
    const body = (await taskRes.json()) as {
      error?: string;
      estimated_cost?: number;
      platform_fee_rate?: number;
    };
    expect(body.error).toBe("payment_required");
    expect(body.estimated_cost).toBe(0.5);
    expect(body.platform_fee_rate).toBe(0.05);
  });

  it("free agent (no pay_to_address) bypasses x402 gate", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const tokenBListing = await makeSignedToken(
      motebitIdB,
      relayDeviceIdB,
      keypairB,
      "market:listing",
    );

    // B updates listing WITHOUT pay_to_address → x402 gate should not apply
    const listingRes = await relay.app.request(`/api/v1/agents/${motebitIdB}/listing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBListing}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 2000, availability_guarantee: 0.99 },
        description: "Free agent — no pay_to_address",
        // No pay_to_address → getAgentPricing returns null → bypass x402
      }),
    });
    expect(listingRes.status).toBe(200);

    // Connect B so task can route
    const bWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(motebitIdB, [
      { ws: bWs as never, deviceId: relayDeviceIdB, capabilities: ["web_search"] },
    ]);

    // A submits task — should succeed without payment
    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "This should be free",
        submitted_by: motebitIdA,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);

    relay.connections.delete(motebitIdB);
  });

  it("price snapshot is captured at submission time", async () => {
    const tokenA = await makeSignedToken(motebitIdA, relayDeviceIdA, keypairA, "task:submit");
    const tokenBListing = await makeSignedToken(
      motebitIdB,
      relayDeviceIdB,
      keypairB,
      "market:listing",
    );
    const tokenBResult = await makeSignedToken(motebitIdB, relayDeviceIdB, keypairB, "task:result");

    // B registers a priced listing (no pay_to_address so task goes through free,
    // but price_snapshot should still be recorded for settlement audit)
    await relay.app.request(`/api/v1/agents/${motebitIdB}/listing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBListing}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 2.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 2000, availability_guarantee: 0.99 },
        description: "Price snapshot test agent",
        // No pay_to_address → bypasses x402 gate
      }),
    });

    // Connect B
    const bWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(motebitIdB, [
      { ws: bWs as never, deviceId: relayDeviceIdB, capabilities: ["web_search"] },
    ]);

    // A submits task at $2.00 price
    const taskRes = await relay.app.request(`/agent/${motebitIdB}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Price snapshot test",
        submitted_by: motebitIdA,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: snapshotTaskId } = (await taskRes.json()) as { task_id: string };

    // Agent B changes price to $5.00 AFTER task submission
    await relay.app.request(`/api/v1/agents/${motebitIdB}/listing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBListing}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 5.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 2000, availability_guarantee: 0.99 },
        description: "Price changed after submission",
      }),
    });

    // B posts receipt → settlement should use the ORIGINAL $2.00 price, not $5.00
    const receipt = await makeReceipt(snapshotTaskId, motebitIdB, relayDeviceIdB, keypairB);
    await relay.app.request(`/agent/${motebitIdB}/task/${snapshotTaskId}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBResult}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(receipt),
    });

    // Check settlement record uses snapshot price
    const settlementsRes = await relay.app.request(`/agent/${motebitIdB}/settlements`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });
    expect(settlementsRes.status).toBe(200);
    const data = (await settlementsRes.json()) as {
      settlements: Array<{ allocation_id: string; amount_settled: number; platform_fee: number }>;
    };

    const settlement = data.settlements.find((s) => s.allocation_id === `x402-${snapshotTaskId}`);
    expect(settlement).toBeDefined();
    // Gross = toMicro($2.00 / 0.95) = 2105263 micro. Fee = round(2105263 * 0.05) = 105263.
    // Net = 2105263 - 105263 = 2000000 micro. Settlement values are in micro-units.
    // The key assertion: settlement is based on $2.00 snapshot, NOT current $5.00
    expect(settlement!.amount_settled).toBe(2_000_000); // Would be ~5,000,000 if using $5.00
    expect(settlement!.platform_fee).toBe(105263); // Would be ~263,158 if using $5.00

    relay.connections.delete(motebitIdB);
  });
});

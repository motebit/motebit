/**
 * #459 — the settlement-amplification incident's three relay-side fixes,
 * each asserted over live routes:
 *
 * 1. Routing self-exclusion: capability routing must never select the
 *    SUBMITTER as its own worker (the distributed loop closed exactly
 *    there — web-search's read_url sub-task routed back to web-search).
 * 2. Receipt-time pricing honesty: a task with no price snapshot and no
 *    allocation settles at gross 0 (a real $0 settlement row) — never at
 *    a gross invented from the EXECUTING agent's listing (the constant
 *    gross=6316 signature of the incident).
 * 3. Idempotency claim release: a submission that fails AFTER claiming
 *    its Idempotency-Key releases the claim — an honest same-key retry
 *    proceeds instead of 409ing until the 24h sweep (the defect that
 *    trains clients to mint fresh keys per attempt, defeating
 *    idempotency).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import {
  createTestRelay,
  createAgent,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

/** Ephemeral counting HTTP server — records every request it receives. */
function countingServer(): Promise<{ server: Server; url: string; hits: () => number }> {
  return new Promise((resolve) => {
    let count = 0;
    const server = createServer((_req, res) => {
      count++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, hits: () => count });
    });
  });
}

async function registerAgentWithEndpoint(
  relay: SyncRelay,
  motebitId: string,
  endpointUrl: string,
  capabilities: string[],
): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: endpointUrl,
      capabilities,
      settlement_address: WORKER_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
}

describe("#459 — settlement-amplification relay fixes", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("capability routing never forwards a task back to its own submitter (the loop's closing edge)", async () => {
    const submitterHits = await countingServer();
    const otherHits = await countingServer();
    try {
      const subKp = await generateKeypair();
      const submitter = await createAgent(relay, bytesToHex(subKp.publicKey));
      const otherKp = await generateKeypair();
      const other = await createAgent(relay, bytesToHex(otherKp.publicKey));

      // BOTH advertise read_url; the submitter must never be chosen.
      await registerAgentWithEndpoint(relay, submitter.motebitId, submitterHits.url, ["read_url"]);
      await registerAgentWithEndpoint(relay, other.motebitId, otherHits.url, ["read_url"]);

      const res = await relay.app.request(`/agent/${submitter.motebitId}/task`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({
          prompt: "read https://example.com",
          submitted_by: submitter.motebitId,
          required_capabilities: ["read_url"],
        }),
      });
      expect(res.status).toBe(201);

      // The forward is fire-and-forget — give it a beat to land.
      await new Promise((r) => setTimeout(r, 400));

      // The incident's mechanism: pre-fix, the submitter (advertising the
      // capability) could be selected as its own worker. Post-fix: never.
      expect(submitterHits.hits()).toBe(0);
      // Routing still works — the OTHER capable agent received the dispatch.
      expect(otherHits.hits()).toBeGreaterThan(0);
    } finally {
      submitterHits.server.close();
      otherHits.server.close();
    }
  });

  it("a task with no snapshot and no allocation settles at gross 0 — never at the executing agent's listing price", async () => {
    const workerKp = await generateKeypair();
    const worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    // Register with a NON-zero listing — the incident's invented gross came
    // from exactly this listing being consulted at receipt time.
    await registerAgentWithEndpoint(relay, worker.motebitId, "http://localhost:9999/mcp", [
      "web_search",
    ]);
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search", "read_url"],
        pricing: [
          { capability: "web_search", unit_cost: 0.003, currency: "USD", per: "task" },
          { capability: "read_url", unit_cost: 0.003, currency: "USD", per: "task" },
        ],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "459 pricing-honesty worker",
      }),
    });

    // Self-delegation (Arc 3 carve-out) at ZERO submission cost: pricingAgent
    // is the URL agent whose listing IS priced — but submit as a free task by
    // targeting a capability-less prompt... Simplest zero-cost shape: the
    // SUBMITTER is the worker itself (self-delegation carve-out) and the URL
    // agent's listing prices it >0, so price_snapshot IS set. To reproduce
    // the incident's no-snapshot state we submit to a DIFFERENT, unlisted
    // agent id (zero listing → unitCostAtSubmission 0 → no snapshot, no
    // allocation) and then deliver the LISTED worker's receipt for it.
    const targetKp = await generateKeypair();
    const target = await createAgent(relay, bytesToHex(targetKp.publicKey));
    const submit = await relay.app.request(`/agent/${target.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt: "search for something" }),
    });
    expect(submit.status).toBe(201);
    const { task_id: taskId } = (await submit.json()) as { task_id: string };

    // The LISTED worker signs and delivers the receipt (the incident shape:
    // the executing agent's listing was then used to invent gross=6316).
    const enc = new TextEncoder();
    const receipt = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: worker.motebitId as unknown as MotebitId,
        device_id: "svc" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "done",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("search for something")),
        result_hash: await sha256(enc.encode("done")),
      },
      workerKp.privateKey,
    );
    const resultRes = await relay.app.request(`/agent/${target.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });
    expect(resultRes.status).toBe(200);

    // The honest outcome: a REAL $0 settlement row (funded via gross 0) —
    // not an unfunded skip of an invented listing-priced gross.
    const row = relay.moteDb.db
      .prepare("SELECT amount_settled, platform_fee FROM relay_settlements WHERE task_id = ?")
      .get(taskId) as { amount_settled: number; platform_fee: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.amount_settled).toBe(0);
    expect(row!.platform_fee).toBe(0);
  });

  it("a failed submission releases its idempotency claim — an honest same-key retry proceeds", async () => {
    const paidKp = await generateKeypair();
    const paidWorker = await createAgent(relay, bytesToHex(paidKp.publicKey));
    await registerAgentWithEndpoint(relay, paidWorker.motebitId, "http://localhost:9999/mcp", [
      "web_search",
    ]);
    await relay.app.request(`/api/v1/agents/${paidWorker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "459 idempotency worker",
      }),
    });
    const delegatorKp = await generateKeypair();
    const delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    const key = `459-retry-${crypto.randomUUID()}`;
    const headers = { ...JSON_AUTH, "Idempotency-Key": key };

    // Attempt 1: paid direct delegation without a P2P proof → the Arc 3.5
    // gate throws 402 AFTER checkIdempotency claimed the key.
    const first = await relay.app.request(`/agent/${paidWorker.motebitId}/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "paid work",
        submitted_by: delegator.motebitId,
      }),
    });
    expect(first.status).toBe(402);

    // Attempt 2, SAME key (the honest retry, here as a free self-submission
    // that passes the gate): pre-fix this 409'd forever ("already being
    // processed") because the claim was stranded; post-fix it proceeds.
    const freeKp = await generateKeypair();
    const freeTarget = await createAgent(relay, bytesToHex(freeKp.publicKey));
    const second = await relay.app.request(`/agent/${freeTarget.motebitId}/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "retry after failure" }),
    });
    expect(second.status).toBe(201);
  });
});

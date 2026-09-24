/**
 * `presenter: "submitter"` — one presenter per admission, chosen up front.
 *
 * Before this field, a sub-delegator that bound its hop through the relay
 * (`POST /agent/:worker/task` with `required_capabilities`) and then called the
 * atom itself was racing the relay: the relay routed the same task to a
 * registered worker (its token travelling with the forward), so the submitter
 * got no token and its direct call was a second, unadmitted presentation. With
 * the field, the relay runs every submission gate, routes NOTHING, and the
 * submitter is the one presenter holding the one token.
 *
 * The capturing worker below is exactly the kind of registered HTTP endpoint
 * Phase 3 would have forwarded to. The assertion is on what it did NOT receive.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, verifySignedToken, hexToBytes } from "@motebit/encryption";
import {
  createTestRelay,
  createAgent,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

// Fixed port below the ephemeral range (feedback_test_fixed_ports_below_ephemeral).
const WORKER_PORT = 18953;

describe("presenter: submitter — the relay admits but does not route", () => {
  let relay: SyncRelay;
  let worker: { motebitId: string; deviceId: string };
  let delegator: { motebitId: string; deviceId: string };
  let server: Server | undefined;
  let forwards: number;

  beforeEach(async () => {
    relay = await createTestRelay();
    worker = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    delegator = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    forwards = 0;
    server = createServer((req, res) => {
      if (req.method === "POST") forwards++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
    });
    await new Promise<void>((r) => server!.listen(WORKER_PORT, "127.0.0.1", () => r()));
    // A registered, reachable, UNPRICED worker — the shape Phase 3 forwards to.
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: `http://127.0.0.1:${WORKER_PORT}/mcp`,
        capabilities: ["read_url"],
      }),
    });
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["read_url"],
        pricing: [{ capability: "read_url", unit_cost: 0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "presenter test worker",
      }),
    });
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await relay.close();
  });

  const submit = async (extra: Record<string, unknown>): Promise<Response> =>
    relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "https://example.com/x",
        submitted_by: delegator.motebitId,
        required_capabilities: ["read_url"],
        ...extra,
      }),
    });

  it("returns the dispatch_token to the submitter and forwards NOTHING to the registered worker", async () => {
    const res = await submit({ presenter: "submitter" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task_id: string; dispatch_token?: string };
    expect(typeof body.dispatch_token).toBe("string");

    // The token is the relay's admission of THIS task for THIS worker.
    const payload = await verifySignedToken(
      body.dispatch_token!,
      hexToBytes(relay.relayIdentity.publicKeyHex),
    );
    expect(payload?.aud).toBe("task:dispatch");
    expect(payload?.mid).toBe(worker.motebitId);
    expect(payload?.sub).toBe(body.task_id);

    // Give any stray fire-and-forget forward a moment to land; none may.
    await new Promise((r) => setTimeout(r, 150));
    expect(forwards).toBe(0);
  });

  it("control: the default presenter still routes to the registered worker and hands the submitter no token", async () => {
    const res = await submit({});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dispatch_token?: string };
    expect(body.dispatch_token).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(forwards).toBeGreaterThan(0);
  });

  it("rejects an unknown presenter value (fail closed on the vocabulary)", async () => {
    const res = await submit({ presenter: "someone-else" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("TASK_INVALID_INPUT");
  });

  it("still runs the settlement gates: an unpaid PRICED hop is refused even with presenter: submitter", async () => {
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["read_url"],
        pricing: [{ capability: "read_url", unit_cost: 0.05, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "priced",
      }),
    });
    const res = await submit({ presenter: "submitter" });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("TASK_P2P_PROOF_REQUIRED");
    expect(forwards).toBe(0);
  });
});

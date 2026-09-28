/**
 * #910 — a throw after dispatch, before `completeIdempotency`, must not let a
 * same-proof resubmit create a second task.
 *
 * The concern (raised in the cold review of #885): the submit handler
 * dispatches the task to the worker and only then completes the idempotency
 * claim. Before #888 a throw between the two reached the error boundary, which
 * released the claim; the #885 client resubmits with the SAME payment proof
 * under the SAME key (its `Idempotency-Key` is the proof's `tx_hash`,
 * `packages/runtime/src/relay-delegation.ts`), so the relay admitted and
 * dispatched a second task on one payment. The unique index on
 * `relay_settlements.p2p_tx_hash` stops a second SETTLEMENT, not a second
 * execution.
 *
 * #888 binds the claim to the task inside the admission transaction, and
 * `releaseIdempotency` never deletes a bound claim. This test forces the throw
 * at the latest possible point — `completeIdempotency` itself, after the task
 * has been dispatched over the worker's socket — and holds the law: the
 * resubmit replays the first answer, names the same task, and the worker is
 * sent the task exactly once. Regression lock: it goes red if the release on
 * the error boundary can reopen a bound claim again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { createTestRelay, createAgent, buildP2pPaymentProof, JSON_AUTH } from "./test-helpers.js";
import { toMicro } from "../accounts.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

async function newAgent(): Promise<{ motebitId: string; deviceId: string }> {
  const kp = await generateKeypair();
  return createAgent(relay, bytesToHex(kp.publicKey));
}

function tasksWithPrompt(prompt: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT task_id FROM relay_task_queue WHERE prompt = ?")
      .all(prompt) as { task_id: string }[]
  ).map((r) => r.task_id);
}

describe("#910 a throw after dispatch never frees the claim for a same-proof resubmit", () => {
  it("pinned-local P2P: dispatched, then completeIdempotency throws — the same-proof resubmit replays the answer and the worker gets the task once", async () => {
    const delegator = await newAgent();
    const worker = await newAgent();
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://127.0.0.1:18999/mcp",
        capabilities: ["web_search"],
        settlement_address: WORKER_SOLANA_ADDR,
        settlement_modes: "relay,p2p",
      }),
    });
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "910 worker",
        pay_to_address: WORKER_SOLANA_ADDR,
      }),
    });
    // An established pair — P2P eligibility is not under test.
    relay.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust
         (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES (?, ?, 'verified', 10, ?, ?)`,
      )
      .run(delegator.motebitId, worker.motebitId, Date.now(), Date.now());

    // The worker's open socket: dispatch is a frame sent on it.
    const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    relay.connections.set(worker.motebitId, [
      { ws: ws as never, deviceId: worker.deviceId, capabilities: ["web_search"] },
    ]);
    const dispatched = () =>
      ws.send.mock.calls.filter((call) => String(call[0]).includes('"task_request"')).length;

    // The throw: completeIdempotency's write aborts — after dispatch, before
    // the claim is completed. (The admission-outcome record, a 500, passes.)
    relay.moteDb.db.exec(
      `CREATE TRIGGER zz910_fail_complete BEFORE UPDATE ON relay_idempotency_keys
       WHEN NEW.status = 'completed' AND NEW.response_status = 201
       BEGIN SELECT RAISE(ABORT, 'forced failure after dispatch'); END;`,
    );

    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const prompt = `910 resubmit ${crypto.randomUUID()}`;
    const submit = () =>
      relay.app.request(`/agent/${delegator.motebitId}/task`, {
        method: "POST",
        // The #885 client's key IS the proof's tx_hash.
        headers: { ...JSON_AUTH, "Idempotency-Key": proof.tx_hash },
        body: JSON.stringify({
          prompt,
          submitted_by: delegator.motebitId,
          target_agent: worker.motebitId,
          settlement_mode: "p2p",
          payment_proof: proof,
          required_capabilities: ["web_search"],
        }),
      });

    const first = await submit();
    expect(first.status, await first.clone().text()).toBe(500);
    const b1 = (await first.json()) as { task_id?: string };
    const tasks = tasksWithPrompt(prompt);
    expect(tasks).toHaveLength(1);
    expect(b1.task_id, "the failed answer names the task it admitted").toBe(tasks[0]);
    expect(dispatched(), "the task reached the worker before the throw").toBe(1);

    // The client saw a failure and resubmits the SAME proof.
    const resubmit = await submit();
    expect(resubmit.status).toBe(500);
    expect(await resubmit.json(), "a replay of the first answer").toEqual(b1);
    expect(tasksWithPrompt(prompt), "no second task").toEqual(tasks);
    expect(dispatched(), "the worker is sent the task once").toBe(1);
  });
});

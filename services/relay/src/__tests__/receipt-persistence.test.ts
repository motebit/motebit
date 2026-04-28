/**
 * relay_receipts archive invariants.
 *
 * Four invariants, each the strongest form:
 *   1. Byte identity — stored `receipt_json` equals `canonicalJson(signed)`.
 *   2. Verify-from-store — Ed25519 verify passes against the stored row alone.
 *   3. Multihop — nested delegation_receipts persist with parent+depth.
 *   4. Idempotency — duplicate submission leaves one row, not two.
 *
 * Plus the migration landing smoke-check (table + indexes exist).
 *
 * The point of the archive is offline auditability (spec/execution-ledger-v1.md
 * §11.1 Storage; docs/doctrine/operator-transparency.md "Operational"): a
 * holder of the stored row must be able to re-verify the signature without
 * any further relay contact.
 */
import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  verifyExecutionReceipt,
  canonicalJson,
  hexToBytes,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId, ExecutionReceipt } from "@motebit/sdk";
import {
  AUTH_HEADER as AUTH,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
} from "./test-helpers.js";
import type { SyncRelay } from "../index.js";

async function registerWorker(relay: SyncRelay, motebitId: string, unitCost = 0.5): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:3200/mcp",
      capabilities: ["web_search"],
    }),
  });
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: unitCost, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "Test",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
}

async function deposit(relay: SyncRelay, motebitId: string, amount: number): Promise<void> {
  await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      amount,
      reference: `deposit-${crypto.randomUUID()}`,
      description: "test",
    }),
  });
}

describe("relay_receipts schema", () => {
  it("migration v10 creates the table and indexes", async () => {
    const relay = await createTestRelay();
    const cols = relay.moteDb.db.prepare("PRAGMA table_info(relay_receipts)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "depth",
        "invocation_origin",
        "motebit_id",
        "parent_task_id",
        "public_key",
        "receipt_json",
        "received_at",
        "signature",
        "status",
        "suite",
        "task_id",
      ].sort(),
    );
    const indexes = relay.moteDb.db.prepare("PRAGMA index_list(relay_receipts)").all() as Array<{
      name: string;
    }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_relay_receipts_task");
    expect(indexNames).toContain("idx_relay_receipts_parent");
    expect(indexNames).toContain("idx_relay_receipts_origin");
  });
});

describe("relay_receipts archive invariants", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("stores byte-identical canonical JSON that re-verifies offline", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const agentA = await createAgent(relay, bytesToHex(kpA.publicKey));
    const agentB = await createAgent(relay, bytesToHex(kpB.publicKey));

    await registerWorker(relay, agentB.motebitId);
    await deposit(relay, agentA.motebitId, 10.0);

    const taskRes = await relay.app.request(`/agent/${agentB.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "search",
        submitted_by: agentA.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    const enc = new TextEncoder();
    const signed = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: agentB.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpB.publicKey),
        device_id: "b-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "ok",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("search")),
        result_hash: await sha256(enc.encode("ok")),
      },
      kpB.privateKey,
      kpB.publicKey,
    );

    const submitRes = await relay.app.request(`/agent/${agentB.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(signed),
    });
    expect(submitRes.status).toBe(200);

    const row = relay.moteDb.db
      .prepare(
        "SELECT motebit_id, task_id, depth, parent_task_id, status, suite, public_key, signature, receipt_json FROM relay_receipts WHERE task_id = ?",
      )
      .get(taskId) as
      | {
          motebit_id: string;
          task_id: string;
          depth: number;
          parent_task_id: string | null;
          status: string;
          suite: string;
          public_key: string;
          signature: string;
          receipt_json: string;
        }
      | undefined;

    expect(row).toBeDefined();
    expect(row!.motebit_id).toBe(agentB.motebitId);
    expect(row!.depth).toBe(0);
    expect(row!.parent_task_id).toBeNull();
    expect(row!.status).toBe("completed");
    expect(row!.public_key).toBe(bytesToHex(kpB.publicKey));
    expect(row!.signature).toBe(signed.signature);

    // Invariant 1: byte identity. Re-canonicalizing the signed receipt
    // must equal the stored bytes exactly — that is the whole point.
    expect(row!.receipt_json).toBe(canonicalJson(signed));

    // Invariant 2: verify from the stored row alone. Parse, re-verify
    // against the stored public_key — no access to the keypair needed.
    const reconstructed = JSON.parse(row!.receipt_json) as ExecutionReceipt;
    const valid = await verifyExecutionReceipt(reconstructed, hexToBytes(row!.public_key));
    expect(valid).toBe(true);

    // Route: admin fetch serves the stored bytes verbatim.
    const fetchRes = await relay.app.request(
      `/api/v1/admin/receipts/${agentB.motebitId}/${taskId}`,
      { headers: AUTH },
    );
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.headers.get("content-type")).toContain("application/json");
    const served = await fetchRes.text();
    expect(served).toBe(row!.receipt_json);
  });

  it("persists the whole chain for multihop delegation", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();
    const agentA = await createAgent(relay, bytesToHex(kpA.publicKey));
    const agentB = await createAgent(relay, bytesToHex(kpB.publicKey));
    const agentC = await createAgent(relay, bytesToHex(kpC.publicKey));

    await registerWorker(relay, agentB.motebitId);
    await registerWorker(relay, agentC.motebitId);
    await deposit(relay, agentA.motebitId, 20.0);
    await deposit(relay, agentB.motebitId, 20.0);

    const resAB = await relay.app.request(`/agent/${agentB.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "outer",
        submitted_by: agentA.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    const { task_id: taskAB } = (await resAB.json()) as { task_id: string };

    const resBC = await relay.app.request(`/agent/${agentC.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "inner",
        submitted_by: agentB.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    const { task_id: taskBC } = (await resBC.json()) as { task_id: string };

    const enc = new TextEncoder();
    const receiptC = await signExecutionReceipt(
      {
        task_id: taskBC,
        relay_task_id: taskBC,
        motebit_id: agentC.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpC.publicKey),
        device_id: "c-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "inner-result",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("inner")),
        result_hash: await sha256(enc.encode("inner-result")),
      },
      kpC.privateKey,
      kpC.publicKey,
    );

    const receiptB = await signExecutionReceipt(
      {
        task_id: taskAB,
        relay_task_id: taskAB,
        motebit_id: agentB.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpB.publicKey),
        device_id: "b-device" as unknown as DeviceId,
        submitted_at: Date.now() - 2000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "outer-result",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("outer")),
        result_hash: await sha256(enc.encode("outer-result")),
        delegation_receipts: [receiptC],
      },
      kpB.privateKey,
      kpB.publicKey,
    );

    const submit = await relay.app.request(`/agent/${agentB.motebitId}/task/${taskAB}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receiptB),
    });
    expect(submit.status).toBe(200);

    const rows = relay.moteDb.db
      .prepare(
        "SELECT motebit_id, task_id, parent_task_id, depth FROM relay_receipts WHERE task_id IN (?, ?) ORDER BY depth ASC",
      )
      .all(taskAB, taskBC) as Array<{
      motebit_id: string;
      task_id: string;
      parent_task_id: string | null;
      depth: number;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      motebit_id: agentB.motebitId,
      task_id: taskAB,
      parent_task_id: null,
      depth: 0,
    });
    expect(rows[1]).toMatchObject({
      motebit_id: agentC.motebitId,
      task_id: taskBC,
      parent_task_id: taskAB,
      depth: 1,
    });
  });

  it("is idempotent — a duplicate receipt submission does not double-write", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const agentA = await createAgent(relay, bytesToHex(kpA.publicKey));
    const agentB = await createAgent(relay, bytesToHex(kpB.publicKey));

    await registerWorker(relay, agentB.motebitId);
    await deposit(relay, agentA.motebitId, 10.0);

    const taskRes = await relay.app.request(`/agent/${agentB.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "x",
        submitted_by: agentA.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    const enc = new TextEncoder();
    const signed = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: agentB.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpB.publicKey),
        device_id: "b-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "y",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("x")),
        result_hash: await sha256(enc.encode("y")),
      },
      kpB.privateKey,
      kpB.publicKey,
    );

    const body = JSON.stringify(signed);
    const first = await relay.app.request(`/agent/${agentB.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body,
    });
    expect(first.status).toBe(200);
    const second = await relay.app.request(`/agent/${agentB.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body,
    });
    // Duplicate submission: the handler short-circuits on already_settled;
    // whether it returns 200 or 2xx-ish, the invariant we care about is
    // that relay_receipts holds exactly one row.
    expect([200, 201, 202, 409]).toContain(second.status);

    const count = relay.moteDb.db
      .prepare("SELECT COUNT(*) as n FROM relay_receipts WHERE task_id = ?")
      .get(taskId) as { n: number };
    expect(count.n).toBe(1);
  });
});

/**
 * User-owned receipt retrieval — a motebit pulls its OWN signed execution
 * receipts back from the relay archive and re-verifies them offline. Closes the
 * delegation→execution→receipt→verify loop on the retrieval side (the receipts
 * were already signed + persisted; this is the read path that makes them a
 * product object, not just a backend artifact).
 *
 * The security contract (services/relay/CLAUDE.md rule 5, fail-closed privacy):
 * the routes are gated on the `receipts:read` audience AND the handler enforces
 * caller-owns-motebitId, so a valid token for one motebit cannot enumerate
 * another's history. The operator master token bypasses (admin path).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto primitives
import { generateKeypair, bytesToHex, signExecutionReceipt, verifyReceipt } from "@motebit/crypto";
// eslint-disable-next-line no-restricted-imports -- tests mint their own bearer tokens
import { createSignedToken } from "@motebit/encryption";
import { persistReceiptChain } from "../receipts-store.js";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";

interface SeededAgent {
  privateKey: Uint8Array;
  motebitId: string;
  deviceId: string;
  taskId: string;
}

/** Register an identity + device and persist one signed receipt for it. */
async function seedAgentWithReceipt(
  relay: SyncRelay,
  status: "completed" | "denied" = "completed",
): Promise<SeededAgent> {
  const kp = await generateKeypair();
  const pubKeyHex = bytesToHex(kp.publicKey);
  const idRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await idRes.json()) as { motebit_id: string };
  const devRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id, device_name: "T", public_key: pubKeyHex }),
  });
  const { device_id } = (await devRes.json()) as { device_id: string };

  const taskId = `task-${crypto.randomUUID()}`;
  const unsigned = {
    task_id: taskId,
    motebit_id,
    device_id,
    submitted_at: 1000,
    completed_at: 2000,
    status,
    result:
      status === "denied"
        ? "Task refused by governance: 1 action(s) exceeded this motebit's policy."
        : "audited the ledger and paused for approval",
    tools_used: status === "denied" ? [] : ["web_search"],
    memories_formed: 0,
    prompt_hash: "0".repeat(64),
    result_hash: "1".repeat(64),
  };
  const signed = await signExecutionReceipt(
    unsigned as unknown as Parameters<typeof signExecutionReceipt>[0],
    kp.privateKey,
    kp.publicKey, // embed public_key so the retrieved receipt verifies offline
  );
  persistReceiptChain(
    relay.moteDb.db,
    signed as unknown as Parameters<typeof persistReceiptChain>[1],
  );

  return { privateKey: kp.privateKey, motebitId: motebit_id, deviceId: device_id, taskId };
}

function mintToken(
  mid: string,
  did: string,
  privateKey: Uint8Array,
  aud = "receipts:read",
): Promise<string> {
  return createSignedToken(
    { mid, did, iat: Date.now(), exp: Date.now() + 5 * 60 * 1000, jti: crypto.randomUUID(), aud },
    privateKey,
  );
}

describe("user-owned receipt retrieval", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("a motebit lists + fetches its OWN receipts, byte-verbatim and offline-verifiable", async () => {
    const a = await seedAgentWithReceipt(relay);
    const token = await mintToken(a.motebitId, a.deviceId, a.privateKey);

    const listRes = await relay.app.request(`/api/v1/agents/${a.motebitId}/receipts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const { receipts } = (await listRes.json()) as {
      receipts: Array<{ task_id: string; status: string; receipt_json: string }>;
    };
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.task_id).toBe(a.taskId);
    expect(receipts[0]!.status).toBe("completed");
    const fromList = JSON.parse(receipts[0]!.receipt_json) as Parameters<typeof verifyReceipt>[0];
    expect((await verifyReceipt(fromList)).valid).toBe(true);

    const getRes = await relay.app.request(`/api/v1/agents/${a.motebitId}/receipts/${a.taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status).toBe(200);
    const one = (await getRes.json()) as Parameters<typeof verifyReceipt>[0];
    expect((await verifyReceipt(one)).valid).toBe(true);
  });

  it("a status:'denied' refusal receipt is retrievable + offline-verifiable (delegation refusal path)", async () => {
    // The agent refuses itself (deny_above / scope / budget); the runtime signs
    // the refusal with its OWN key. This closes the user-facing leg: the signed
    // denial is pulled back through the same owner-scoped endpoint and re-verified
    // offline, byte-verbatim — a refusal is as auditable as a completion.
    const a = await seedAgentWithReceipt(relay, "denied");
    const token = await mintToken(a.motebitId, a.deviceId, a.privateKey);

    const getRes = await relay.app.request(`/api/v1/agents/${a.motebitId}/receipts/${a.taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status).toBe(200);
    const receipt = (await getRes.json()) as Parameters<typeof verifyReceipt>[0];
    expect((receipt as { status: string }).status).toBe("denied");
    expect((await verifyReceipt(receipt)).valid).toBe(true);
  });

  it("the operator master token can read any motebit's receipts", async () => {
    const a = await seedAgentWithReceipt(relay);
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/receipts`, {
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).receipts).toHaveLength(1);
  });

  it("a device token for ANOTHER motebit cannot enumerate this motebit's receipts (403)", async () => {
    const a = await seedAgentWithReceipt(relay);
    const b = await seedAgentWithReceipt(relay);
    const bToken = await mintToken(b.motebitId, b.deviceId, b.privateKey);
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/receipts`, {
      headers: { Authorization: `Bearer ${bToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("a token with the wrong audience is rejected (401) — audience binding", async () => {
    const a = await seedAgentWithReceipt(relay);
    const wrong = await mintToken(a.motebitId, a.deviceId, a.privateKey, "sync");
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/receipts`, {
      headers: { Authorization: `Bearer ${wrong}` },
    });
    expect(res.status).toBe(401);
  });

  it("404 for a task the motebit never ran", async () => {
    const a = await seedAgentWithReceipt(relay);
    const token = await mintToken(a.motebitId, a.deviceId, a.privateKey);
    const res = await relay.app.request(`/api/v1/agents/${a.motebitId}/receipts/does-not-exist`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

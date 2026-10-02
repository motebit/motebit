/**
 * The appeal route awaits the appeal's signature check between reading the
 * dispute (`resolved`) and writing `appealed`. A concurrent read in that gap
 * can lazy-finalize the verdict and execute its fund action; the appeal's
 * write must then change nothing — an appeal never re-opens a final dispute.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const gate: { reached: () => void; release: Promise<void> | null } = {
  reached: () => {},
  release: null,
};

vi.mock("@motebit/encryption", async (orig) => {
  const actual = await orig<typeof import("@motebit/encryption")>();
  return {
    ...actual,
    verifyDisputeAppeal: async (...args: Parameters<typeof actual.verifyDisputeAppeal>) => {
      gate.reached();
      if (gate.release) await gate.release;
      return actual.verifyDisputeAppeal(...args);
    },
  };
});

import {
  generateKeypair,
  bytesToHex,
  signDisputeRequest,
  signDisputeAppeal,
} from "@motebit/encryption";
import { AUTH_HEADER, JSON_AUTH, createTestRelay, seedX402PaidTask } from "./test-helpers.js";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };
const DELEGATOR = "del-race";
const WORKER = "wrk-race";

let dKp: Keypair;
let wKp: Keypair;

beforeAll(async () => {
  dKp = await generateKeypair();
  wKp = await generateKeypair();
});

describe("appeal vs concurrent finalize", () => {
  it("an appeal whose verdict finalized during its signature check is refused and writes nothing", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    const db = relay.moteDb.db;
    for (const [id, kp] of [
      [DELEGATOR, dKp],
      [WORKER, wKp],
    ] as const) {
      const r = await relay.app.request("/api/v1/agents/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({
          motebit_id: id,
          endpoint_url: "http://localhost:9999/mcp",
          capabilities: ["web_search"],
          public_key: bytesToHex(kp.publicKey),
        }),
      });
      expect(r.status).toBe(200);
    }
    const taskId = seedX402PaidTask(relay, {
      workerId: WORKER,
      delegatorId: DELEGATOR,
      prompt: "search",
      unitCostUsd: 1.0,
    });
    const allocationId = `x402-${taskId}`;
    const disputeId = "dsp-race-1";
    const filed = await relay.app.request(`/api/v1/allocations/${allocationId}/dispute`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(
        await signDisputeRequest(
          {
            dispute_id: disputeId,
            task_id: taskId,
            allocation_id: allocationId,
            filed_by: DELEGATOR,
            respondent: WORKER,
            category: "quality",
            description: "contested",
            evidence_refs: ["r"],
            filed_at: Date.now(),
          },
          dKp.privateKey,
        ),
      ),
    });
    expect(filed.status).toBe(200);
    const resolved = await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        resolution: "upheld",
        fund_action: "refund_to_delegator",
        split_ratio: 0,
        rationale: "verdict",
      }),
    });
    expect(resolved.status).toBe(200);

    // Hold the appeal inside its signature check.
    let release!: () => void;
    gate.release = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (gate.reached = r));
    const appeal = relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(
        await signDisputeAppeal(
          {
            dispute_id: disputeId,
            appealed_by: WORKER,
            reason: "disagree",
            appealed_at: Date.now(),
          },
          wKp.privateKey,
        ),
      ),
    });
    await reached;

    // Meanwhile the window passes and a read finalizes the verdict.
    db.prepare("UPDATE relay_disputes SET resolved_at = ? WHERE dispute_id = ?").run(
      Date.now() - 25 * 60 * 60 * 1000,
      disputeId,
    );
    const read = await relay.app.request(`/api/v1/disputes/${disputeId}`, {
      headers: AUTH_HEADER,
    });
    expect(read.status).toBe(200);
    const txAfterFinal = (
      db.prepare("SELECT COUNT(*) AS n FROM relay_transactions").get() as { n: number }
    ).n;

    release();
    const res = await appeal;
    gate.release = null;
    expect(res.status).toBe(409);
    const row = db
      .prepare("SELECT state, appealed_at FROM relay_disputes WHERE dispute_id = ?")
      .get(disputeId) as { state: string; appealed_at: number | null };
    expect(row.state).toBe("final");
    expect(row.appealed_at).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM relay_transactions").get() as { n: number }).n,
    ).toBe(txAfterFinal);
    await relay.close();
  });
});

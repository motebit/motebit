/**
 * Settlement-summary route — the per-peer economic projection over the
 * signed `relay_settlements` ledger (the money side of the first-person
 * trust graph, `docs/doctrine/agents-as-first-person-trust-graph.md` §6).
 *
 * Two concerns:
 *   1. The aggregation: earned-from / paid-to / net / fee / p2p-count per
 *      counterparty, the unattributed bucket for null-delegator rows, and
 *      the two exclusions (failed p2p verification, self-settlement).
 *   2. Own-id enforcement: a device token may read only its own motebit's
 *      history; the master token (operator console) bypasses.
 *
 * The signed-manifest round-trip is covered by the state-export sweep
 * (`state-export-manifest.test.ts`); this file pins the projection math
 * and the access boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, createSignedToken, bytesToHex } from "@motebit/encryption";
import type { SettlementSummaryExport } from "@motebit/protocol";
import { AUTH_HEADER, createTestRelay, createAgent } from "./test-helpers.js";

const ME = "mote-me";
const PEER_A = "mote-peer-a";
const PEER_B = "mote-peer-b";

interface SeedRow {
  motebit_id: string;
  delegator_id: string | null;
  amount_settled: number;
  platform_fee: number;
  settlement_mode: "relay" | "p2p";
  payment_verification_status?: string | null;
  status?: string;
  settled_at: number;
}

function seed(relay: SyncRelay, rows: SeedRow[]): void {
  const stmt = relay.moteDb.db.prepare(
    `INSERT INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
        amount_settled, platform_fee, platform_fee_rate, status, settled_at,
        settlement_mode, delegator_id, payment_verification_status)
     VALUES (?, ?, ?, ?, '', ?, ?, 0.05, ?, ?, ?, ?, ?)`,
  );
  let i = 0;
  for (const r of rows) {
    i += 1;
    stmt.run(
      `s-${i}-${crypto.randomUUID()}`,
      `a-${i}-${crypto.randomUUID()}`,
      `task-${i}`,
      r.motebit_id,
      r.amount_settled,
      r.platform_fee,
      r.status ?? "completed",
      r.settled_at,
      r.settlement_mode,
      r.delegator_id,
      r.payment_verification_status ?? "verified",
    );
  }
}

async function fetchSummary(relay: SyncRelay, id: string): Promise<SettlementSummaryExport> {
  const res = await relay.app.request(`/api/v1/agents/${id}/settlements`, {
    method: "GET",
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SettlementSummaryExport;
}

describe("settlement-summary — per-peer projection", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
    seed(relay, [
      // earned from peer A — relay-custody then p2p
      {
        motebit_id: ME,
        delegator_id: PEER_A,
        amount_settled: 1_000_000,
        platform_fee: 50_000,
        settlement_mode: "relay",
        settled_at: 100,
      },
      {
        motebit_id: ME,
        delegator_id: PEER_A,
        amount_settled: 2_000_000,
        platform_fee: 100_000,
        settlement_mode: "p2p",
        settled_at: 200,
      },
      // paid to peer B — p2p (the fee here is MY coordination cost)
      {
        motebit_id: PEER_B,
        delegator_id: ME,
        amount_settled: 500_000,
        platform_fee: 25_000,
        settlement_mode: "p2p",
        settled_at: 150,
      },
      // a FAILED p2p leg-check to peer B — the claimed payment never landed, must be dropped
      {
        motebit_id: PEER_B,
        delegator_id: ME,
        amount_settled: 9_000_000,
        platform_fee: 0,
        settlement_mode: "p2p",
        payment_verification_status: "failed",
        settled_at: 300,
      },
      // earned with no attributable payer — the unattributed bucket
      {
        motebit_id: ME,
        delegator_id: null,
        amount_settled: 300_000,
        platform_fee: 15_000,
        settlement_mode: "relay",
        settled_at: 50,
      },
      // a self-settlement — not a relationship, excluded
      {
        motebit_id: ME,
        delegator_id: ME,
        amount_settled: 7,
        platform_fee: 0,
        settlement_mode: "relay",
        settled_at: 400,
      },
    ]);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("aggregates earned/paid/net/fee per counterparty, most-recent first", async () => {
    const summary = await fetchSummary(relay, ME);
    expect(summary.motebit_id).toBe(ME);
    // sorted by last_at desc: peer A (200) before peer B (150)
    expect(summary.peers.map((p) => p.peer_id)).toEqual([PEER_A, PEER_B]);

    const a = summary.peers[0]!;
    expect(a.earned_micro).toBe(3_000_000);
    expect(a.paid_micro).toBe(0);
    expect(a.net_micro).toBe(3_000_000);
    expect(a.fee_micro).toBe(0); // fees on earned rows were the PEER's cost, never mine
    expect(a.settled_count).toBe(2);
    expect(a.p2p_count).toBe(1);
    expect(a.first_at).toBe(100);
    expect(a.last_at).toBe(200);

    const b = summary.peers[1]!;
    expect(b.earned_micro).toBe(0);
    expect(b.paid_micro).toBe(500_000);
    expect(b.net_micro).toBe(-500_000); // net payer to B
    expect(b.fee_micro).toBe(25_000); // the fee I paid as the funder
    expect(b.settled_count).toBe(1); // the failed row is excluded
    expect(b.p2p_count).toBe(1);
  });

  it("buckets null-delegator rows as unattributed, never a phantom peer", async () => {
    const summary = await fetchSummary(relay, ME);
    expect(summary.unattributed.earned_micro).toBe(300_000);
    expect(summary.unattributed.fee_micro).toBe(15_000);
    expect(summary.unattributed.settled_count).toBe(1);
    expect(summary.peers.some((p) => p.peer_id === "" || p.peer_id == null)).toBe(false);
  });

  it("excludes self-settlements (not a relationship)", async () => {
    const summary = await fetchSummary(relay, ME);
    expect(summary.peers.some((p) => p.peer_id === ME)).toBe(false);
  });

  it("returns an honest-empty summary for a motebit with no settlements", async () => {
    const summary = await fetchSummary(relay, "mote-stranger");
    expect(summary.peers).toEqual([]);
    expect(summary.unattributed).toEqual({ earned_micro: 0, fee_micro: 0, settled_count: 0 });
  });
});

describe("settlement-summary — own-id enforcement", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("a device token reads its own history but not another motebit's", async () => {
    const keypair = await generateKeypair();
    const { motebitId, deviceId } = await createAgent(relay, bytesToHex(keypair.publicKey));
    const token = await createSignedToken(
      {
        mid: motebitId,
        did: deviceId,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud: "account:balance",
      },
      keypair.privateKey,
    );
    const auth = { Authorization: `Bearer ${token}` };

    const own = await relay.app.request(`/api/v1/agents/${motebitId}/settlements`, {
      headers: auth,
    });
    expect(own.status).toBe(200);

    const other = await relay.app.request(`/api/v1/agents/${PEER_A}/settlements`, {
      headers: auth,
    });
    expect(other.status).toBe(403);
  });
});

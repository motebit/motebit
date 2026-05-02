/**
 * Phase 6.2 — leader-side federation orchestrator tests.
 *
 * Covers the orchestrator's fan-out + aggregation behavior in
 * `services/relay/src/disputes.ts::orchestrateFederationResolution`.
 * The orchestrator is the load-bearing piece of §6.2 federation
 * adjudication; it replaces the prior 409 self-adjudication guard with
 * the federation peer fan-out path described in
 * `spec/relay-federation-v1.md` §16.1.
 *
 * Tests use a mocked `fetchImpl` injected via DisputeDeps. Each peer
 * is represented by a real Ed25519 keypair (signs its own
 * AdjudicatorVote responses) plus a canned response policy
 * (vote outcome, error injection, malformed body, bad signature, ...).
 *
 * What we assert:
 *   - Happy path: 3 valid votes → majority outcome → fund_action=split,
 *     split_ratio per verdict (1.0 / 0.0 / 0.5)
 *   - §6.4 ties → split
 *   - §6.6 quorum-failure fallback when valid count < 3
 *   - 503 insufficient_federation_peers when active peer count < 3
 *   - Per-peer failures (timeout / malformed / bad sig / round mismatch /
 *     dispute_id mismatch / peer_id mismatch) → no vote collected,
 *     §6.5 independent-review property preserved
 *   - Each valid vote persisted to relay_dispute_votes with round=1
 */
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  generateKeypair,
  bytesToHex,
  signDisputeEvidence,
  verifyDisputeEvidence,
} from "@motebit/encryption";
import { signAdjudicatorVote } from "@motebit/crypto";
import type { DisputeOutcome, DisputeRequest, VoteRequest } from "@motebit/protocol";
import { createFederationTables, type RelayIdentity } from "../federation.js";
import { createDisputeTables, orchestrateFederationResolution } from "../disputes.js";
import { runMigrations, relayMigrations } from "../migrations.js";
import { createPairingTables } from "../pairing.js";

interface PeerSetup {
  identity: RelayIdentity;
  endpointUrl: string;
}

async function makeIdentity(label: string): Promise<RelayIdentity> {
  const kp = await generateKeypair();
  return {
    relayMotebitId: `relay-${label}-${crypto.randomUUID().slice(0, 8)}`,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
    did: `did:key:test-${bytesToHex(kp.publicKey).slice(0, 8)}`,
  };
}

interface OrchTestEnv {
  db: DatabaseDriver;
  leader: RelayIdentity;
  peers: PeerSetup[];
  /**
   * Insert a dispute row (the leader is filed_by; respondent is some
   * external motebit). Default `filer_role` is `null` to preserve the
   * pre-migration-21 v1 `fund_action: split` shape; tests asserting on
   * the §7.2 granular mapping pass `worker` or `delegator` explicitly.
   */
  filePeerlessDispute: (
    disputeId: string,
    filerRole?: "worker" | "delegator" | null,
  ) => DisputeRequest;
}

async function setupOrchEnv(peerCount: number): Promise<OrchTestEnv> {
  const moteDb = await openMotebitDatabase(":memory:");
  const db = moteDb.db;
  // Force-emit a Hono app so createDisputeTables runs cleanly. We don't
  // route through the HTTP layer in these tests; we call the orchestrator
  // function directly.
  const app = new Hono();
  void app;
  createFederationTables(db);
  createPairingTables(db);
  createDisputeTables(db);
  // Apply real relay migrations (including 17 phase_6_2_dispute_votes
  // which creates the relay_dispute_votes table the orchestrator
  // persists into). Mirrors horizon.test.ts setup order: tables first,
  // then migrations.
  runMigrations(db, relayMigrations);

  const leader = await makeIdentity("leader");
  const peers: PeerSetup[] = [];
  for (let i = 0; i < peerCount; i++) {
    const identity = await makeIdentity(`peer${i}`);
    const endpointUrl = `http://peer${i}.test`;
    peers.push({ identity, endpointUrl });

    db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, missed_heartbeats, agent_count, trust_score, peered_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, 'active', 0, 0, 0.5, ?, ?)`,
    ).run(
      identity.relayMotebitId,
      identity.publicKeyHex,
      endpointUrl,
      `peer${i}`,
      Date.now(),
      Date.now(),
    );
  }

  function filePeerlessDispute(
    disputeId: string,
    filerRole: "worker" | "delegator" | null = null,
  ): DisputeRequest {
    const req: DisputeRequest = {
      dispute_id: disputeId,
      task_id: "task-test",
      allocation_id: "alloc-test",
      filed_by: leader.relayMotebitId, // leader is the filer → triggers federation path
      respondent: "motebit-respondent",
      category: "quality",
      description: "test dispute",
      evidence_refs: ["receipt-abc"],
      filed_at: Date.now(),
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: "synthetic-test-sig-not-verified-by-orchestrator",
    };
    db.prepare(
      `INSERT INTO relay_disputes
       (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence', 0, 0, ?, ?, ?, ?)`,
    ).run(
      req.dispute_id,
      req.task_id,
      req.allocation_id,
      req.filed_by,
      req.respondent,
      req.category,
      req.description,
      req.filed_at,
      req.filed_at + 86_400_000,
      JSON.stringify(req),
      filerRole,
    );
    return req;
  }

  return { db, leader, peers, filePeerlessDispute };
}

interface PeerResponsePolicy {
  /** Vote to return (when responding normally). */
  vote?: DisputeOutcome;
  /** If set, override the round in the response (negative test). */
  forceRound?: number;
  /** If set, override dispute_id in the response (negative test). */
  forceDisputeId?: string;
  /** If set, override peer_id in the response (negative test). */
  forcePeerId?: string;
  /** Return a malformed body (not an AdjudicatorVote). */
  malformed?: boolean;
  /** Sign with a different (mismatched) key — produces invalid signature. */
  badSignature?: boolean;
  /** Throw a fetch error (network failure / timeout). */
  fetchError?: string;
  /** Return non-2xx status. */
  status?: number;
}

function makeFetchImpl(
  peers: PeerSetup[],
  policies: Map<string, PeerResponsePolicy>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const peer = peers.find((p) => url.startsWith(p.endpointUrl));
    if (!peer) throw new Error(`unrouted url: ${url}`);
    const policy = policies.get(peer.identity.relayMotebitId) ?? { vote: "split" };

    if (policy.fetchError) throw new Error(policy.fetchError);

    const body = JSON.parse(init!.body as string) as VoteRequest;

    if (policy.malformed) {
      return new Response(JSON.stringify({ not: "an adjudicator vote" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (policy.status && policy.status !== 200) {
      return new Response(JSON.stringify({ error_code: "test_injected", message: "test" }), {
        status: policy.status,
        headers: { "content-type": "application/json" },
      });
    }

    // Normal path: sign a vote with this peer's key (or a wrong key for badSignature).
    const signingKey = policy.badSignature
      ? (await generateKeypair()).privateKey // mismatched key
      : peer.identity.privateKey;
    const signed = await signAdjudicatorVote(
      {
        dispute_id: policy.forceDisputeId ?? body.dispute_id,
        round: policy.forceRound ?? body.round,
        peer_id: policy.forcePeerId ?? peer.identity.relayMotebitId,
        vote: policy.vote ?? "split",
        rationale: `peer ${peer.identity.relayMotebitId} test vote`,
      },
      signingKey,
    );
    return new Response(JSON.stringify(signed), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

let env: OrchTestEnv;

afterEach(() => {
  env?.db?.close();
});

describe("orchestrateFederationResolution — happy paths", () => {
  it("3 peers all upheld → resolution=upheld, split_ratio=1.0, fund_action=split", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map(
      env.peers.map((p) => [p.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }]),
    );
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-happy-upheld");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );

    expect(result.resolution).toBe("upheld");
    expect(result.fund_action).toBe("split");
    expect(result.split_ratio).toBe(1.0);
    expect(result.adjudicator_votes).toHaveLength(3);
    expect(result.adjudicator_votes.every((v) => v.vote === "upheld")).toBe(true);
    expect(result.adjudicator_votes.every((v) => v.round === 1)).toBe(true);

    // Verify each vote persisted at round=1
    const persisted = env.db
      .prepare("SELECT vote, round FROM relay_dispute_votes WHERE dispute_id = ? AND round = ?")
      .all(dispute.dispute_id, 1) as Array<{ vote: string; round: number }>;
    expect(persisted).toHaveLength(3);
    expect(persisted.every((p) => p.vote === "upheld" && p.round === 1)).toBe(true);
  });

  it("3 peers [upheld, upheld, overturned] → majority upheld", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[2]!.identity.relayMotebitId, { vote: "overturned" as DisputeOutcome }],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-majority");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );

    expect(result.resolution).toBe("upheld");
    expect(result.split_ratio).toBe(1.0);
    expect(result.adjudicator_votes).toHaveLength(3);
  });

  it("3 peers all overturned → resolution=overturned, split_ratio=0.0", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map(
      env.peers.map((p) => [p.identity.relayMotebitId, { vote: "overturned" as DisputeOutcome }]),
    );
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-overturned");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );

    expect(result.resolution).toBe("overturned");
    expect(result.split_ratio).toBe(0.0);
  });
});

describe("orchestrateFederationResolution — §7.2 fund_action mapping", () => {
  // §7.2 mapping table:
  //   upheld + worker        → release_to_worker
  //   upheld + delegator     → refund_to_delegator
  //   overturned + worker    → refund_to_delegator
  //   overturned + delegator → release_to_worker
  //   split                  → split (always)
  //
  // Legacy disputes (filer_role NULL) fall back to the v1 `split` shape;
  // the existing happy-path / tie / quorum-failure tests above cover that
  // branch by passing `filer_role: null` to the orchestrator.
  async function runWithFilerRole(
    disputeId: string,
    voteOutcome: DisputeOutcome,
    filerRole: "worker" | "delegator",
  ) {
    env = await setupOrchEnv(3);
    const policies = new Map(
      env.peers.map((p) => [p.identity.relayMotebitId, { vote: voteOutcome }]),
    );
    const fetchImpl = makeFetchImpl(env.peers, policies);
    const dispute = env.filePeerlessDispute(disputeId, filerRole);
    return orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: filerRole },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
  }

  it("upheld + worker → release_to_worker", async () => {
    const r = await runWithFilerRole("d-upheld-worker", "upheld", "worker");
    expect(r.resolution).toBe("upheld");
    expect(r.fund_action).toBe("release_to_worker");
    expect(r.split_ratio).toBe(1.0);
  });

  it("upheld + delegator → refund_to_delegator", async () => {
    const r = await runWithFilerRole("d-upheld-delegator", "upheld", "delegator");
    expect(r.resolution).toBe("upheld");
    expect(r.fund_action).toBe("refund_to_delegator");
    expect(r.split_ratio).toBe(0.0);
  });

  it("overturned + worker → refund_to_delegator", async () => {
    const r = await runWithFilerRole("d-overturned-worker", "overturned", "worker");
    expect(r.resolution).toBe("overturned");
    expect(r.fund_action).toBe("refund_to_delegator");
    expect(r.split_ratio).toBe(0.0);
  });

  it("overturned + delegator → release_to_worker", async () => {
    const r = await runWithFilerRole("d-overturned-delegator", "overturned", "delegator");
    expect(r.resolution).toBe("overturned");
    expect(r.fund_action).toBe("release_to_worker");
    expect(r.split_ratio).toBe(1.0);
  });

  it("split + any filer_role → split (no granular mapping)", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "overturned" as DisputeOutcome }],
      [env.peers[2]!.identity.relayMotebitId, { vote: "split" as DisputeOutcome }],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);
    const dispute = env.filePeerlessDispute("d-split-worker", "worker");
    const r = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: "worker" },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(r.resolution).toBe("split");
    expect(r.fund_action).toBe("split");
    expect(r.split_ratio).toBe(0.5);
  });
});

describe("orchestrateFederationResolution — §6.4 tie → split", () => {
  it("3 peers [upheld, overturned, split] → tie → resolution=split", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "overturned" as DisputeOutcome }],
      [env.peers[2]!.identity.relayMotebitId, { vote: "split" as DisputeOutcome }],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-tie");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );

    expect(result.resolution).toBe("split");
    expect(result.split_ratio).toBe(0.5);
  });
});

describe("orchestrateFederationResolution — §6.6 quorum failure", () => {
  it("0 peers active → 503 insufficient_federation_peers", async () => {
    env = await setupOrchEnv(0);
    const fetchImpl = makeFetchImpl([], new Map());

    const dispute = env.filePeerlessDispute("dispute-no-peers");
    await expect(
      orchestrateFederationResolution(
        { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
        1,
        { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
      ),
    ).rejects.toThrow(/insufficient_federation_peers/);
  });

  it("2 peers active → 503 insufficient_federation_peers (below ≥3 floor)", async () => {
    env = await setupOrchEnv(2);
    const policies = new Map(
      env.peers.map((p) => [p.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }]),
    );
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-2-peers");
    await expect(
      orchestrateFederationResolution(
        { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
        1,
        { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
      ),
    ).rejects.toThrow(/insufficient_federation_peers/);
  });

  it("3 peers but one times out → 2 valid → split fallback", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[2]!.identity.relayMotebitId, { fetchError: "ECONNREFUSED" }],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-1-timeout");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.resolution).toBe("split");
    expect(result.split_ratio).toBe(0.5);
    expect(result.rationale).toMatch(/quorum not met/);
    expect(result.adjudicator_votes).toHaveLength(2);
  });

  it("3 peers but one returns 501 policy_not_configured → 2 valid → split fallback", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[2]!.identity.relayMotebitId, { status: 501 }],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-1-501");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.resolution).toBe("split");
    expect(result.adjudicator_votes).toHaveLength(2);
  });
});

describe("orchestrateFederationResolution — invalid peer responses are dropped", () => {
  it("malformed body from one peer → that peer's vote not counted", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[2]!.identity.relayMotebitId, { malformed: true }],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-malformed");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.adjudicator_votes).toHaveLength(2);
    expect(result.resolution).toBe("split"); // <3 valid → quorum failure
  });

  it("bad signature from one peer → that peer's vote not counted (§6.5 forgery defense)", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [
        env.peers[2]!.identity.relayMotebitId,
        { vote: "upheld" as DisputeOutcome, badSignature: true },
      ],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-bad-sig");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.adjudicator_votes).toHaveLength(2);
  });

  it("round mismatch in response → that peer's vote not counted (§8.3 round-isolation defense)", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[2]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome, forceRound: 2 }],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-round-mismatch");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.adjudicator_votes).toHaveLength(2);
  });

  it("dispute_id mismatch in response → that peer's vote not counted", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [
        env.peers[2]!.identity.relayMotebitId,
        { vote: "upheld" as DisputeOutcome, forceDisputeId: "different-dispute" },
      ],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-id-mismatch");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.adjudicator_votes).toHaveLength(2);
  });
});

describe("orchestrateFederationResolution — defensive guards", () => {
  it("empty body_json → 503 legacy_dispute_no_signed_body (defensive; should not happen post-migration-18)", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map(
      env.peers.map((p) => [p.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }]),
    );
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-empty-body");
    await expect(
      orchestrateFederationResolution(
        { dispute_id: dispute.dispute_id, body_json: "", filer_role: null },
        1,
        {
          db: env.db,
          relayIdentity: env.leader,
          fetchImpl,
          voteRequestTimeoutMs: 5000,
        },
      ),
    ).rejects.toThrow(/legacy_dispute_no_signed_body/);
  });
});

describe("orchestrateFederationResolution — additional gate-coverage", () => {
  it("all 3 peers return 501 policy_not_configured → 0 valid votes → split fallback", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map(env.peers.map((p) => [p.identity.relayMotebitId, { status: 501 }]));
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-all-501");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.resolution).toBe("split");
    expect(result.split_ratio).toBe(0.5);
    expect(result.adjudicator_votes).toHaveLength(0);
    expect(result.rationale).toMatch(/quorum not met/);
  });

  it("peer_id mismatch in response → that peer's vote not counted (impersonation defense)", async () => {
    env = await setupOrchEnv(3);
    // Peer 2 claims to be peer 0's id — leader's response-side check
    // (vote.peer_id !== peer.peer_relay_id) rejects it.
    const policies = new Map([
      [env.peers[0]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [env.peers[1]!.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }],
      [
        env.peers[2]!.identity.relayMotebitId,
        {
          vote: "upheld" as DisputeOutcome,
          forcePeerId: env.peers[0]!.identity.relayMotebitId,
        },
      ],
    ]);
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-peer-id-mismatch");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(result.adjudicator_votes).toHaveLength(2);
    expect(result.resolution).toBe("split"); // <3 valid → quorum failure
  });

  it("self-row in relay_peers is excluded from fan-out (§6.5 SQL self-exclusion)", async () => {
    env = await setupOrchEnv(3);
    // Inject a self-row corruption: leader's own id appears in
    // relay_peers as if it were a peer. The orchestrator's
    // `WHERE peer_relay_id != self` filter MUST exclude it.
    env.db
      .prepare(
        `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, missed_heartbeats, agent_count, trust_score, peered_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, 'active', 0, 0, 0.5, ?, ?)`,
      )
      .run(
        env.leader.relayMotebitId, // SELF
        env.leader.publicKeyHex,
        "http://leader-self-row.test",
        "leader-self",
        Date.now(),
        Date.now(),
      );

    const policies = new Map(
      env.peers.map((p) => [p.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }]),
    );
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-self-exclusion");
    const result = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    // Only the 3 real peers voted; self-row was excluded at the SQL filter
    // (otherwise we'd see 4 votes or a fetch error against the bogus
    // self-row endpoint).
    expect(result.adjudicator_votes).toHaveLength(3);
    expect(result.adjudicator_votes.every((v) => v.peer_id !== env.leader.relayMotebitId)).toBe(
      true,
    );
  });

  it("orchestrator is idempotent on re-run — votes upsert via ON CONFLICT, aggregation deterministic", async () => {
    env = await setupOrchEnv(3);
    const policies = new Map(
      env.peers.map((p) => [p.identity.relayMotebitId, { vote: "upheld" as DisputeOutcome }]),
    );
    const fetchImpl = makeFetchImpl(env.peers, policies);

    const dispute = env.filePeerlessDispute("dispute-idempotent");
    const r1 = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    const r2 = await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );
    expect(r1.resolution).toBe(r2.resolution);
    expect(r1.adjudicator_votes).toHaveLength(3);
    expect(r2.adjudicator_votes).toHaveLength(3);
    // ON CONFLICT(dispute_id, round, peer_id) DO UPDATE → still 3 rows
    const persisted = env.db
      .prepare("SELECT COUNT(*) as n FROM relay_dispute_votes WHERE dispute_id = ? AND round = ?")
      .get(dispute.dispute_id, 1) as { n: number };
    expect(persisted.n).toBe(3);
  });
});

describe("orchestrateFederationResolution — evidence_bundle envelope shape (§5.4 + migration 20)", () => {
  it("populated bundle: each item is a structurally-complete DisputeEvidence (signature + suite reconstructed from stored columns; peers can verify)", async () => {
    // Spec contract: per §8.3 the peer's vote callback receives the
    // evidence bundle and "decides afresh"; per §5.4 each item MUST
    // be cryptographically verifiable. Pre-migration-20 the bundle
    // items shipped by the orchestrator were inner-data-only — peers
    // could not verify because envelope fields (signature, suite,
    // evidence_type) were absent.
    //
    // Discipline lesson: empty-collection cases are not coverage of
    // collection-of-T's element-shape contract. Existing federation
    // tests submit zero evidence so the bundle is always [], which
    // let the structural-shape lie ship undetected through commits
    // 1 → 5 + commit 4b. Tests on collection-of-T fields MUST
    // populate the collection with at least one element and assert
    // on T's full shape — not just length / pass-through plumbing.
    env = await setupOrchEnv(3);
    const dispute = env.filePeerlessDispute("dispute-bundle-shape");

    // Submit one evidence row through the same INSERT shape the
    // /evidence handler uses (post-migration-20 columns).
    const submitterKp = await generateKeypair();
    const evidence = await signDisputeEvidence(
      {
        dispute_id: dispute.dispute_id,
        submitted_by: dispute.filed_by,
        evidence_type: "execution_receipt",
        evidence_data: { receipt_hash: "abc123" },
        description: "round-1 evidence — element-shape probe",
        submitted_at: Date.now(),
      },
      submitterKp.privateKey,
    );
    env.db
      .prepare(
        "INSERT INTO relay_dispute_evidence (evidence_id, dispute_id, submitted_by, evidence_type, evidence_data, description, submitted_at, signature, suite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "evi-shape-001",
        evidence.dispute_id,
        evidence.submitted_by,
        evidence.evidence_type,
        JSON.stringify(evidence.evidence_data),
        evidence.description,
        evidence.submitted_at,
        evidence.signature,
        evidence.suite,
      );

    // Capture the VoteRequest body the orchestrator sends to peers.
    let capturedBody: VoteRequest | undefined;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const peer = env.peers.find((p) => url.startsWith(p.endpointUrl));
      if (!peer) throw new Error(`unrouted url: ${url}`);
      const body = JSON.parse(init!.body as string) as VoteRequest;
      if (capturedBody === undefined) capturedBody = body;
      const signed = await signAdjudicatorVote(
        {
          dispute_id: body.dispute_id,
          round: body.round,
          peer_id: peer.identity.relayMotebitId,
          vote: "upheld" as DisputeOutcome,
          rationale: `peer ${peer.identity.relayMotebitId} upheld`,
        },
        peer.identity.privateKey,
      );
      return new Response(JSON.stringify(signed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await orchestrateFederationResolution(
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute), filer_role: null },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.evidence_bundle).toHaveLength(1);
    const item = capturedBody!.evidence_bundle[0]!;

    // Element-shape contract per §5.2 wire format
    expect(item.dispute_id).toBe(evidence.dispute_id);
    expect(item.submitted_by).toBe(evidence.submitted_by);
    expect(item.evidence_type).toBe("execution_receipt");
    expect(item.evidence_data).toEqual({ receipt_hash: "abc123" });
    expect(item.description).toBe(evidence.description);
    expect(item.submitted_at).toBe(evidence.submitted_at);
    expect(item.suite).toBe(evidence.suite);
    expect(item.signature).toBe(evidence.signature);

    // §5.4 cryptographic-verifiability: a peer can re-verify the
    // envelope using the submitter's public key. This is the
    // load-bearing property the migration enables.
    const verified = await verifyDisputeEvidence(item, submitterKp.publicKey);
    expect(verified).toBe(true);
  });
});

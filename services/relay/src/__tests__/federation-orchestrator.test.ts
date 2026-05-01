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
import { generateKeypair, bytesToHex } from "@motebit/encryption";
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
  /** Insert a dispute row (the leader is filed_by; respondent is some external motebit). */
  filePeerlessDispute: (disputeId: string) => DisputeRequest;
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

  function filePeerlessDispute(disputeId: string): DisputeRequest {
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
       (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline, body_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence', 0, 0, ?, ?, ?)`,
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
      1,
      { db: env.db, relayIdentity: env.leader, fetchImpl, voteRequestTimeoutMs: 5000 },
    );

    expect(result.resolution).toBe("overturned");
    expect(result.split_ratio).toBe(0.0);
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
        { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
        { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      { dispute_id: dispute.dispute_id, body_json: JSON.stringify(dispute) },
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
      orchestrateFederationResolution({ dispute_id: dispute.dispute_id, body_json: "" }, 1, {
        db: env.db,
        relayIdentity: env.leader,
        fetchImpl,
        voteRequestTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/legacy_dispute_no_signed_body/);
  });
});

/**
 * Phase 6.2 — peer-side vote-request handler tests.
 *
 * Covers the six fail-closed gates defined in
 * `spec/relay-federation-v1.md` §16.2 plus the happy path:
 *
 *   1. Schema validation (400 schema_invalid)
 *   2. Known peer (403 unknown_peer)
 *   3. Requester-id binding (collapses into gate 2 in v1; doctrinally separate)
 *   4. Signature verify (403 signature_invalid)
 *   5. Freshness (400 request_stale)
 *   6. Operator policy configured (501 policy_not_configured)
 *
 * Plus:
 *   - Happy path: voteCallback wired → signed AdjudicatorVote returned
 *   - Round-binding property: same evidence, different round → different signature
 *     (cryptographic enforcement of §8.3 round isolation; the §6.5 + §8.3
 *     "votes are not portable across rounds" foundation law).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, sign, canonicalJson, bytesToHex, toBase64Url } from "@motebit/encryption";
import type { DisputeOutcome, DisputeRequest, VoteRequest } from "@motebit/protocol";
import {
  registerFederationRoutes,
  createFederationTables,
  type RelayIdentity,
} from "../federation.js";

interface TestSetup {
  app: Hono;
  db: DatabaseDriver;
  peerRelay: RelayIdentity;
  leaderRelay: RelayIdentity;
}

async function makeIdentity(): Promise<RelayIdentity> {
  const kp = await generateKeypair();
  return {
    relayMotebitId: `relay-${crypto.randomUUID()}`,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
    did: `did:key:test-${bytesToHex(kp.publicKey).slice(0, 8)}`,
  };
}

async function setup(opts: {
  voteCallback?: (req: VoteRequest) => { vote: DisputeOutcome; rationale: string };
}): Promise<TestSetup> {
  const app = new Hono();
  const moteDb = await openMotebitDatabase(":memory:");
  const db = moteDb.db;
  createFederationTables(db);

  const peerRelay = await makeIdentity();
  const leaderRelay = await makeIdentity();

  // Insert leaderRelay as an active peer in peerRelay's view so gate 2 passes.
  db.prepare(
    `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, missed_heartbeats, agent_count, trust_score, peered_at, last_heartbeat_at)
     VALUES (?, ?, ?, ?, 'active', 0, 0, 0.5, ?, ?)`,
  ).run(
    leaderRelay.relayMotebitId,
    leaderRelay.publicKeyHex,
    "http://leader.test",
    "leader",
    Date.now(),
    Date.now(),
  );

  registerFederationRoutes({
    db,
    app,
    relayIdentity: peerRelay,
    federationConfig: { endpointUrl: "http://peer.test" },
    federationQueryCache: new Map(),
    queryLocalAgents: () => [],
    onTaskForwarded: () => ({ status: "rejected", reason: "test stub" }),
    onTaskResultReceived: async () => {},
    onSettlementReceived: () => ({ feeAmount: 0, netAmount: 0 }),
    voteCallback: opts.voteCallback,
  });

  return { app, db, peerRelay, leaderRelay };
}

async function buildSignedVoteRequest(
  leaderRelay: RelayIdentity,
  override: Partial<VoteRequest> = {},
): Promise<VoteRequest> {
  const disputeId = override.dispute_id ?? `dispute-${crypto.randomUUID().slice(0, 8)}`;

  const disputeRequest: DisputeRequest = {
    dispute_id: disputeId,
    task_id: "task-1",
    allocation_id: "alloc-1",
    filed_by: "motebit-filer",
    respondent: "motebit-respondent",
    category: "quality",
    description: "test dispute",
    evidence_refs: ["receipt-abc"],
    filed_at: Date.now(),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "stub-sig-not-verified-by-peer-side",
  };

  const body: Omit<VoteRequest, "signature"> = {
    dispute_id: disputeId,
    round: 1,
    dispute_request: disputeRequest,
    evidence_bundle: [],
    requester_id: leaderRelay.relayMotebitId,
    requested_at: Date.now(),
    suite: "motebit-jcs-ed25519-b64-v1",
    ...override,
  };

  const canonical = canonicalJson(body);
  const sigBytes = await sign(new TextEncoder().encode(canonical), leaderRelay.privateKey);
  // VoteRequest suite is `motebit-jcs-ed25519-b64-v1` — base64url
  // signature encoding (peer-side gate-4 verify uses fromBase64Url).
  return { ...body, signature: toBase64Url(sigBytes) };
}

let env: TestSetup;

afterEach(() => {
  env?.db?.close();
});

describe("POST /federation/v1/disputes/:disputeId/vote-request — gate ladder", () => {
  describe("gate 1: schema validation", () => {
    beforeEach(async () => {
      env = await setup({ voteCallback: () => ({ vote: "split", rationale: "test" }) });
    });

    it("rejects malformed body with 400 schema_invalid", async () => {
      const res = await env.app.request("/federation/v1/disputes/d-1/vote-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ not: "a vote request" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("schema_invalid");
    });

    it("rejects URL/body dispute_id mismatch with 400 schema_invalid", async () => {
      const req = await buildSignedVoteRequest(env.leaderRelay, { dispute_id: "body-id" });
      const res = await env.app.request("/federation/v1/disputes/url-id/vote-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error_code: string; message: string };
      expect(body.error_code).toBe("schema_invalid");
      expect(body.message).toContain("URL :disputeId");
    });
  });

  describe("gate 2: known peer", () => {
    beforeEach(async () => {
      env = await setup({ voteCallback: () => ({ vote: "split", rationale: "test" }) });
    });

    it("rejects unknown requester_id with 403 unknown_peer", async () => {
      const stranger = await makeIdentity();
      const req = await buildSignedVoteRequest(stranger);
      const res = await env.app.request(`/federation/v1/disputes/${req.dispute_id}/vote-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("unknown_peer");
    });
  });

  describe("gate 4: signature verify", () => {
    beforeEach(async () => {
      env = await setup({ voteCallback: () => ({ vote: "split", rationale: "test" }) });
    });

    it("rejects bad signature with 403 signature_invalid", async () => {
      const req = await buildSignedVoteRequest(env.leaderRelay);
      // Tamper: replace signature with random hex of correct length
      const tampered: VoteRequest = { ...req, signature: "00".repeat(64) };
      const res = await env.app.request(`/federation/v1/disputes/${req.dispute_id}/vote-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tampered),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("signature_invalid");
    });
  });

  describe("gate 5: freshness", () => {
    beforeEach(async () => {
      env = await setup({ voteCallback: () => ({ vote: "split", rationale: "test" }) });
    });

    it("rejects stale requested_at (>60s old) with 400 request_stale", async () => {
      const req = await buildSignedVoteRequest(env.leaderRelay, {
        requested_at: Date.now() - 120_000,
      });
      const res = await env.app.request(`/federation/v1/disputes/${req.dispute_id}/vote-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("request_stale");
    });

    it("rejects future-dated requested_at (>60s in future) with 400 request_stale", async () => {
      const req = await buildSignedVoteRequest(env.leaderRelay, {
        requested_at: Date.now() + 120_000,
      });
      const res = await env.app.request(`/federation/v1/disputes/${req.dispute_id}/vote-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("request_stale");
    });
  });

  describe("gate 6: operator policy configured", () => {
    beforeEach(async () => {
      env = await setup({ voteCallback: undefined });
    });

    it("rejects with 501 policy_not_configured when no voteCallback wired", async () => {
      const req = await buildSignedVoteRequest(env.leaderRelay);
      const res = await env.app.request(`/federation/v1/disputes/${req.dispute_id}/vote-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("policy_not_configured");
    });

    it("identity reports vote_policy_configured: false when no callback wired", async () => {
      const res = await env.app.request("/federation/v1/identity");
      const id = (await res.json()) as { vote_policy_configured: boolean };
      expect(id.vote_policy_configured).toBe(false);
    });
  });
});

describe("POST /federation/v1/disputes/:disputeId/vote-request — happy path", () => {
  beforeEach(async () => {
    env = await setup({
      voteCallback: () => ({ vote: "upheld", rationale: "test policy upheld the filer" }),
    });
  });

  it("returns signed AdjudicatorVote with correct shape", async () => {
    const req = await buildSignedVoteRequest(env.leaderRelay);
    const res = await env.app.request(`/federation/v1/disputes/${req.dispute_id}/vote-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    expect(res.status).toBe(200);
    const vote = (await res.json()) as {
      dispute_id: string;
      round: number;
      peer_id: string;
      vote: string;
      rationale: string;
      suite: string;
      signature: string;
    };
    expect(vote.dispute_id).toBe(req.dispute_id);
    expect(vote.round).toBe(1);
    expect(vote.peer_id).toBe(env.peerRelay.relayMotebitId);
    expect(vote.vote).toBe("upheld");
    expect(vote.rationale).toBe("test policy upheld the filer");
    expect(vote.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(vote.signature).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
  });

  it("identity reports vote_policy_configured: true when callback wired", async () => {
    const res = await env.app.request("/federation/v1/identity");
    const id = (await res.json()) as { vote_policy_configured: boolean };
    expect(id.vote_policy_configured).toBe(true);
  });
});

describe("§8.3 round-binding — same evidence, different round = different signature", () => {
  beforeEach(async () => {
    env = await setup({
      voteCallback: () => ({ vote: "upheld", rationale: "stable" }),
    });
  });

  it("round=1 and round=2 votes for the same dispute have different signatures", async () => {
    const disputeId = `dispute-${crypto.randomUUID().slice(0, 8)}`;

    const req1 = await buildSignedVoteRequest(env.leaderRelay, { dispute_id: disputeId, round: 1 });
    const res1 = await env.app.request(`/federation/v1/disputes/${disputeId}/vote-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req1),
    });
    expect(res1.status).toBe(200);
    const vote1 = (await res1.json()) as { signature: string; round: number };

    const req2 = await buildSignedVoteRequest(env.leaderRelay, { dispute_id: disputeId, round: 2 });
    const res2 = await env.app.request(`/federation/v1/disputes/${disputeId}/vote-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req2),
    });
    expect(res2.status).toBe(200);
    const vote2 = (await res2.json()) as { signature: string; round: number };

    // Round binding: signature includes round, so even with same evidence
    // the signatures differ. This is the cryptographic enforcement of
    // §8.3 round isolation.
    expect(vote1.round).toBe(1);
    expect(vote2.round).toBe(2);
    expect(vote1.signature).not.toBe(vote2.signature);
  });
});

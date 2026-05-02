/**
 * Phase 6.2 — federation appeal handler tests (commit 4b).
 *
 * Covers the §8.3 appeal-adjudication flow wired into the existing
 * /api/v1/disputes/:disputeId/appeal handler. When a dispute is on
 * the federation path (relay is filer or respondent), the appeal
 * handler triggers round-2 orchestration: fan out a VoteRequest with
 * `round: 2` to active peers, verify their AdjudicatorVotes, persist
 * to `relay_dispute_votes` with round=2 (round-1 votes preserved),
 * sign a round-2 DisputeResolution (alongside the round-1 row via
 * `UNIQUE(dispute_id, round)` from migration 19), atomic-transition
 * `appealed → final` + execute fund_action.
 *
 * Round-isolation cryptographic property is exercised by:
 *   - packages/crypto/src/__tests__/verify-artifacts.test.ts
 *     "signature binds to round" test (commit 2)
 *   - federation-orchestrator.test.ts "round mismatch in response →
 *     vote dropped" test (commit 3)
 *
 * Round-2 evidence (§8.3 + §8.5): /evidence accepts submissions in
 * {opened, evidence, resolved} states. Post-`resolved` submissions
 * are bounded by the §8.5 appeal window (24h after `resolved_at`);
 * once `appealed`, round-2 orchestration is in flight and the bundle
 * freezes. Round-2 vote-requests carry the union of round-1 +
 * post-`resolved` evidence — the orchestrator at line 529 reads
 * `WHERE dispute_id = ?` with no round filter, so the union happens
 * automatically once new rows land in the same table.
 *
 * The round-2-evidence-union test below exercises this path
 * end-to-end (resolved → submit post-resolved evidence → file appeal
 * → assert peer received union in VoteRequest.evidence_bundle).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  generateKeypair,
  bytesToHex,
  signDisputeRequest,
  signDisputeAppeal,
} from "@motebit/encryption";
import { signAdjudicatorVote } from "@motebit/crypto";
import { signDisputeEvidence } from "@motebit/encryption";
import type {
  DisputeOutcome,
  DisputeRequest,
  DisputeAppeal,
  DisputeEvidence,
  VoteRequest,
} from "@motebit/protocol";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

interface PeerSetup {
  relayMotebitId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
  endpointUrl: string;
}

async function makePeer(label: string): Promise<PeerSetup> {
  const kp = await generateKeypair();
  const id = `relay-${label}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    relayMotebitId: id,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
    endpointUrl: `http://${label}.test`,
  };
}

async function insertPeer(relay: SyncRelay, peer: PeerSetup): Promise<void> {
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, missed_heartbeats, agent_count, trust_score, peered_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, 'active', 0, 0, 0.5, ?, ?)`,
    )
    .run(
      peer.relayMotebitId,
      peer.publicKeyHex,
      peer.endpointUrl,
      `peer-${peer.relayMotebitId.slice(0, 8)}`,
      Date.now(),
      Date.now(),
    );
}

/**
 * Stub global fetch to route /federation/v1/disputes/:disputeId/vote-request
 * calls to canned signed AdjudicatorVote responses, keyed by the
 * peer's endpoint URL + the request's round number.
 */
function stubPeerFetch(peers: PeerSetup[], votesByRound: Map<number, DisputeOutcome>): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const peer = peers.find((p) => url.startsWith(p.endpointUrl));
    if (!peer) throw new Error(`unrouted url: ${url}`);

    const body = JSON.parse(init!.body as string) as VoteRequest;
    const vote = votesByRound.get(body.round);
    if (vote === undefined) {
      throw new Error(`no canned vote for round ${body.round}`);
    }

    const signed = await signAdjudicatorVote(
      {
        dispute_id: body.dispute_id,
        round: body.round,
        peer_id: peer.relayMotebitId,
        vote,
        rationale: `peer ${peer.relayMotebitId.slice(0, 8)} round ${body.round} vote`,
      },
      peer.privateKey,
    );
    return new Response(JSON.stringify(signed), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

let relay: SyncRelay;
let peers: PeerSetup[];
let agentKeys: Map<string, { publicKey: Uint8Array; privateKey: Uint8Array }>;

beforeEach(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
  agentKeys = new Map();
  // Register the dispute parties as agents
  for (const id of ["del-fa", "wrk-fa"]) {
    const kp = await generateKeypair();
    agentKeys.set(id, kp);
    await relay.app.request(`/api/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: id,
        public_key: bytesToHex(kp.publicKey),
        endpoint_url: `https://${id}.test`,
        capabilities: ["test"],
      }),
    });
  }
  // Insert 3 federation peers so orchestrator quorum (≥3) is met
  peers = [];
  for (let i = 0; i < 3; i++) {
    const p = await makePeer(`peer${i}`);
    await insertPeer(relay, p);
    peers.push(p);
  }
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await relay.close();
});

describe("Federation appeal: §8.3 round-binding cryptographic isolation", () => {
  it("round-1 vote signature does NOT verify when reattributed to round 2 (round-binding replay defense)", async () => {
    // Daniel's design hint, made grep-discoverable: the named
    // property "round-1 vote can't be replayed as round-2" is
    // load-bearing for §8.3 round isolation. The cryptographic
    // binding holds at the verifyAdjudicatorVote layer (signature
    // covers `round` per §6.5 + §8.3), but a focused, named test
    // here lets future readers grep for the property by intent.
    //
    // Sibling coverage:
    //   - packages/crypto/src/__tests__/verify-artifacts.test.ts
    //     "signature binds to round" (commit 2)
    //   - federation-orchestrator.test.ts "round mismatch in
    //     response → vote dropped" (commit 3)
    const peerKp = await generateKeypair();
    const round1Vote = await signAdjudicatorVote(
      {
        dispute_id: "dispute-replay-test",
        round: 1,
        peer_id: "peer-replay",
        vote: "upheld" as DisputeOutcome,
        rationale: "round 1 vote",
      },
      peerKp.privateKey,
    );

    // Mutate the round to 2 — the signed canonical body still says
    // round 1, so verify-against-round-2-bytes fails.
    const replayedAsRound2 = { ...round1Vote, round: 2 };
    const { verifyAdjudicatorVote } = await import("@motebit/crypto");
    const valid = await verifyAdjudicatorVote(replayedAsRound2, peerKp.publicKey);
    expect(valid).toBe(false);
  });
});

describe("Federation appeal: round-2 quorum failure", () => {
  it("round-2 fan-out → all peers return 501 → split fallback (parity with round-1 quorum-failure coverage)", async () => {
    // Round 1: peers vote upheld (success)
    // Round 2: peers all 501 → 0 valid votes → split fallback per §6.6
    stubPeerFetch(peers, new Map<number, DisputeOutcome>([[1, "upheld"]]));
    // Override the round-2 path: replace stub with one that 501s for round 2
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const peer = peers.find((p) => url.startsWith(p.endpointUrl));
      if (!peer) throw new Error(`unrouted url: ${url}`);
      const body = JSON.parse(init!.body as string) as VoteRequest;
      if (body.round === 1) {
        const signed = await signAdjudicatorVote(
          {
            dispute_id: body.dispute_id,
            round: 1,
            peer_id: peer.relayMotebitId,
            vote: "upheld",
            rationale: "round 1",
          },
          peer.privateKey,
        );
        return new Response(JSON.stringify(signed), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Round 2: all peers 501 policy_not_configured
      return new Response(
        JSON.stringify({ error_code: "policy_not_configured", message: "test" }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    });

    const relayMotebitId = relay.relayIdentity.relayMotebitId;
    const allocId = "alloc-r2qf";
    const taskId = "task-r2qf";
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, 100000, 'settled', ?)",
      )
      .run(allocId, taskId, "del-fa", Date.now());

    const delPriv = agentKeys.get("del-fa")!.privateKey;
    const disputeId = `dispute-r2qf-${crypto.randomUUID().slice(0, 8)}`;
    const disputeReq: DisputeRequest = await signDisputeRequest(
      {
        dispute_id: disputeId,
        task_id: taskId,
        allocation_id: allocId,
        filed_by: "del-fa",
        respondent: relayMotebitId,
        category: "quality",
        description: "test",
        evidence_refs: ["x"],
        filed_at: Date.now(),
      },
      delPriv,
    );
    await relay.app.request(`/api/v1/allocations/${allocId}/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(disputeReq),
    });
    await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "ignored",
        fund_action: "release_to_worker",
      }),
    });

    const appeal = await signDisputeAppeal(
      {
        dispute_id: disputeId,
        appealed_by: "del-fa",
        reason: "appeal",
        appealed_at: Date.now(),
      },
      delPriv,
    );
    const res = await relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(appeal),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      resolution: DisputeOutcome;
      split_ratio: number;
      adjudicator_votes: Array<unknown>;
    };
    // §6.6 quorum-failure fallback: 0 valid round-2 votes → split, 0.5
    expect(body.state).toBe("final");
    expect(body.resolution).toBe("split");
    expect(body.split_ratio).toBe(0.5);
    expect(body.adjudicator_votes).toHaveLength(0);
  });
});

describe("Federation appeal: round-1 resolved → /appeal → round-2 → final", () => {
  it("happy path: round-2 majority `overturned` → state=final, fund_action executes, round-1 votes preserved", async () => {
    // Round 1: peers vote `upheld` (filer wins).
    // Round 2: peers vote `overturned` (filer loses on appeal).
    stubPeerFetch(
      peers,
      new Map<number, DisputeOutcome>([
        [1, "upheld"],
        [2, "overturned"],
      ]),
    );

    // Set up a dispute where the relay is the respondent → federation path
    const relayMotebitId = relay.relayIdentity.relayMotebitId;
    const allocId = "alloc-fa";
    const taskId = "task-fa";
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, 100000, 'settled', ?)",
      )
      .run(allocId, taskId, "del-fa", Date.now());

    // File the dispute via the real /api/v1/allocations/:allocationId/dispute endpoint
    // so body_json is persisted (migration 18 requirement).
    const delPriv = agentKeys.get("del-fa")!.privateKey;
    const disputeId = `dispute-fa-${crypto.randomUUID().slice(0, 8)}`;
    const disputeReq: DisputeRequest = await signDisputeRequest(
      {
        dispute_id: disputeId,
        task_id: taskId,
        allocation_id: allocId,
        filed_by: "del-fa",
        respondent: relayMotebitId, // RELAY is respondent → federation path
        category: "quality",
        description: "test federation appeal",
        evidence_refs: ["receipt-x"],
        filed_at: Date.now(),
      },
      delPriv,
    );
    const fileRes = await relay.app.request(`/api/v1/allocations/${allocId}/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(disputeReq),
    });
    expect(fileRes.status).toBe(200);

    // Round-1 resolve: federation orchestrator runs, peers vote `upheld`,
    // resolution is signed + persisted, state → resolved.
    const resolveRes = await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld", // ignored on federation path; orchestrator decides
        rationale: "ignored",
        fund_action: "release_to_worker",
      }),
    });
    expect(resolveRes.status).toBe(200);
    const round1Body = (await resolveRes.json()) as {
      resolution: DisputeOutcome;
      adjudicator_votes: Array<{ vote: string; round: number }>;
    };
    expect(round1Body.resolution).toBe("upheld");
    expect(round1Body.adjudicator_votes).toHaveLength(3);
    expect(round1Body.adjudicator_votes.every((v) => v.round === 1)).toBe(true);

    // Funds NOT moved yet (per §7.1+§7.3 commit 4a) — state is `resolved`.
    const stateAfterResolve = relay.moteDb.db
      .prepare("SELECT state FROM relay_disputes WHERE dispute_id = ?")
      .get(disputeId) as { state: string };
    expect(stateAfterResolve.state).toBe("resolved");

    // File the appeal
    const appeal: DisputeAppeal = await signDisputeAppeal(
      {
        dispute_id: disputeId,
        appealed_by: "del-fa",
        reason: "Round 1 was wrong",
        appealed_at: Date.now(),
      },
      delPriv,
    );
    const appealRes = await relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(appeal),
    });
    expect(appealRes.status).toBe(200);
    const appealBody = (await appealRes.json()) as {
      state: string;
      resolution: DisputeOutcome;
      adjudicator_votes: Array<{ vote: string; round: number }>;
      final_at: number;
    };
    // §8.3 Round 2 outcome: peers voted `overturned` → resolution flips
    expect(appealBody.state).toBe("final");
    expect(appealBody.resolution).toBe("overturned");
    expect(appealBody.adjudicator_votes).toHaveLength(3);
    expect(appealBody.adjudicator_votes.every((v) => v.round === 2)).toBe(true);
    expect(appealBody.final_at).toBeGreaterThan(0);

    // Round-1 votes preserved in relay_dispute_votes (audit trail intact)
    const round1Votes = relay.moteDb.db
      .prepare("SELECT vote FROM relay_dispute_votes WHERE dispute_id = ? AND round = 1")
      .all(disputeId) as Array<{ vote: string }>;
    expect(round1Votes).toHaveLength(3);
    expect(round1Votes.every((v) => v.vote === "upheld")).toBe(true);

    // Round-2 votes persisted alongside round-1 (PK on (dispute_id, round, peer_id))
    const round2Votes = relay.moteDb.db
      .prepare("SELECT vote FROM relay_dispute_votes WHERE dispute_id = ? AND round = 2")
      .all(disputeId) as Array<{ vote: string }>;
    expect(round2Votes).toHaveLength(3);
    expect(round2Votes.every((v) => v.vote === "overturned")).toBe(true);

    // Both round-1 and round-2 resolution rows preserved per UNIQUE(dispute_id, round)
    // from migration 19 — round-2 doesn't overwrite round-1's signed audit row.
    const resolutionRows = relay.moteDb.db
      .prepare(
        "SELECT round, resolution FROM relay_dispute_resolutions WHERE dispute_id = ? ORDER BY round ASC",
      )
      .all(disputeId) as Array<{ round: number; resolution: string }>;
    expect(resolutionRows).toHaveLength(2);
    expect(resolutionRows[0]).toEqual({ round: 1, resolution: "upheld" });
    expect(resolutionRows[1]).toEqual({ round: 2, resolution: "overturned" });

    // §7.1 + §7.3 + §8.4: fund_action executes on transition to `final`.
    // round-2 verdict was `overturned` → split_ratio = 0.0 (delegator wins).
    const stateFinal = relay.moteDb.db
      .prepare("SELECT state, resolution, split_ratio FROM relay_disputes WHERE dispute_id = ?")
      .get(disputeId) as { state: string; resolution: string; split_ratio: number };
    expect(stateFinal.state).toBe("final");
    expect(stateFinal.resolution).toBe("overturned");
    expect(stateFinal.split_ratio).toBe(0.0);

    // Delegator received the refund (split_ratio=0 → all to delegator)
    const delTxn = relay.moteDb.db
      .prepare(
        "SELECT amount FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit' AND reference_id = ?",
      )
      .get("del-fa", disputeId) as { amount: number } | undefined;
    expect(delTxn?.amount).toBe(100000);
  });
});

describe("Federation appeal: round-2 evidence union (§8.3 + §8.5)", () => {
  it("post-resolved evidence accepted; round-2 VoteRequest carries union of round-1 + post-resolved bundles", async () => {
    // Capture the first VoteRequest body per round so we can assert on
    // round-2 evidence_bundle. The orchestrator sends the same bundle
    // to every peer in a fan-out, so capturing the first is sufficient.
    const voteRequestsByRound = new Map<number, VoteRequest>();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const peer = peers.find((p) => url.startsWith(p.endpointUrl));
      if (!peer) throw new Error(`unrouted url: ${url}`);
      const body = JSON.parse(init!.body as string) as VoteRequest;
      if (!voteRequestsByRound.has(body.round)) {
        voteRequestsByRound.set(body.round, body);
      }
      const vote: DisputeOutcome = body.round === 1 ? "upheld" : "overturned";
      const signed = await signAdjudicatorVote(
        {
          dispute_id: body.dispute_id,
          round: body.round,
          peer_id: peer.relayMotebitId,
          vote,
          rationale: `peer ${peer.relayMotebitId.slice(0, 8)} round ${body.round}`,
        },
        peer.privateKey,
      );
      return new Response(JSON.stringify(signed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const relayMotebitId = relay.relayIdentity.relayMotebitId;
    const allocId = "alloc-evid-union";
    const taskId = "task-evid-union";
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, 100000, 'settled', ?)",
      )
      .run(allocId, taskId, "del-fa", Date.now());

    const delPriv = agentKeys.get("del-fa")!.privateKey;
    const disputeId = `dispute-evid-union-${crypto.randomUUID().slice(0, 8)}`;
    const disputeReq: DisputeRequest = await signDisputeRequest(
      {
        dispute_id: disputeId,
        task_id: taskId,
        allocation_id: allocId,
        filed_by: "del-fa",
        respondent: relayMotebitId,
        category: "quality",
        description: "evidence union test",
        evidence_refs: ["x"],
        filed_at: Date.now(),
      },
      delPriv,
    );
    await relay.app.request(`/api/v1/allocations/${allocId}/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(disputeReq),
    });

    // Round-1 evidence: submitted while in `evidence` state (§5.3).
    const round1Evidence: DisputeEvidence = await signDisputeEvidence(
      {
        dispute_id: disputeId,
        submitted_by: "del-fa",
        evidence_type: "execution_receipt",
        evidence_data: { round1: "claim" },
        description: "round-1 evidence",
        submitted_at: Date.now(),
      },
      delPriv,
    );
    const r1EvRes = await relay.app.request(`/api/v1/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(round1Evidence),
    });
    expect(r1EvRes.status).toBe(200);

    // Round-1 resolve → state becomes `resolved`, round-1 votes captured.
    await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "ignored",
        fund_action: "release_to_worker",
      }),
    });
    const stateAfterResolve = relay.moteDb.db
      .prepare("SELECT state FROM relay_disputes WHERE dispute_id = ?")
      .get(disputeId) as { state: string };
    expect(stateAfterResolve.state).toBe("resolved");

    // Post-resolved evidence: the new path under test. Submitted while
    // the dispute is in `resolved` state, before /appeal is filed.
    const postResolvedEvidence: DisputeEvidence = await signDisputeEvidence(
      {
        dispute_id: disputeId,
        submitted_by: "del-fa",
        evidence_type: "credential",
        evidence_data: { postResolved: "newClaim" },
        description: "post-resolved evidence introduced with appeal",
        submitted_at: Date.now(),
      },
      delPriv,
    );
    const r2EvRes = await relay.app.request(`/api/v1/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(postResolvedEvidence),
    });
    expect(r2EvRes.status).toBe(200);

    // File appeal → triggers round-2 orchestration. The orchestrator
    // SELECTs all rows from relay_dispute_evidence WHERE dispute_id = ?
    // (no round filter), so the bundle is the union automatically.
    const appeal: DisputeAppeal = await signDisputeAppeal(
      {
        dispute_id: disputeId,
        appealed_by: "del-fa",
        reason: "round 1 missed the new evidence",
        appealed_at: Date.now(),
      },
      delPriv,
    );
    const appealRes = await relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(appeal),
    });
    expect(appealRes.status).toBe(200);

    // Round-1 VoteRequest carried only round-1 evidence
    const r1Body = voteRequestsByRound.get(1);
    expect(r1Body).toBeDefined();
    expect(r1Body!.evidence_bundle).toHaveLength(1);
    expect(r1Body!.evidence_bundle[0].evidence_type).toBe("execution_receipt");

    // Round-2 VoteRequest carried the union: round-1 + post-resolved
    const r2Body = voteRequestsByRound.get(2);
    expect(r2Body).toBeDefined();
    expect(r2Body!.evidence_bundle).toHaveLength(2);
    const types = r2Body!.evidence_bundle.map((e) => e.evidence_type).sort();
    expect(types).toEqual(["credential", "execution_receipt"]);
  });

  it("post-`appealed` evidence rejected — bundle freezes once round-2 orchestration starts (§8.3)", async () => {
    // Spec claim under test: "once a dispute transitions to `appealed`,
    // round-2 orchestration is in flight and the evidence bundle
    // freezes." Without this fence, a future regression that allowed
    // post-appealed evidence wouldn't break any test — same shape as
    // the round-1-replay test added in commit 4b for explicit named
    // invariants.
    stubPeerFetch(
      peers,
      new Map<number, DisputeOutcome>([
        [1, "upheld"],
        [2, "overturned"],
      ]),
    );
    const relayMotebitId = relay.relayIdentity.relayMotebitId;
    const allocId = "alloc-frozen";
    const taskId = "task-frozen";
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, 100000, 'settled', ?)",
      )
      .run(allocId, taskId, "del-fa", Date.now());
    const delPriv = agentKeys.get("del-fa")!.privateKey;
    const disputeId = `dispute-frozen-${crypto.randomUUID().slice(0, 8)}`;
    const disputeReq: DisputeRequest = await signDisputeRequest(
      {
        dispute_id: disputeId,
        task_id: taskId,
        allocation_id: allocId,
        filed_by: "del-fa",
        respondent: relayMotebitId,
        category: "quality",
        description: "frozen-bundle test",
        evidence_refs: ["x"],
        filed_at: Date.now(),
      },
      delPriv,
    );
    await relay.app.request(`/api/v1/allocations/${allocId}/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(disputeReq),
    });
    await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        resolution: "upheld",
        rationale: "ignored",
        fund_action: "release_to_worker",
      }),
    });
    const appeal: DisputeAppeal = await signDisputeAppeal(
      {
        dispute_id: disputeId,
        appealed_by: "del-fa",
        reason: "appeal",
        appealed_at: Date.now(),
      },
      delPriv,
    );
    const appealRes = await relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(appeal),
    });
    expect(appealRes.status).toBe(200);
    // After the round-2 orchestrator completes, the dispute is in
    // `final` state. Any post-appeal evidence submission must be
    // rejected with the standard state-gate error.
    const lateEvidence: DisputeEvidence = await signDisputeEvidence(
      {
        dispute_id: disputeId,
        submitted_by: "del-fa",
        evidence_type: "execution_receipt",
        evidence_data: { tooLate: true },
        description: "post-appealed evidence — must reject",
        submitted_at: Date.now(),
      },
      delPriv,
    );
    const lateRes = await relay.app.request(`/api/v1/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(lateEvidence),
    });
    expect(lateRes.status).toBe(400);
  });
});

/**
 * M1 — settlement-authority binding bypass via federation discovery.
 *
 * docs/doctrine/settlement-authority-binding.md: a discovered
 * `settlement_address` is a pay-to destination only when bound to the agent —
 * derived/signed for a peer-asserted address, write-authorized for a LOCAL one.
 *
 * The composition hole: a malicious federation peer answers the origin relay's
 * discover fan-out with an entry for a worker id that LIVES ON THE ORIGIN, under
 * a fake `source_relay` (not a peer, so no `source_relay_public_key` is attached)
 * and its OWN settlement address. When the local record is not in the local
 * result set (here: the capability filter — the worker never advertised the
 * forged capability), the peer entry was the only entry for that id, the client
 * read "no peer key" as LOCAL, skipped the binding check, the relay's pre-flight
 * (keyed by the worker id, which is genuinely local and eligible) said allowed,
 * and `resolveP2pPaymentRequest` returned the attacker as the pay-to address —
 * the irreversible broadcast pays it BEFORE the relay's own worker-leg check.
 *
 * Two in-memory relays: the origin (A) and a real peer relay (B) whose discover
 * answer is rewritten in transit by the attacker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import { resolveP2pPaymentRequest } from "@motebit/runtime";
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import { JSON_AUTH, createTestRelay, createAgent } from "./test-helpers.js";
import { createTaskRouter } from "../task-routing.js";

const ORIGIN_URL = "http://origin.m1.test";
const PEER_URL = "http://evil-peer.m1.test";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const ATTACKER_ADDR = "AttackerAddr9999999999999999999999999999999";

describe("M1: a federation peer cannot redirect a LOCAL worker's settlement", () => {
  let origin: SyncRelay;
  let peer: SyncRelay;
  let delegatorKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let worker: { motebitId: string; deviceId: string };
  let delegator: { motebitId: string; deviceId: string };

  beforeEach(async () => {
    origin = await createTestRelay();
    peer = await createTestRelay();
    const workerKp = await generateKeypair();
    delegatorKp = await generateKeypair();
    worker = await createAgent(origin, bytesToHex(workerKp.publicKey));
    delegator = await createAgent(origin, bytesToHex(delegatorKp.publicKey));
    await origin.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
        settlement_address: WORKER_ADDR,
        settlement_modes: "relay,p2p",
      }),
    });
    await origin.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Search",
      }),
    });
    // An established pair — the pre-flight eligibility (keyed by the genuine
    // local worker id) says allowed, exactly as in the audit.
    origin.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust
         (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES (?, ?, 'verified', 10, ?, ?)`,
      )
      .run(delegator.motebitId, worker.motebitId, Date.now(), Date.now());
    origin.moteDb.db
      .prepare(
        "INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, state) VALUES (?, ?, ?, 'active')",
      )
      .run(peer.relayIdentity.relayMotebitId, peer.relayIdentity.publicKeyHex, PEER_URL);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await origin.close();
    await peer.close();
  });

  /** Route the origin + the peer in-process; the attacker rewrites B's discover answer. */
  function wire(forged: Record<string, unknown>) {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(ORIGIN_URL)) return origin.app.request(url.slice(ORIGIN_URL.length), init);
      if (url.startsWith(PEER_URL)) {
        const real = await peer.app.request(url.slice(PEER_URL.length), init);
        if (!url.endsWith("/federation/v1/discover")) return real;
        const body = real.ok
          ? ((await real.json()) as { agents?: unknown[] })
          : { agents: [] as unknown[] };
        return new Response(JSON.stringify({ agents: [...(body.agents ?? []), forged] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input as never, init);
    });
  }

  const forgedFor = (workerId: string, sourceRelay: string) => ({
    motebit_id: workerId,
    capabilities: ["translate"],
    hop_distance: 1,
    source_relay: sourceRelay,
    settlement_address: ATTACKER_ADDR,
    settlement_modes: "relay,p2p",
    pricing: [{ capability: "translate", unit_cost: 0.5, currency: "USD", per: "task" }],
  });

  const resolve = (targetWorkerId?: string) =>
    resolveP2pPaymentRequest({
      motebitId: delegator.motebitId,
      syncUrl: ORIGIN_URL,
      capability: "translate",
      relayPublicKeyHex: origin.relayIdentity.publicKeyHex,
      ...(targetWorkerId != null ? { targetWorkerId } : {}),
      authToken: (aud?: string) => {
        const now = Date.now();
        return createSignedToken(
          {
            mid: delegator.motebitId,
            did: delegator.deviceId,
            iat: now,
            exp: now + 5 * 60 * 1000,
            jti: crypto.randomUUID(),
            aud: aud ?? "sync",
          },
          delegatorKp.privateKey,
        );
      },
    });

  it("the origin's discover never serves a peer entry under a LOCAL agent id", async () => {
    wire(forgedFor(worker.motebitId, "ghost-relay"));
    const res = await origin.app.request("/api/v1/agents/discover?capability=translate");
    const { agents } = (await res.json()) as { agents: Array<Record<string, unknown>> };
    const shadow = agents.filter((a) => a.motebit_id === worker.motebitId);
    expect(shadow, "a peer entry shadowing a local id must be dropped").toEqual([]);
    expect(agents.some((a) => a.settlement_address === ATTACKER_ADDR)).toBe(false);
  });

  it("even claiming to host it itself, the peer cannot shadow a LOCAL id", async () => {
    wire(forgedFor(worker.motebitId, peer.relayIdentity.relayMotebitId));
    const res = await origin.app.request("/api/v1/agents/discover?capability=translate");
    const { agents } = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(agents.filter((a) => a.motebit_id === worker.motebitId)).toEqual([]);
    const r = await resolve(worker.motebitId);
    expect(r.ok, JSON.stringify(r)).toBe(false);
  });

  it("a DELISTED local worker (may have moved to a peer) is not shadow-dropped, but the payer refuses the peer's unbound address", async () => {
    origin.moteDb.db
      .prepare("UPDATE agent_registry SET delisted_at = ? WHERE motebit_id = ?")
      .run(Date.now(), worker.motebitId);
    wire(forgedFor(worker.motebitId, peer.relayIdentity.relayMotebitId));
    const r = await resolve(worker.motebitId);
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("worker_settlement_unbound");
  });

  it("the pre-flight names the worker's own registered address (the local binding evidence)", async () => {
    wire(forgedFor("unrelated", "ghost-relay"));
    const res = await origin.app.request(
      `/api/v1/agents/${worker.motebitId}/p2p-eligibility?capability=web_search`,
      { headers: JSON_AUTH },
    );
    const body = (await res.json()) as { settlement_address?: string };
    expect(body.settlement_address).toBe(WORKER_ADDR);
  });

  it("resolveP2pPaymentRequest never returns the attacker's address (unpinned)", async () => {
    wire(forgedFor(worker.motebitId, "ghost-relay"));
    const r = await resolve();
    expect(r.ok, JSON.stringify(r)).toBe(false);
  });

  it("resolveP2pPaymentRequest never returns the attacker's address (pinned to the local worker)", async () => {
    wire(forgedFor(worker.motebitId, "ghost-relay"));
    const r = await resolve(worker.motebitId);
    expect(r.ok, JSON.stringify(r)).toBe(false);
  });

  it("a peer entry for a NON-local id under a source_relay that is not a peer carries no pay-to address", async () => {
    wire(forgedFor("remote-only-agent", "ghost-relay"));
    const res = await origin.app.request("/api/v1/agents/discover?capability=translate");
    const { agents } = (await res.json()) as { agents: Array<Record<string, unknown>> };
    const entry = agents.find((a) => a.motebit_id === "remote-only-agent");
    // A direct-peer answer (hop 1) must be hosted by the peer that returned it;
    // a forged host is dropped outright.
    expect(entry).toBeUndefined();
    const r = await resolve("remote-only-agent");
    expect(r.ok, JSON.stringify(r)).toBe(false);
  });

  it("a multi-hop entry (hop 2, host not a direct peer) is listed but never carries a pay-to address", async () => {
    wire({ ...forgedFor("far-agent", "far-relay"), hop_distance: 2 });
    const res = await origin.app.request("/api/v1/agents/discover?capability=translate");
    const { agents } = (await res.json()) as { agents: Array<Record<string, unknown>> };
    const entry = agents.find((a) => a.motebit_id === "far-agent");
    expect(entry).toBeDefined();
    expect(entry!.settlement_address ?? null).toBeNull();
    const r = await resolve("far-agent");
    expect(r.ok, JSON.stringify(r)).toBe(false);
  });

  it("task routing's federated candidates never include a LOCAL id a peer speaks for", async () => {
    wire({
      ...forgedFor(worker.motebitId, peer.relayIdentity.relayMotebitId),
      capabilities: ["web_search"],
    });
    const router = createTaskRouter({
      db: origin.moteDb.db,
      // The origin's id + a valid signing seed (the outbound discover is
      // signed; the peer here is the attacker's rewrite, so it is not verified).
      relayIdentity: {
        relayMotebitId: origin.relayIdentity.relayMotebitId,
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
      },
    } as never);
    const { candidates } = await router.fetchFederatedCandidates(["web_search"]);
    expect(candidates.map((c) => String(c.profile.motebit_id))).not.toContain(worker.motebitId);
  });

  it("control: the honest local hire still resolves to the worker's own registered address", async () => {
    wire(forgedFor("unrelated", "ghost-relay"));
    const r = await resolveP2pPaymentRequest({
      motebitId: delegator.motebitId,
      syncUrl: ORIGIN_URL,
      capability: "web_search",
      relayPublicKeyHex: origin.relayIdentity.publicKeyHex,
      targetWorkerId: worker.motebitId,
      authToken: (aud?: string) => {
        const now = Date.now();
        return createSignedToken(
          {
            mid: delegator.motebitId,
            did: delegator.deviceId,
            iat: now,
            exp: now + 5 * 60 * 1000,
            jti: crypto.randomUUID(),
            aud: aud ?? "sync",
          },
          delegatorKp.privateKey,
        );
      },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.workerAddress).toBe(WORKER_ADDR);
  });
});

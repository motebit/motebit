/**
 * M1 controls — the legitimate P2P hires the settlement-shadow fix must leave
 * byte-identical (docs/doctrine/settlement-authority-binding.md). Green on main
 * BEFORE the fix and green after it; a fix that narrows any of these is a
 * regression, not a hardening.
 *
 *  - a LOCAL worker whose address derives from its key: pinned and unpinned
 *    resolve to that derived address;
 *  - a LOCAL custody-separated worker (address does NOT derive from its key):
 *    still paid at the address it registered (the write-authorized rung);
 *  - a zero-cost LOCAL listing: `worker_not_payable`, nothing priced;
 *  - self-delegation (the caller is the only provider): `no_routing`.
 *
 * The honest direct-peer (hop 1) discover entry keeping its peer key and
 * settlement address is locked in federation-e2e.test.ts (PHASE 3 P-A).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import { resolveP2pPaymentRequest } from "@motebit/runtime";
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import { JSON_AUTH, createTestRelay, createAgent } from "./test-helpers.js";

const ORIGIN_URL = "http://origin.m1-legit.test";
const CUSTODY_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
type Agent = { motebitId: string; deviceId: string };

describe("M1 controls: legitimate local P2P hires are unchanged", () => {
  let origin: SyncRelay;
  let delegatorKp: Kp;
  let delegator: Agent;

  beforeEach(async () => {
    origin = await createTestRelay();
    delegatorKp = await generateKeypair();
    delegator = await createAgent(origin, bytesToHex(delegatorKp.publicKey));
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(ORIGIN_URL)) return origin.app.request(url.slice(ORIGIN_URL.length), init);
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await origin.close();
  });

  async function listWorker(
    motebitId: string,
    capability: string,
    settlementAddress: string,
    unitCost: number,
  ): Promise<void> {
    await origin.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: [capability],
        settlement_address: settlementAddress,
        settlement_modes: "relay,p2p",
      }),
    });
    await origin.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: [capability],
        pricing: [{ capability, unit_cost: unitCost, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: capability,
      }),
    });
    origin.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust
         (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES (?, ?, 'verified', 10, ?, ?)`,
      )
      .run(delegator.motebitId, motebitId, Date.now(), Date.now());
  }

  async function newWorker(): Promise<{ kp: Kp; agent: Agent }> {
    const kp = await generateKeypair();
    return { kp, agent: await createAgent(origin, bytesToHex(kp.publicKey)) };
  }

  const resolve = (capability: string, targetWorkerId?: string) =>
    resolveP2pPaymentRequest({
      motebitId: delegator.motebitId,
      syncUrl: ORIGIN_URL,
      capability,
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

  it("derived_worker: pinned and unpinned resolve to the key-derived address", async () => {
    const { kp, agent } = await newWorker();
    const derived = deriveSolanaAddress(kp.publicKey);
    await listWorker(agent.motebitId, "web_search", derived, 0.5);

    const unpinned = await resolve("web_search");
    expect(unpinned.ok, JSON.stringify(unpinned)).toBe(true);
    if (unpinned.ok) {
      expect(unpinned.workerMotebitId).toBe(agent.motebitId);
      expect(unpinned.workerAddress).toBe(derived);
      expect(unpinned.paymentRequest.workerAddress).toBe(derived);
    }
    const pinned = await resolve("web_search", agent.motebitId);
    expect(pinned.ok, JSON.stringify(pinned)).toBe(true);
    if (pinned.ok) expect(pinned.workerAddress).toBe(derived);
  });

  it("custody_worker: a custody-separated local address is paid as registered", async () => {
    const { kp, agent } = await newWorker();
    expect(deriveSolanaAddress(kp.publicKey)).not.toBe(CUSTODY_ADDR);
    await listWorker(agent.motebitId, "summarize", CUSTODY_ADDR, 0.5);

    for (const target of [undefined, agent.motebitId]) {
      const r = await resolve("summarize", target);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.workerAddress).toBe(CUSTODY_ADDR);
    }
  });

  it("zero-cost listing: worker_not_payable", async () => {
    const { kp, agent } = await newWorker();
    await listWorker(agent.motebitId, "free_cap", deriveSolanaAddress(kp.publicKey), 0);
    const r = await resolve("free_cap", agent.motebitId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("worker_not_payable");
  });

  it("self-delegation: the caller is never its own worker (no_routing)", async () => {
    await listWorker(
      delegator.motebitId,
      "self_cap",
      deriveSolanaAddress(delegatorKp.publicKey),
      0.5,
    );
    const r = await resolve("self_cap");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("no_routing");
  });
});

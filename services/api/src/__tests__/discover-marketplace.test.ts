/**
 * Marketplace enrichment of GET /api/v1/agents/discover.
 *
 * The discover endpoint surfaces the data needed to render a marketplace UI:
 *   - per-capability pricing (from relay_service_listings)
 *   - last_seen_at heartbeat (from agent_registry)
 *   - trust_level + interaction_count (from caller's agent_trust ledger,
 *     only when the request is authenticated)
 *
 * Trust enrichment is per-caller: each motebit sees its own ledger, never
 * another's. Anonymous discover (no caller) returns identity + capabilities +
 * pricing only — public marketplace data, private trust kept private.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { enrichWithCallerTrust } from "../agents.js";

interface DiscoveredAgent {
  motebit_id: string;
  capabilities: string[];
  pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }> | null;
  last_seen_at: number;
  trust_level?: string;
  interaction_count?: number;
}

async function registerAgent(
  relay: SyncRelay,
  motebitId: string,
  publicKeyHex: string,
  capabilities: string[] = ["web_search"],
) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities,
      public_key: publicKeyHex,
    }),
  });
}

async function publishListing(
  relay: SyncRelay,
  motebitId: string,
  pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }>,
) {
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      capabilities: pricing.map((p) => p.capability),
      pricing,
    }),
  });
}

describe("GET /api/v1/agents/discover — marketplace enrichment", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns pricing alongside capabilities for agents with a published listing", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "marketplace-agent", bytesToHex(kp.publicKey), ["web_search"]);
    await publishListing(relay, "marketplace-agent", [
      { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "search" },
    ]);

    const res = await relay.app.request("/api/v1/agents/discover");
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };

    const target = agents.find((a) => a.motebit_id === "marketplace-agent");
    expect(target).toBeDefined();
    expect(target!.pricing).toEqual([
      { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "search" },
    ]);
  });

  it("returns empty pricing array (not null) for agents with auto-created default listing", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "no-price-agent", bytesToHex(kp.publicKey));

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "no-price-agent");
    expect(target).toBeDefined();
    // Auto-created listing has pricing='[]', not absent
    expect(target!.pricing).toEqual([]);
  });

  it("returns last_seen_at from the agent registry heartbeat", async () => {
    const kp = await generateKeypair();
    const before = Date.now();
    await registerAgent(relay, "fresh-agent", bytesToHex(kp.publicKey));
    const after = Date.now();

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "fresh-agent");
    expect(target!.last_seen_at).toBeGreaterThanOrEqual(before);
    expect(target!.last_seen_at).toBeLessThanOrEqual(after);
  });

  it("anonymous discover does NOT include trust info (private data stays private)", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "trusted-agent", bytesToHex(kp.publicKey));

    // Seed a trust row from some other caller's ledger
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        `INSERT INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES ('caller-x', 'trusted-agent', 'verified', 7, ?, ?)`,
      )
      .run(now, now);

    // Anonymous request — no callerMotebitId in context
    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "trusted-agent");
    expect(target).toBeDefined();
    expect(target!.trust_level).toBeUndefined();
    expect(target!.interaction_count).toBeUndefined();
  });

  it("multiple agents in one query each get their own pricing without N+1 leak", async () => {
    // Three agents, three different price points — verify batch fetch keeps them straight
    const a = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    await registerAgent(relay, "agent-a", bytesToHex(a.publicKey), ["web_search"]);
    await registerAgent(relay, "agent-b", bytesToHex(b.publicKey), ["read_url"]);
    await registerAgent(relay, "agent-c", bytesToHex(c.publicKey), ["code_review"]);

    await publishListing(relay, "agent-a", [
      { capability: "web_search", unit_cost: 0.01, currency: "USD", per: "search" },
    ]);
    await publishListing(relay, "agent-b", [
      { capability: "read_url", unit_cost: 0.02, currency: "USD", per: "fetch" },
    ]);
    await publishListing(relay, "agent-c", [
      { capability: "code_review", unit_cost: 0.5, currency: "USD", per: "review" },
    ]);

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };

    const aRes = agents.find((x) => x.motebit_id === "agent-a")!;
    const bRes = agents.find((x) => x.motebit_id === "agent-b")!;
    const cRes = agents.find((x) => x.motebit_id === "agent-c")!;
    expect(aRes.pricing![0]!.unit_cost).toBe(0.01);
    expect(bRes.pricing![0]!.unit_cost).toBe(0.02);
    expect(cRes.pricing![0]!.unit_cost).toBe(0.5);
  });

  it("preserves capability filter — only agents matching the filter come back", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    await registerAgent(relay, "ws-only", bytesToHex(a.publicKey), ["web_search"]);
    await registerAgent(relay, "review-only", bytesToHex(b.publicKey), ["code_review"]);
    await publishListing(relay, "ws-only", [
      { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "search" },
    ]);
    await publishListing(relay, "review-only", [
      { capability: "code_review", unit_cost: 0.5, currency: "USD", per: "review" },
    ]);

    const res = await relay.app.request("/api/v1/agents/discover?capability=code_review");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const ids = agents.map((a) => a.motebit_id);
    expect(ids).toContain("review-only");
    expect(ids).not.toContain("ws-only");
  });

  // ── enrichWithCallerTrust unit tests ──
  // (Exported helper used by the discover endpoint when the request is signed.
  // Master-token requests don't populate callerMotebitId, so the integration
  // test above can't reach this branch — testing the unit directly.)

  it("enrichWithCallerTrust adds trust_level + interaction_count for known agents", () => {
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        `INSERT INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES ('alice', 'bob', 'trusted', 12, ?, ?)`,
      )
      .run(now, now);
    relay.moteDb.db
      .prepare(
        `INSERT INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES ('alice', 'carol', 'first_contact', 1, ?, ?)`,
      )
      .run(now, now);

    const agents: Array<{
      motebit_id: string;
      capabilities: string[];
      trust_level?: string;
      interaction_count?: number;
    }> = [
      { motebit_id: "bob", capabilities: ["x"] },
      { motebit_id: "carol", capabilities: ["y"] },
      { motebit_id: "stranger", capabilities: ["z"] },
    ];

    const enriched = enrichWithCallerTrust(agents, "alice", relay.moteDb.db);
    const bob = enriched.find((a) => a.motebit_id === "bob")!;
    const carol = enriched.find((a) => a.motebit_id === "carol")!;
    const stranger = enriched.find((a) => a.motebit_id === "stranger")!;

    expect(bob.trust_level).toBe("trusted");
    expect(bob.interaction_count).toBe(12);
    expect(carol.trust_level).toBe("first_contact");
    expect(carol.interaction_count).toBe(1);
    // Strangers stay un-enriched — no fabricated data
    expect(stranger.trust_level).toBeUndefined();
    expect(stranger.interaction_count).toBeUndefined();
  });

  it("enrichWithCallerTrust returns input unchanged when caller is undefined or empty", () => {
    const agents = [{ motebit_id: "any", capabilities: ["x"] }];
    expect(enrichWithCallerTrust(agents, undefined, relay.moteDb.db)).toEqual(agents);
    expect(enrichWithCallerTrust(agents, "", relay.moteDb.db)).toEqual(agents);
  });

  it("enrichWithCallerTrust isolates ledgers — alice's trust never leaks to bob", () => {
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        `INSERT INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES ('alice', 'shared-target', 'trusted', 50, ?, ?)`,
      )
      .run(now, now);

    const agents: Array<{
      motebit_id: string;
      capabilities: string[];
      trust_level?: string;
      interaction_count?: number;
    }> = [{ motebit_id: "shared-target", capabilities: ["x"] }];

    // Bob asks — sees nothing (alice's ledger is alice's)
    const bobView = enrichWithCallerTrust(agents, "bob", relay.moteDb.db);
    expect(bobView[0]!.trust_level).toBeUndefined();

    // Alice asks — sees her own row
    const aliceView = enrichWithCallerTrust(agents, "alice", relay.moteDb.db);
    expect(aliceView[0]!.trust_level).toBe("trusted");
    expect(aliceView[0]!.interaction_count).toBe(50);
  });

  it("agents without any service listing (pricing row deleted) come back with pricing=null", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "deleted-listing", bytesToHex(kp.publicKey));

    // Force-delete the auto-created listing
    relay.moteDb.db
      .prepare("DELETE FROM relay_service_listings WHERE motebit_id = ?")
      .run("deleted-listing");

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "deleted-listing");
    expect(target).toBeDefined();
    expect(target!.pricing).toBeNull();
  });
});

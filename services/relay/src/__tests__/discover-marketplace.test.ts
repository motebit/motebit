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
import { enrichWithCallerTrust, enrichWithHardwareAttestation } from "../agents.js";

interface DiscoveredAgent {
  motebit_id: string;
  capabilities: string[];
  pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }> | null;
  last_seen_at: number;
  freshness: "awake" | "recently_seen" | "dormant" | "cold";
  trust_level?: string;
  interaction_count?: number;
  hardware_attestation?: { platform: string; key_exported?: boolean; score: number };
}

type EnricherInput = Record<string, unknown> & {
  motebit_id: string;
  hardware_attestation?: { platform: string; key_exported?: boolean; score: number };
};

function insertTrustCredential(
  db: import("@motebit/persistence").DatabaseDriver,
  opts: {
    credential_id: string;
    subject_motebit_id: string;
    issuer_did?: string;
    platform: string;
    key_exported?: boolean;
    issued_at?: number;
  },
): void {
  const issuedAt = opts.issued_at ?? Date.now();
  const vc = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "AgentTrustCredential"],
    issuer: opts.issuer_did ?? "did:key:z-issuer-test",
    validFrom: new Date(issuedAt).toISOString(),
    credentialSubject: {
      id: `did:motebit:${opts.subject_motebit_id}`,
      hardware_attestation: { platform: opts.platform, key_exported: opts.key_exported },
    },
  };
  db.prepare(
    `INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.credential_id,
    opts.subject_motebit_id,
    opts.issuer_did ?? "did:key:z-issuer-test",
    "AgentTrustCredential",
    JSON.stringify(vc),
    issuedAt,
  );
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

  // Endgame-marketplace invariant: a service agent that went to sleep
  // (Fly.io auto_stop, missed heartbeat) MUST remain discoverable. The
  // old behavior filtered on `expires_at > now`, creating a visibility
  // deadlock: sleeping agents disappeared from Discover, so nobody
  // delegated to them, so they stayed asleep. Under the new semantics,
  // discoverability is persistent and liveness is a render hint.
  it("sleeping agent (heartbeat > 30 min old) remains discoverable with freshness='dormant'", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "sleeping-agent", bytesToHex(kp.publicKey));

    // Simulate a 45-minute-old heartbeat by rewriting last_heartbeat directly.
    // This is the exact shape of a Fly.io machine that slept past the old 15
    // minute TTL — today (post-fix) it should still appear with freshness
    // "dormant". Before the fix, the `WHERE expires_at > now` filter would
    // hide it entirely.
    const staleHeartbeat = Date.now() - 45 * 60 * 1000;
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET last_heartbeat = ? WHERE motebit_id = ?")
      .run(staleHeartbeat, "sleeping-agent");

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "sleeping-agent");
    expect(target).toBeDefined();
    expect(target!.freshness).toBe("dormant");
  });

  it("long-asleep agent (heartbeat > 24 h old) remains discoverable with freshness='cold'", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "cold-agent", bytesToHex(kp.publicKey));

    const coldHeartbeat = Date.now() - 48 * 60 * 60 * 1000;
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET last_heartbeat = ? WHERE motebit_id = ?")
      .run(coldHeartbeat, "cold-agent");

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "cold-agent");
    expect(target).toBeDefined();
    expect(target!.freshness).toBe("cold");
  });

  it("fresh agent (just registered) has freshness='awake'", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "fresh-agent-freshness", bytesToHex(kp.publicKey));

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "fresh-agent-freshness");
    expect(target).toBeDefined();
    expect(target!.freshness).toBe("awake");
  });

  // ── enrichWithHardwareAttestation: per-row hardware-attestation badge data ──
  // The Agents-panel badge shows the most-recent verified HA claim per peer.
  // The relay reads from the same `relay_credentials` pool routing aggregates
  // against; the badge surfaces a single claim, routing aggregates many.

  it("attaches hardware_attestation from the most recent peer-issued AgentTrustCredential", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "ha-agent", bytesToHex(kp.publicKey));
    insertTrustCredential(relay.moteDb.db, {
      credential_id: "ha-cred-1",
      subject_motebit_id: "ha-agent",
      platform: "secure_enclave",
    });

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "ha-agent");
    expect(target).toBeDefined();
    expect(target!.hardware_attestation).toEqual({
      platform: "secure_enclave",
      key_exported: undefined,
      score: 1,
    });
  });

  it("agents with no AgentTrustCredential get no hardware_attestation field", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "no-ha-agent", bytesToHex(kp.publicKey));

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    const target = agents.find((a) => a.motebit_id === "no-ha-agent");
    expect(target).toBeDefined();
    expect(target!.hardware_attestation).toBeUndefined();
  });

  it("enrichWithHardwareAttestation picks the most recent credential per agent", () => {
    insertTrustCredential(relay.moteDb.db, {
      credential_id: "old-cred",
      subject_motebit_id: "multi-cred-agent",
      platform: "software",
      issued_at: 1000,
    });
    insertTrustCredential(relay.moteDb.db, {
      credential_id: "new-cred",
      subject_motebit_id: "multi-cred-agent",
      platform: "tpm",
      issued_at: 2000,
    });

    const enriched = enrichWithHardwareAttestation(
      [{ motebit_id: "multi-cred-agent", capabilities: ["x"] } as EnricherInput],
      relay.moteDb.db,
    );
    expect(enriched[0]!.hardware_attestation).toEqual({
      platform: "tpm",
      key_exported: undefined,
      score: 1,
    });
  });

  it("enrichWithHardwareAttestation skips revoked credentials", () => {
    insertTrustCredential(relay.moteDb.db, {
      credential_id: "revoked-cred",
      subject_motebit_id: "revoked-ha-agent",
      platform: "secure_enclave",
      issued_at: 3000,
    });
    insertTrustCredential(relay.moteDb.db, {
      credential_id: "live-cred",
      subject_motebit_id: "revoked-ha-agent",
      platform: "software",
      issued_at: 1000,
    });
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_revoked_credentials (credential_id, motebit_id, revoked_by) VALUES (?, ?, ?)",
      )
      .run("revoked-cred", "revoked-ha-agent", "did:key:z-issuer-test");

    const enriched = enrichWithHardwareAttestation(
      [{ motebit_id: "revoked-ha-agent", capabilities: ["x"] } as EnricherInput],
      relay.moteDb.db,
    );
    // Falls through to the live (older) credential after skipping the revoked one.
    expect(enriched[0]!.hardware_attestation?.platform).toBe("software");
  });

  it("enrichWithHardwareAttestation preserves peer-provided HA on federated agents", () => {
    // Federation merge passes through HA from the upstream peer relay. The
    // local enricher must not overwrite it when we have no local credential —
    // the peer's HA store is more authoritative for cross-relay agents.
    const enriched = enrichWithHardwareAttestation(
      [
        {
          motebit_id: "federated-agent",
          capabilities: ["x"],
          hardware_attestation: { platform: "android_keystore", score: 1 },
        } as EnricherInput,
      ],
      relay.moteDb.db,
    );
    expect(enriched[0]!.hardware_attestation?.platform).toBe("android_keystore");
  });

  it("revoked agent is filtered out even if freshness would be awake", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "revoked-agent", bytesToHex(kp.publicKey));

    relay.moteDb.db
      .prepare("UPDATE agent_registry SET revoked = 1 WHERE motebit_id = ?")
      .run("revoked-agent");

    const res = await relay.app.request("/api/v1/agents/discover");
    const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
    expect(agents.find((a) => a.motebit_id === "revoked-agent")).toBeUndefined();
  });
});

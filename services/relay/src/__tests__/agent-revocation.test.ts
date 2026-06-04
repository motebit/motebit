/**
 * Agent-revocation route + producer tests — the operator hygiene de-list
 * power made sovereign-verifiable (`docs/doctrine/agents-as-first-person-trust-graph.md`).
 *
 * Verifies the whole loop: operator revokes (master-token), the agent leaves
 * Discover, the signed record + public feed verify against the relay's pinned
 * key, reinstate brings it back, and the power is operator-only (a verified
 * agent token cannot revoke a peer).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import {
  generateKeypair,
  createSignedToken,
  bytesToHex,
  hexToBytes,
  verify,
  canonicalJson,
} from "@motebit/encryption";
import type { AgentRevocationRecord, AgentRevocationFeed } from "@motebit/protocol";
import { JSON_AUTH, createTestRelay } from "./test-helpers.js";

interface DiscoveredAgent {
  motebit_id: string;
}

async function registerAgent(relay: SyncRelay, motebitId: string, publicKeyHex: string) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
}

async function discoverIds(relay: SyncRelay): Promise<string[]> {
  const res = await relay.app.request("/api/v1/agents/discover");
  const { agents } = (await res.json()) as { agents: DiscoveredAgent[] };
  return agents.map((a) => a.motebit_id);
}

/** Verify a signed record against the relay's pinned public key. */
async function verifyRecord(
  record: AgentRevocationRecord,
  relayPubKeyHex: string,
): Promise<boolean> {
  const { hash: _h, suite: _s, signature, ...payload } = record;
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  return verify(hexToBytes(signature), bytes, hexToBytes(relayPubKeyHex));
}

describe("agent revocation — operator de-list, sovereign-verifiable", () => {
  let relay: SyncRelay;
  let relayPubKey: string;

  beforeEach(async () => {
    relay = await createTestRelay();
    relayPubKey = relay.relayIdentity.publicKeyHex;
    const kp = await generateKeypair();
    await registerAgent(relay, "junk-agent", bytesToHex(kp.publicKey));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("operator revoke returns a signed record that verifies against the relay key", async () => {
    const res = await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "operator_test_cleanup", note: "leftover smoke test" }),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as AgentRevocationRecord;

    expect(record.motebit_id).toBe("junk-agent");
    expect(record.revoked).toBe(true);
    expect(record.reason).toBe("operator_test_cleanup");
    expect(record.actor).toBe("operator");
    expect(record.note).toBe("leftover smoke test");
    expect(record.relay_public_key).toBe(relayPubKey);
    expect(await verifyRecord(record, relayPubKey)).toBe(true);
  });

  it("a revoked agent leaves Discover (de-list)", async () => {
    expect(await discoverIds(relay)).toContain("junk-agent");

    await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "spam" }),
    });

    expect(await discoverIds(relay)).not.toContain("junk-agent");
  });

  it("unrevoke reinstates the agent into Discover", async () => {
    await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(await discoverIds(relay)).not.toContain("junk-agent");

    const res = await relay.app.request("/api/v1/agents/junk-agent/restore-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as AgentRevocationRecord;
    expect(record.revoked).toBe(false);
    expect(record.reason).toBe("reinstated");

    expect(await discoverIds(relay)).toContain("junk-agent");
  });

  it("the public feed is unauthenticated, signed, and contains the append-only history", async () => {
    await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "abuse" }),
    });
    await relay.app.request("/api/v1/agents/junk-agent/restore-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });

    // No auth header — the feed is public.
    const res = await relay.app.request("/api/v1/agents/revocations");
    expect(res.status).toBe(200);
    const feed = (await res.json()) as AgentRevocationFeed;

    expect(feed.records).toHaveLength(2);
    expect(feed.records[0]!.revoked).toBe(true);
    expect(feed.records[0]!.reason).toBe("abuse");
    expect(feed.records[1]!.revoked).toBe(false);
    expect(feed.records[1]!.reason).toBe("reinstated");

    // Each record verifies, and so does the feed digest.
    for (const r of feed.records) {
      expect(await verifyRecord(r, relayPubKey)).toBe(true);
    }
    const { signature, suite: _suite, ...feedPayload } = feed;
    const feedBytes = new TextEncoder().encode(canonicalJson(feedPayload));
    expect(await verify(hexToBytes(signature), feedBytes, hexToBytes(relayPubKey))).toBe(true);
  });

  it("is operator-only — a verified agent token cannot revoke a peer (403)", async () => {
    // Mint a valid agent token (admin:query audience) for a real device.
    const kp = await generateKeypair();
    const pubKeyHex = bytesToHex(kp.publicKey);
    const idRes = await relay.app.request("/identity", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const { motebit_id } = (await idRes.json()) as { motebit_id: string };
    const devRes = await relay.app.request("/device/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ motebit_id, device_name: "T", public_key: pubKeyHex }),
    });
    const { device_id } = (await devRes.json()) as { device_id: string };
    const token = await createSignedToken(
      {
        mid: motebit_id,
        did: device_id,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud: "admin:query",
      },
      kp.privateKey,
    );

    const res = await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(res.status).toBe(403);

    // And the agent is untouched — still discoverable.
    expect(await discoverIds(relay)).toContain("junk-agent");
  });

  it("rejects an unrecognized reason (400) — fails closed on the signed surface", async () => {
    const res = await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "censorship" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects `reinstated` as a revoke reason (400) — it is the unrevoke reason", async () => {
    const res = await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "reinstated" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await relay.app.request("/api/v1/agents/no-such-agent/revoke-listing", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(res.status).toBe(404);
  });

  it("requires auth — no bearer is 401 (middleware)", async () => {
    const res = await relay.app.request("/api/v1/agents/junk-agent/revoke-listing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(res.status).toBe(401);
  });
});

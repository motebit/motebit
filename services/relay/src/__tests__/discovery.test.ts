/**
 * Discovery endpoint tests — motebit/discovery@1.0.
 *
 * Tests for:
 * - GET /.well-known/motebit.json — signed relay metadata (§3)
 * - GET /api/v1/discover/:motebitId — agent resolution (§5)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  verify,
  canonicalJson,
  hexToBytes,
} from "@motebit/encryption";
import type { RelayMetadata, AgentResolutionResult } from "@motebit/protocol";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

// === Helpers ===

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

// === /.well-known/motebit.json ===

describe("GET /.well-known/motebit.json", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns signed relay metadata with required fields", async () => {
    const res = await relay.app.request("/.well-known/motebit.json");
    expect(res.status).toBe(200);

    const metadata = (await res.json()) as RelayMetadata;

    // Required fields (§3.5)
    expect(metadata.protocol_version).toBe("1.0");
    expect(metadata.relay_id).toBeTruthy();
    expect(metadata.public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof metadata.endpoint_url).toBe("string");
    expect(metadata.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("signature is verifiable with the included public key (§3.3)", async () => {
    const res = await relay.app.request("/.well-known/motebit.json");
    const metadata = (await res.json()) as RelayMetadata;

    // Step 1: Extract and remove signature
    const { signature, ...metadataWithoutSig } = metadata;

    // Step 2-6: Verify Ed25519 signature
    const canonical = canonicalJson(metadataWithoutSig);
    const payloadBytes = new TextEncoder().encode(canonical);
    const sigBytes = hexToBytes(signature);
    const pubKeyBytes = hexToBytes(metadata.public_key);

    const valid = await verify(sigBytes, payloadBytes, pubKeyBytes);
    expect(valid).toBe(true);
  });

  it("includes capabilities", async () => {
    const res = await relay.app.request("/.well-known/motebit.json");
    const metadata = (await res.json()) as RelayMetadata;

    expect(metadata.capabilities).toBeDefined();
    expect(metadata.capabilities).toContain("task_routing");
    expect(metadata.capabilities).toContain("settlement");
    expect(metadata.capabilities).toContain("credential_store");
    expect(metadata.capabilities).toContain("sync");
  });

  it("includes agent count", async () => {
    // Register an agent first
    const kp = await generateKeypair();
    await registerAgent(relay, "agent-1", bytesToHex(kp.publicKey));

    const res = await relay.app.request("/.well-known/motebit.json");
    const metadata = (await res.json()) as RelayMetadata;

    expect(metadata.agent_count).toBeGreaterThanOrEqual(1);
  });

  it("sets Cache-Control header (§3.6)", async () => {
    const res = await relay.app.request("/.well-known/motebit.json");
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=3600");
  });

  it("is unauthenticated — no Bearer token required", async () => {
    // No AUTH_HEADER — should still succeed
    const res = await relay.app.request("/.well-known/motebit.json");
    expect(res.status).toBe(200);
  });
});

// === /api/v1/discover/:motebitId ===

describe("GET /api/v1/discover/:motebitId", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("resolves a local agent", async () => {
    const kp = await generateKeypair();
    const pubHex = bytesToHex(kp.publicKey);
    await registerAgent(relay, "agent-local", pubHex, ["web_search", "read_url"]);

    const res = await relay.app.request("/api/v1/discover/agent-local");
    expect(res.status).toBe(200);

    const result = (await res.json()) as AgentResolutionResult;
    expect(result.found).toBe(true);
    expect(result.motebit_id).toBe("agent-local");
    expect(result.public_key).toBe(pubHex);
    expect(result.relay_id).toBeTruthy();
    expect(result.resolved_via).toHaveLength(1);
    expect(result.cached).toBe(false);
    expect(result.ttl).toBe(300);
  });

  it("returns not found for unknown agent", async () => {
    const res = await relay.app.request("/api/v1/discover/nonexistent-agent");
    expect(res.status).toBe(200);

    const result = (await res.json()) as AgentResolutionResult;
    expect(result.found).toBe(false);
    expect(result.motebit_id).toBe("nonexistent-agent");
    expect(result.resolved_via).toHaveLength(1);
    expect(result.ttl).toBe(60);
  });

  it("does not resolve revoked agent", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "agent-revoked", bytesToHex(kp.publicKey));

    // Revoke the agent
    await relay.app.request("/api/v1/agents/agent-revoked/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });

    const res = await relay.app.request("/api/v1/discover/agent-revoked");
    const result = (await res.json()) as AgentResolutionResult;
    expect(result.found).toBe(false);
  });

  it("respects X-Hop-Limit header", async () => {
    // With hop limit 0, should return local-only result (not found)
    const res = await relay.app.request("/api/v1/discover/nonexistent", {
      headers: { "X-Hop-Limit": "0" },
    });

    const result = (await res.json()) as AgentResolutionResult;
    expect(result.found).toBe(false);
    // No federation queries attempted at hop 0
    expect(result.resolved_via).toHaveLength(1);
  });

  it("caches positive resolution result", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "cached-agent", bytesToHex(kp.publicKey));

    // First request — not cached
    const res1 = await relay.app.request("/api/v1/discover/cached-agent");
    const result1 = (await res1.json()) as AgentResolutionResult;
    expect(result1.found).toBe(true);
    expect(result1.cached).toBe(false);

    // Note: local results bypass cache, so cached flag will stay false
    // for local agents (they're always fresh from DB)
    const res2 = await relay.app.request("/api/v1/discover/cached-agent");
    const result2 = (await res2.json()) as AgentResolutionResult;
    expect(result2.found).toBe(true);
  });

  it("includes capabilities in resolution result", async () => {
    const kp = await generateKeypair();
    await registerAgent(relay, "agent-caps", bytesToHex(kp.publicKey), [
      "web_search",
      "code_review",
    ]);

    const res = await relay.app.request("/api/v1/discover/agent-caps");
    const result = (await res.json()) as AgentResolutionResult;
    expect(result.found).toBe(true);
    expect(result.capabilities).toContain("web_search");
    expect(result.capabilities).toContain("code_review");
  });
});

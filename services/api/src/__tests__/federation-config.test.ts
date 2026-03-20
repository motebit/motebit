/**
 * Federation configuration enforcement tests.
 *
 * Validates that federation governance controls (enabled/disabled, blocklist,
 * allowlist, maxPeers) are enforced at the peering, discovery, and task
 * forwarding endpoints.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { bytesToHex } from "@motebit/crypto";

const API_TOKEN = "test-token";
const X402_CONFIG = {
  payToAddress: "0x0000000000000000000000000000000000000000",
  network: "eip155:84532",
  testnet: true,
};

/** Helper: create a relay with specific federation config. */
async function createRelay(federation?: Record<string, unknown>): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    x402: X402_CONFIG,
    enableDeviceAuth: false,
    federation: federation as SyncRelay extends { app: infer _ } ? typeof federation : never,
  } as Parameters<typeof createSyncRelay>[0]);
}

/** Helper: propose peering from a fake relay. */
async function proposePeer(
  relay: SyncRelay,
  relayId: string,
  publicKey?: string,
): Promise<Response> {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  return relay.app.request("/federation/v1/peer/propose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: relayId,
      public_key: publicKey ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      endpoint_url: `http://${relayId}.test:3000`,
      display_name: relayId,
      nonce,
    }),
  });
}

describe("Federation configuration enforcement", () => {
  // ── Disabled federation ──

  describe("federation disabled", () => {
    let relay: SyncRelay;

    beforeEach(async () => {
      relay = await createRelay({
        endpointUrl: "http://self.test:3000",
        enabled: false,
      });
    });

    it("propose returns 403 when federation is disabled", async () => {
      const res = await proposePeer(relay, "peer-relay-1");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Federation is disabled");
    });

    it("confirm returns 403 when federation is disabled", async () => {
      const res = await relay.app.request("/federation/v1/peer/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relay_id: "peer-relay-1",
          challenge_response: "deadbeef",
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Federation is disabled");
    });

    it("discover returns empty agents when federation is disabled", async () => {
      const res = await relay.app.request("/federation/v1/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: { capability: "web_search" },
          hop_count: 0,
          max_hops: 2,
          visited: [],
          query_id: "q-1",
          origin_relay: "peer-relay-1",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: unknown[] };
      expect(body.agents).toEqual([]);
    });

    it("task forward returns 403 when federation is disabled", async () => {
      const res = await relay.app.request("/federation/v1/task/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: "task-1",
          origin_relay: "peer-relay-1",
          target_agent: "agent-1",
          task_payload: { prompt: "hello" },
          signature: "deadbeef",
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Federation is disabled");
    });
  });

  // ── Blocked peer ──

  describe("blocked peer", () => {
    let relay: SyncRelay;

    beforeEach(async () => {
      relay = await createRelay({
        endpointUrl: "http://self.test:3000",
        enabled: true,
        blockedPeers: ["evil-relay", "another-bad-relay"],
      });
    });

    it("propose returns 403 for blocked peer", async () => {
      const res = await proposePeer(relay, "evil-relay");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Peer is blocked");
    });

    it("propose succeeds for non-blocked peer", async () => {
      const res = await proposePeer(relay, "good-relay");
      expect(res.status).toBe(200);
    });

    it("blocklist takes precedence over allowlist", async () => {
      // Create relay with both allowlist and blocklist, where the peer is in both
      const dualRelay = await createRelay({
        endpointUrl: "http://self.test:3000",
        enabled: true,
        allowedPeers: ["evil-relay", "good-relay"],
        blockedPeers: ["evil-relay"],
      });

      const res = await proposePeer(dualRelay, "evil-relay");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Peer is blocked");
    });
  });

  // ── Allowlist ──

  describe("allowlist", () => {
    let relay: SyncRelay;

    beforeEach(async () => {
      relay = await createRelay({
        endpointUrl: "http://self.test:3000",
        enabled: true,
        allowedPeers: ["trusted-relay-1", "trusted-relay-2"],
      });
    });

    it("propose returns 403 for peer not in allowlist", async () => {
      const res = await proposePeer(relay, "unknown-relay");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Peer is not in allowlist");
    });

    it("propose succeeds for peer in allowlist", async () => {
      const res = await proposePeer(relay, "trusted-relay-1");
      expect(res.status).toBe(200);
    });
  });

  // ── Max peers ──

  describe("max peers", () => {
    it("propose returns 503 when max peers reached (maxPeers=0)", async () => {
      // maxPeers=0 means no active peers allowed — simplest way to test the limit
      const relay = await createRelay({
        endpointUrl: "http://self.test:3000",
        enabled: true,
        maxPeers: 0,
      });

      const res = await proposePeer(relay, "any-peer");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Maximum peer limit reached");
    });

    it("propose succeeds when under max peers limit", async () => {
      const relay = await createRelay({
        endpointUrl: "http://self.test:3000",
        enabled: true,
        maxPeers: 10,
      });

      // No active peers yet, well under the limit
      const res = await proposePeer(relay, "peer-1");
      expect(res.status).toBe(200);
    });
  });

  // ── Default behavior (backward compat) ──

  describe("default behavior (no restrictions)", () => {
    let relay: SyncRelay;

    beforeEach(async () => {
      // Federation with endpointUrl but no policy restrictions — same as before
      relay = await createRelay({
        endpointUrl: "http://self.test:3000",
        displayName: "Open Relay",
      });
    });

    it("propose succeeds with no config restrictions", async () => {
      const res = await proposePeer(relay, "any-relay");
      expect(res.status).toBe(200);
    });

    it("discover works with no config restrictions", async () => {
      const res = await relay.app.request("/federation/v1/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: { capability: "web_search" },
          hop_count: 0,
          max_hops: 2,
          visited: [],
          query_id: "q-default",
          origin_relay: "any-relay",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("federation enabled by default when endpointUrl is set", async () => {
      // No explicit enabled field — should be enabled because endpointUrl is set
      const res = await proposePeer(relay, "peer-1");
      expect(res.status).toBe(200);
    });
  });

  // ── No federation config (omitted entirely) ──

  describe("no federation config", () => {
    let relay: SyncRelay;

    beforeEach(async () => {
      // No federation config at all — federation should be disabled
      relay = await createRelay(undefined);
    });

    it("identity endpoint still works", async () => {
      const res = await relay.app.request("/federation/v1/identity");
      expect(res.status).toBe(200);
    });

    it("propose returns 403 when no federation config", async () => {
      const res = await proposePeer(relay, "peer-1");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Federation is disabled");
    });

    it("discover returns empty when no federation config", async () => {
      const res = await relay.app.request("/federation/v1/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: { capability: "web_search" },
          hop_count: 0,
          max_hops: 2,
          visited: [],
          query_id: "q-none",
          origin_relay: "peer-1",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: unknown[] };
      expect(body.agents).toEqual([]);
    });
  });
});

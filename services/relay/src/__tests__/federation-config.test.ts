/**
 * Federation configuration enforcement tests.
 *
 * Validates that federation governance controls (enabled/disabled, blocklist,
 * allowlist, maxPeers) are enforced at the peering, discovery, and task
 * forwarding endpoints.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { bytesToHex } from "@motebit/encryption";
import { verifyFederationMessage } from "@motebit/crypto";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

/** Helper: create a relay with specific federation config. */
async function createRelay(federation?: Record<string, unknown>): Promise<SyncRelay> {
  return createTestRelay({
    enableDeviceAuth: false,
    federation,
  } as Parameters<typeof createTestRelay>[0]);
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

    it("UNSIGNED discover rejects by default since the 1.4 sunset (403)", async () => {
      // Pre-1.4 an unsigned discover passed under the tolerant rollout default;
      // the 2026-07-21 sunset (#188) flipped requireDiscoverSignature to true.
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
      expect(res.status).toBe(403);
    });

    it("unsigned discover still works under an explicit requireDiscoverSignature:false opt-out", async () => {
      const tolerant = await createRelay({
        endpointUrl: "http://tolerant.test:3001",
        displayName: "Tolerant Relay",
        requireDiscoverSignature: false,
      });
      const res = await tolerant.app.request("/federation/v1/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: { capability: "web_search" },
          hop_count: 0,
          max_hops: 2,
          visited: [],
          query_id: "q-tolerant",
          origin_relay: "any-relay",
        }),
      });
      expect(res.status).toBe(200);
      await tolerant.close();
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

  // ── Self-propose: refused (relay-federation@1.5 §3.1) ──
  //
  // A self-propose used to return this relay's signature over
  // `{own_id}:{nonce}:{suite}` for any caller-chosen nonce — exactly the
  // step-3 confirm bytes, a public confirm oracle (identity-authority-writers
  // §5.2 G1). It is now refused before anything is signed or stored; the
  // relay's confirm is minted only by its operator on the master-token
  // `POST /api/v1/admin/federation/peer-confirm-signature`.

  describe("self-propose (relay_id == own id)", () => {
    let relay: SyncRelay;

    beforeEach(async () => {
      relay = await createRelay({
        endpointUrl: "http://self.test:3000",
        enabled: true,
      });
    });

    it("is refused with 400 and returns no challenge", async () => {
      const ownId = relay.relayIdentity.relayMotebitId;
      const ownPk = relay.relayIdentity.publicKeyHex;

      const res = await relay.app.request("/federation/v1/peer/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relay_id: ownId,
          public_key: ownPk,
          endpoint_url: "http://self.test:3000",
          nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        }),
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toMatch(/self-propose is refused/);
      expect(text).toMatch(/peer-confirm-signature/);
      expect(text).not.toMatch(/challenge/);
    });

    it("the operator's confirm mint signs a v2 peer-confirm for ONE recipient and its own endpoint, under the master token only", async () => {
      const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      const mint = (body: unknown, auth = true) =>
        relay.app.request("/api/v1/admin/federation/peer-confirm-signature", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(auth ? AUTH_HEADER : {}) },
          body: JSON.stringify(body),
        });
      const bKey = "bb".repeat(32);
      const to = { recipient: "relay-b", recipient_public_key: bKey };
      expect((await mint({ nonce, ...to }, false)).status).toBe(401);

      const res = await mint({ nonce, ...to });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        relay_id: string;
        nonce: string;
        endpoint_url: string;
        message: unknown;
      };
      expect(body.relay_id).toBe(relay.relayIdentity.relayMotebitId);
      expect(body.endpoint_url).toBe("http://self.test:3000");
      const v = await verifyFederationMessage(body.message, {
        kind: "peer-confirm",
        self: "relay-b",
        selfPublicKeyHex: bKey,
        expectedSender: relay.relayIdentity.relayMotebitId,
        senderPublicKeyHex: relay.relayIdentity.publicKeyHex,
        body: { nonce, endpoint_url: "http://self.test:3000" },
      });
      expect(v.ok).toBe(true);
      // The recipient by KEY is in the envelope (§3.5): a relay holding
      // relay-b's id under another key refuses it before anything else.
      const other = await verifyFederationMessage(body.message, {
        kind: "peer-confirm",
        self: "relay-b",
        selfPublicKeyHex: "cc".repeat(32),
        senderPublicKeyHex: relay.relayIdentity.publicKeyHex,
        body: { nonce, endpoint_url: "http://self.test:3000" },
      });
      expect(other).toEqual({ ok: false, reason: "wrong_recipient_key" });

      // A bare nonce, no recipient, itself as recipient, no recipient key, a
      // malformed key, its own key, a foreign endpoint: refused.
      expect((await mint({ nonce })).status).toBe(400);
      expect(
        (
          await mint({
            nonce,
            recipient: relay.relayIdentity.relayMotebitId,
            recipient_public_key: bKey,
          })
        ).status,
      ).toBe(400);
      expect((await mint({ nonce, recipient: "relay-b" })).status).toBe(400);
      expect((await mint({ nonce, recipient: "relay-b", recipient_public_key: "zz" })).status).toBe(
        400,
      );
      expect(
        (
          await mint({
            nonce,
            recipient: "relay-b",
            recipient_public_key: relay.relayIdentity.publicKeyHex,
          })
        ).status,
      ).toBe(400);
      expect((await mint({ nonce, ...to, endpoint_url: "http://attacker.test:3666" })).status).toBe(
        400,
      );
      expect((await mint({ nonce: "not-hex", ...to })).status).toBe(400);
    });

    it("does NOT persist a relay_peers row keyed on the relay's own id", async () => {
      const ownId = relay.relayIdentity.relayMotebitId;
      await relay.app.request("/federation/v1/peer/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relay_id: ownId,
          public_key: relay.relayIdentity.publicKeyHex,
          endpoint_url: "http://self.test:3000",
          nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        }),
      });

      const row = relay.moteDb.db
        .prepare("SELECT peer_relay_id, state FROM relay_peers WHERE peer_relay_id = ?")
        .get(ownId);
      expect(row).toBeUndefined();
    });

    it("non-self propose is answered and records a handshake, never a row (§3.1)", async () => {
      const peerId = "peer-not-self";
      const res = await proposePeer(relay, peerId);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { nonce?: string }).nonce).toMatch(/^[0-9a-f]{64}$/);

      // Unauthenticated, so it writes nothing: a relay_id never confirmed has
      // no row; one is born only from a verified confirm.
      const row = relay.moteDb.db
        .prepare("SELECT peer_relay_id, state FROM relay_peers WHERE peer_relay_id = ?")
        .get(peerId);
      expect(row).toBeUndefined();
    });
  });
});

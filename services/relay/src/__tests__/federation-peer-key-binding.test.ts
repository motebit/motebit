/**
 * A federation peer's identity key is bound to its relay id.
 *
 * `/federation/v1/peer/propose` + `/confirm` are unauthenticated (see
 * federation-peer-authority.test.ts), and the propose upsert overwrote the
 * stored key of a peer in `suspended` or `removed` state. Anyone who knew the
 * id could re-propose it under their OWN key, confirm (proving control of
 * that key — and nothing about the id), and inherit the row: active, the
 * attacker's key, and the old peer's earned `trust_score`.
 *
 * Invariant: a known peer id's key changes only by a verified succession or
 * explicit operator action, never by re-proposal. A re-proposal under the
 * SAME key (the legitimate peer re-peering after suspension) still works,
 * and a failed confirm never erases an established peer's row (which would
 * free the id for a fresh proposal under any key).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay } from "./test-helpers.js";
// eslint-disable-next-line no-restricted-imports -- the attacker needs raw key material
import { generateKeypair, sign, bytesToHex } from "@motebit/encryption";

const HOME_URL = "http://relay-home.test:3000";
const PEER_URL = "http://peer-relay.test:4000";
const ATTACKER_URL = "http://attacker-relay.test:5000";
const FEDERATION_SUITE = "motebit-concat-ed25519-hex-v1";

const rand = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

async function fed(
  relay: SyncRelay,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await relay.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

interface Keys {
  publicKeyHex: string;
  privateKey: Uint8Array;
}

async function keys(): Promise<Keys> {
  const kp = await generateKeypair();
  return { publicKeyHex: bytesToHex(kp.publicKey), privateKey: kp.privateKey };
}

async function propose(relay: SyncRelay, relayId: string, k: Keys, url: string) {
  return fed(relay, "/federation/v1/peer/propose", {
    relay_id: relayId,
    public_key: k.publicKeyHex,
    endpoint_url: url,
    nonce: rand(),
  });
}

async function confirm(relay: SyncRelay, relayId: string, nonce: string, k: Keys) {
  const challenge = await sign(
    new TextEncoder().encode(`${relayId}:${nonce}:${FEDERATION_SUITE}`),
    k.privateKey,
  );
  return fed(relay, "/federation/v1/peer/confirm", {
    relay_id: relayId,
    challenge_response: bytesToHex(challenge),
  });
}

interface PeerRow {
  public_key: string;
  state: string;
  trust_score: number;
  endpoint_url: string;
}

describe("federation — a peer id's key is not re-proposable", () => {
  let relay: SyncRelay;
  let peerId: string;
  let peer: Keys;

  const row = (): PeerRow | undefined =>
    relay.moteDb.db
      .prepare(
        "SELECT public_key, state, trust_score, endpoint_url FROM relay_peers WHERE peer_relay_id = ?",
      )
      .get(peerId) as PeerRow | undefined;

  beforeEach(async () => {
    relay = await createTestRelay({ federation: { endpointUrl: HOME_URL, displayName: "Home" } });
    peerId = `relay-${crypto.randomUUID()}`;
    peer = await keys();
    const p = await propose(relay, peerId, peer, PEER_URL);
    expect(p.status).toBe(200);
    const c = await confirm(relay, peerId, (p.body as { nonce: string }).nonce, peer);
    expect(c.status).toBe(200);
    // An established peer that earned trust.
    relay.moteDb.db
      .prepare("UPDATE relay_peers SET trust_score = 0.9 WHERE peer_relay_id = ?")
      .run(peerId);
  });

  afterEach(async () => {
    await relay.close();
  });

  for (const state of ["suspended", "removed"] as const) {
    it(`refuses a re-proposal under a different key for a ${state} peer`, async () => {
      relay.moteDb.db
        .prepare("UPDATE relay_peers SET state = ?, last_heartbeat_at = 1 WHERE peer_relay_id = ?")
        .run(state, peerId);

      const attacker = await keys();
      const p = await propose(relay, peerId, attacker, ATTACKER_URL);
      expect(p.status).toBe(409);
      if (p.status === 200) {
        await confirm(relay, peerId, (p.body as { nonce: string }).nonce, attacker);
      }

      const r = row()!;
      expect(r.public_key).toBe(peer.publicKeyHex);
      expect(r.state).toBe(state);
      expect(r.trust_score).toBe(0.9);
    });
  }

  it("lets the legitimate peer re-peer under its own key", async () => {
    relay.moteDb.db
      .prepare(
        "UPDATE relay_peers SET state = 'removed', last_heartbeat_at = 1 WHERE peer_relay_id = ?",
      )
      .run(peerId);
    const p = await propose(relay, peerId, peer, PEER_URL);
    expect(p.status).toBe(200);
    const c = await confirm(relay, peerId, (p.body as { nonce: string }).nonce, peer);
    expect(c.status).toBe(200);
    const r = row()!;
    expect(r.state).toBe("active");
    expect(r.public_key).toBe(peer.publicKeyHex);
    expect(r.trust_score).toBe(0.9);
  });

  it("a failed confirm never erases an established peer, so the id cannot be freed and re-taken", async () => {
    relay.moteDb.db
      .prepare(
        "UPDATE relay_peers SET state = 'removed', last_heartbeat_at = 1 WHERE peer_relay_id = ?",
      )
      .run(peerId);
    // The attacker re-proposes under the victim's PUBLIC key (it has no private key)...
    const p = await fed(relay, "/federation/v1/peer/propose", {
      relay_id: peerId,
      public_key: peer.publicKeyHex,
      endpoint_url: ATTACKER_URL,
      nonce: rand(),
    });
    expect(p.status).toBe(200);
    // ...fails the challenge on purpose...
    const attacker = await keys();
    const bad = await confirm(relay, peerId, (p.body as { nonce: string }).nonce, attacker);
    expect(bad.status).toBe(403);
    // ...and the row survives with its key and trust.
    const r = row();
    expect(r).toBeDefined();
    expect(r!.public_key).toBe(peer.publicKeyHex);
    expect(r!.trust_score).toBe(0.9);
    expect(r!.state).toBe("removed");

    // So a fresh proposal under the attacker's key is still refused.
    const again = await propose(relay, peerId, attacker, ATTACKER_URL);
    expect(again.status).toBe(409);
  });
});

describe("federation — an unconfirmed re-proposal never touches a known peer's row", () => {
  let relay: SyncRelay;
  let peerId: string;
  let peer: Keys;

  const row = (): PeerRow | undefined =>
    relay.moteDb.db
      .prepare(
        "SELECT public_key, state, trust_score, endpoint_url FROM relay_peers WHERE peer_relay_id = ?",
      )
      .get(peerId) as PeerRow | undefined;

  beforeEach(async () => {
    relay = await createTestRelay({ federation: { endpointUrl: HOME_URL, displayName: "Home" } });
    peerId = `relay-${crypto.randomUUID()}`;
    peer = await keys();
    const p = await propose(relay, peerId, peer, PEER_URL);
    expect(p.status).toBe(200);
    const c = await confirm(relay, peerId, (p.body as { nonce: string }).nonce, peer);
    expect(c.status).toBe(200);
    relay.moteDb.db
      .prepare("UPDATE relay_peers SET trust_score = 0.9 WHERE peer_relay_id = ?")
      .run(peerId);
  });

  afterEach(async () => {
    await relay.close();
  });

  for (const state of ["suspended", "removed"] as const) {
    it(`a stranger re-proposing a ${state} peer under its own public key cannot park it, and the peer still re-peers`, async () => {
      relay.moteDb.db
        .prepare("UPDATE relay_peers SET state = ?, last_heartbeat_at = 1 WHERE peer_relay_id = ?")
        .run(state, peerId);
      const before = row()!;

      // The stranger holds only the victim's PUBLIC key; it proposes and never confirms.
      const squat = await fed(relay, "/federation/v1/peer/propose", {
        relay_id: peerId,
        public_key: peer.publicKeyHex,
        endpoint_url: ATTACKER_URL,
        nonce: rand(),
      });
      expect(squat.status).toBe(200);
      // The stored row is exactly as before: state, key, endpoint, trust.
      expect(row()).toEqual(before);

      // A failed confirm leaves it exactly as before too.
      const attacker = await keys();
      const bad = await confirm(relay, peerId, (squat.body as { nonce: string }).nonce, attacker);
      expect(bad.status).toBe(403);
      expect(row()).toEqual(before);

      // The legitimate peer re-peers — not blocked by a parked 'pending' row,
      // and a second squat in between does not invalidate its challenge.
      const p = await propose(relay, peerId, peer, PEER_URL);
      expect(p.status).toBe(200);
      const squat2 = await fed(relay, "/federation/v1/peer/propose", {
        relay_id: peerId,
        public_key: peer.publicKeyHex,
        endpoint_url: ATTACKER_URL,
        nonce: rand(),
      });
      expect(squat2.status).toBe(200);
      const c = await confirm(relay, peerId, (p.body as { nonce: string }).nonce, peer);
      expect(c.status).toBe(200);
      const after = row()!;
      expect(after.state).toBe("active");
      expect(after.public_key).toBe(peer.publicKeyHex);
      expect(after.endpoint_url).toBe(PEER_URL);
      expect(after.trust_score).toBe(0.9);
    });
  }

  it("an expired proposal cannot be confirmed and leaves the row as before", async () => {
    relay.moteDb.db
      .prepare(
        "UPDATE relay_peers SET state = 'suspended', last_heartbeat_at = 1 WHERE peer_relay_id = ?",
      )
      .run(peerId);
    const before = row()!;
    const p = await propose(relay, peerId, peer, PEER_URL);
    expect(p.status).toBe(200);
    relay.moteDb.db
      .prepare("UPDATE relay_peer_proposals SET expires_at = 1 WHERE peer_relay_id = ?")
      .run(peerId);
    const c = await confirm(relay, peerId, (p.body as { nonce: string }).nonce, peer);
    expect(c.status).toBe(404);
    expect(row()).toEqual(before);
  });
});

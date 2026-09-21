/**
 * A federation peer has no authority over an identity this relay is the home of.
 *
 * The defect this forecloses (#704) was not a field-binding slip. Peering is
 * not an authorization: `/federation/v1/peer/propose` and
 * `/federation/v1/peer/confirm` are two unauthenticated calls and nothing
 * consults `autoAcceptPeers`, so anyone who can reach the relay can become a
 * peer whose signatures verify. The revocation ingest then applied
 * `agent_revoked` and `key_rotated` to `agent_registry` for whatever
 * `motebit_id` the event named — de-listing or re-keying an identity that had
 * never authorized anything.
 *
 * So the test must drive the COMPOSITION, not the handler. `processIncomingRevocations`
 * already had unit coverage — including a "wrong key is rejected" case that
 * READS like authority enforcement while only testing signature validity. That
 * aperture is exactly why the defect survived: the function was never the
 * problem, and calling it directly can never show the problem. Every step here
 * goes through the real route, with a real admission, against a real local
 * identity.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay, createAgent, JSON_AUTH, AUTH_HEADER } from "./test-helpers.js";
// eslint-disable-next-line no-restricted-imports -- the attacker needs raw key material
import { generateKeypair, sign, bytesToHex } from "@motebit/encryption";

const HOME_URL = "http://relay-home.test:3000";
const ATTACKER_URL = "http://attacker-relay.test:4000";
const FEDERATION_SUITE = "motebit-concat-ed25519-hex-v1";

const rand = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

/** Any federation route, with NO Authorization header — that is the point. */
async function fed(
  relay: SyncRelay,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await relay.app.request(path, {
    method,
    headers: body != null ? { "Content-Type": "application/json" } : {},
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

interface Peer {
  relayId: string;
  publicKeyHex: string;
  privateKey: Uint8Array;
}

/**
 * Become an active peer of `relay` from nothing but a freshly generated
 * keypair. No admin token, no operator approval, no allowlist entry.
 */
async function becomePeer(relay: SyncRelay): Promise<Peer> {
  const kp = await generateKeypair();
  const peer: Peer = {
    relayId: `relay-${crypto.randomUUID()}`,
    publicKeyHex: bytesToHex(kp.publicKey),
    privateKey: kp.privateKey,
  };

  const propose = await fed(relay, "POST", "/federation/v1/peer/propose", {
    relay_id: peer.relayId,
    public_key: peer.publicKeyHex,
    endpoint_url: ATTACKER_URL,
    nonce: rand(),
  });
  expect(propose.status).toBe(200);
  const ourNonce = (propose.body as { nonce: string }).nonce;

  // The confirm proves control of the key we just supplied — and nothing else.
  const challenge = await sign(
    new TextEncoder().encode(`${peer.relayId}:${ourNonce}:${FEDERATION_SUITE}`),
    peer.privateKey,
  );
  const confirm = await fed(relay, "POST", "/federation/v1/peer/confirm", {
    relay_id: peer.relayId,
    challenge_response: bytesToHex(challenge),
  });
  expect(confirm.status).toBe(200);
  expect((confirm.body as { status: string }).status).toBe("active");

  return peer;
}

/** Send a heartbeat carrying revocation events, each signed by the peer itself. */
async function heartbeatWith(
  relay: SyncRelay,
  peer: Peer,
  events: Array<{
    type: string;
    motebit_id: string;
    new_public_key?: string;
    credential_id?: string;
  }>,
): Promise<number> {
  const timestamp = Date.now();
  const enc = new TextEncoder();
  const revocations = [];
  for (const e of events) {
    const sig = await sign(
      enc.encode(`revocation:${e.type}:${e.motebit_id}:${timestamp}`),
      peer.privateKey,
    );
    revocations.push({ ...e, timestamp, signature: bytesToHex(sig) });
  }
  const beat = await sign(
    enc.encode(`${peer.relayId}|${timestamp}|${FEDERATION_SUITE}`),
    peer.privateKey,
  );
  const res = await fed(relay, "POST", "/federation/v1/peer/heartbeat", {
    relay_id: peer.relayId,
    timestamp,
    agent_count: 0,
    signature: bytesToHex(beat),
    revocations,
  });
  return res.status;
}

/**
 * The identity as the relay's own consumers see it. `/api/v1/discover/:id`
 * always answers 200 and carries the verdict in `found`, so the assertions
 * read `found`, never the status code.
 */
async function resolve(
  relay: SyncRelay,
  motebitId: string,
): Promise<{ found: boolean; publicKey: string | undefined }> {
  const res = await relay.app.request(`/api/v1/discover/${motebitId}`, { headers: AUTH_HEADER });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    found?: boolean;
    public_key?: string;
    agent?: { public_key?: string };
  };
  return { found: body.found === true, publicKey: body.public_key ?? body.agent?.public_key };
}

describe("federation — a peer has no authority over a locally held identity", () => {
  let relay: SyncRelay;
  let victimId: string;
  let victimKeyHex: string;

  beforeEach(async () => {
    relay = await createTestRelay({
      federation: { endpointUrl: HOME_URL, displayName: "Home" },
    });
    const kp = await generateKeypair();
    victimKeyHex = bytesToHex(kp.publicKey);
    const agent = await createAgent(relay, victimKeyHex);
    victimId = agent.motebitId;
    // The row a peer must not be able to touch.
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: victimId,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["web_search"],
        public_key: victimKeyHex,
      }),
    });
    expect(reg.status).toBe(200);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("admits a peer with no authorization at all — the premise the rest rests on", async () => {
    // Not an assertion about the fix. It records WHY a peer signature cannot
    // be a trust anchor: this is four unauthenticated calls from a keypair.
    const peer = await becomePeer(relay);
    expect(peer.relayId).toMatch(/^relay-/);
  });

  it("cannot replace the key of an identity this relay holds", async () => {
    const peer = await becomePeer(relay);
    const attackerKey = bytesToHex((await generateKeypair()).publicKey);

    const status = await heartbeatWith(relay, peer, [
      { type: "key_rotated", motebit_id: victimId, new_public_key: attackerKey },
    ]);
    expect(status).toBe(200); // the heartbeat itself is honest traffic

    const after = await resolve(relay, victimId);
    expect(after.found).toBe(true);
    expect(after.publicKey).toBe(victimKeyHex);
    expect(after.publicKey).not.toBe(attackerKey);
  });

  it("cannot revoke an identity this relay holds", async () => {
    const peer = await becomePeer(relay);

    const status = await heartbeatWith(relay, peer, [
      { type: "agent_revoked", motebit_id: victimId },
    ]);
    expect(status).toBe(200);

    // Still resolvable: `revoked = 1` is what would remove it from discovery.
    const after = await resolve(relay, victimId);
    expect(after.found).toBe(true);
    expect(after.publicKey).toBe(victimKeyHex);
  });

  it("still applies the owner-authorized door — the fix refuses peers, not revocation", async () => {
    const res = await relay.app.request(`/api/v1/agents/${victimId}/revoke-listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: "operator_test_cleanup" }),
    });
    expect(res.status).toBe(200);

    const after = await resolve(relay, victimId);
    expect(after.found).toBe(false);
  });

  it("cannot revoke a credential — it is neither the subject nor the issuer", async () => {
    // This test previously asserted the OPPOSITE, and that was the defect
    // wearing a requirement's clothes. The relay's own door for this act
    // answers 403 "Only the credential subject or issuer can revoke"
    // (`credentials.ts`, checked against `relay_credentials.issuer_did`). A
    // peer is neither principal, and nothing in the event asserts it speaks
    // for one, so the same rule has to hold at this door.
    const peer = await becomePeer(relay);
    const credentialId = `cred-${crypto.randomUUID()}`;

    const before = await relay.app.request(`/api/v1/credentials/${credentialId}/status`);
    expect(((await before.json()) as { revoked: boolean }).revoked).toBe(false);

    const status = await heartbeatWith(relay, peer, [
      { type: "credential_revoked", motebit_id: victimId, credential_id: credentialId },
    ]);
    expect(status).toBe(200); // liveness: the heartbeat is still honest traffic

    const after = await relay.app.request(`/api/v1/credentials/${credentialId}/status`);
    expect(((await after.json()) as { revoked: boolean }).revoked).toBe(false);
  });

  it("cannot poison a credential id that has not been issued yet", async () => {
    // `relay_revoked_credentials` has no foreign key and the write was
    // `INSERT OR IGNORE`, so the named id never had to exist. The consumer
    // that makes this bite is credential submission, which rejects an id
    // already present in that table — a credential could be killed before it
    // was ever minted.
    const peer = await becomePeer(relay);
    const futureId = `urn:uuid:${crypto.randomUUID()}`;

    await heartbeatWith(relay, peer, [
      { type: "credential_revoked", motebit_id: victimId, credential_id: futureId },
    ]);

    const status = await relay.app.request(`/api/v1/credentials/${futureId}/status`);
    expect(((await status.json()) as { revoked: boolean }).revoked).toBe(false);
  });

  it("keeps the subject-or-issuer door working — the fix refuses peers, not revocation", async () => {
    // The positive control that stops this becoming a blanket "deny everything
    // credential-shaped". The owner-authorized door must still revoke.
    const credentialId = `cred-${crypto.randomUUID()}`;
    const res = await relay.app.request(`/api/v1/agents/${victimId}/revoke-credential`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ credential_id: credentialId, reason: "owner revoked" }),
    });
    expect(res.status).toBe(200);

    const after = await relay.app.request(`/api/v1/credentials/${credentialId}/status`);
    expect(((await after.json()) as { revoked: boolean }).revoked).toBe(true);
  });

  it("leaves an honest peer's feed about its OWN identities working", async () => {
    const peer = await becomePeer(relay);
    // An identity this relay does not hold — the legitimate direction of the feed.
    const status = await heartbeatWith(relay, peer, [
      {
        type: "key_rotated",
        motebit_id: `mid-${crypto.randomUUID()}`,
        new_public_key: bytesToHex((await generateKeypair()).publicKey),
      },
      { type: "agent_revoked", motebit_id: `mid-${crypto.randomUUID()}` },
    ]);
    expect(status).toBe(200);

    // and the local identity is untouched by any of it
    const after = await resolve(relay, victimId);
    expect(after.publicKey).toBe(victimKeyHex);
  });
});

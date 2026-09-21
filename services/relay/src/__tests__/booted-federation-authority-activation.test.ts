/**
 * Booted entry — a federation peer has no authority over an identity this
 * relay serves (docs/doctrine/composition-preserves-enforcement.md).
 *
 * The in-process suite (`federation-peer-authority.test.ts`) proves the repo is
 * correct. This one boots the COMPILED artifact — the same `node dist/server.js`
 * line `run.sh`, `package.json#start` and the DEPLOY.md systemd unit exec — and
 * runs the real attack against it over real HTTP, because the defect it guards
 * was never a logic error in a function. `processIncomingRevocations` had unit
 * coverage, including a "wrong key is rejected" case that READS like authority
 * enforcement while only testing signature validity. What was wrong lived in
 * the composition: peering is not an authorization, so a valid peer signature
 * is something any caller can produce for itself.
 *
 * The attack, end to end, with no credential of any kind:
 *   1. POST /federation/v1/peer/propose   — unauthenticated
 *   2. POST /federation/v1/peer/confirm   — unauthenticated; state becomes 'active'
 *   3. POST /federation/v1/peer/heartbeat — carries revocations[] the peer signs itself
 *
 * Setup is asserted before protection is: a suite that silently failed to
 * register the victim would report "the identity was not re-keyed" about an
 * identity that never existed. Every arrange step below is checked.
 *
 * Traffic is entirely local. The relay's outbound policy refuses a
 * non-resolvable or non-public `endpoint_url` (`resolution_failed` /
 * `host_not_public`), which would otherwise force a public hostname and a DNS
 * dependency into CI; `MOTEBIT_ALLOW_PRIVATE_ENDPOINTS` is the existing
 * local-development allowance other booted suites already use, so the hostile
 * peer advertises a loopback address and nothing leaves the machine.
 *
 * Severing that must red this suite: restore either `agent_registry` write, or
 * the credential write, in `processIncomingRevocations`
 * (services/relay/src/federation.ts). Continuously reintroduced by
 * `scripts/check-activation-effective.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// eslint-disable-next-line no-restricted-imports -- the hostile peer needs raw key material
import { generateKeypair, sign, bytesToHex } from "@motebit/encryption";
import {
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  BOOT_TIMEOUT_MS,
  type BootedEntry,
} from "./booted-entry-harness.js";

const MASTER_TOKEN = "booted-federation-authority-master";
const FEDERATION_SUITE = "motebit-concat-ed25519-hex-v1";
/** Loopback, so the hostile peer's advertised endpoint needs no DNS. */
const PEER_ENDPOINT = "http://127.0.0.1:9/peer";
const AGENT_ENDPOINT = "http://127.0.0.1:9/mcp";

const rand = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

interface Victim {
  motebitId: string;
  publicKeyHex: string;
}

/** A legitimate identity, registered the way a real one is. Every step asserted. */
async function provisionVictim(baseUrl: string): Promise<Victim> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_TOKEN}` };
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);

  const idRes = await fetch(`${baseUrl}/identity`, {
    method: "POST",
    headers,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  // 201 over real HTTP; the in-process harness is not the authority on this.
  expect([200, 201], "arrange: identity creation").toContain(idRes.status);
  const { motebit_id: motebitId } = (await idRes.json()) as { motebit_id: string };

  const devRes = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      motebit_id: motebitId,
      device_name: "booted",
      public_key: publicKeyHex,
    }),
  });
  expect([200, 201], "arrange: device registration").toContain(devRes.status);

  const regRes = await fetch(`${baseUrl}/api/v1/agents/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: AGENT_ENDPOINT,
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
  expect([200, 201], "arrange: agent_registry row — the row a peer must not touch").toContain(
    regRes.status,
  );

  return { motebitId, publicKeyHex };
}

interface HostilePeer {
  relayId: string;
  privateKey: Uint8Array;
}

/** Become an active peer of the booted relay with nothing but a fresh keypair. */
async function becomeActivePeer(baseUrl: string): Promise<HostilePeer> {
  const kp = await generateKeypair();
  const relayId = `relay-${crypto.randomUUID()}`;
  const headers = { "Content-Type": "application/json" };

  const propose = await fetch(`${baseUrl}/federation/v1/peer/propose`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      relay_id: relayId,
      public_key: bytesToHex(kp.publicKey),
      endpoint_url: PEER_ENDPOINT,
      nonce: rand(),
    }),
  });
  expect(propose.status, "arrange: propose is accepted with no authorization").toBe(200);
  const { nonce } = (await propose.json()) as { nonce: string };

  const challenge = await sign(
    new TextEncoder().encode(`${relayId}:${nonce}:${FEDERATION_SUITE}`),
    kp.privateKey,
  );
  const confirm = await fetch(`${baseUrl}/federation/v1/peer/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ relay_id: relayId, challenge_response: bytesToHex(challenge) }),
  });
  expect(confirm.status, "arrange: confirm is accepted with no authorization").toBe(200);
  const confirmBody = (await confirm.json()) as { status: string };
  // The premise the whole suite rests on, asserted rather than assumed.
  expect(confirmBody.status, "arrange: a bare keypair reaches peer state 'active'").toBe("active");

  return { relayId, privateKey: kp.privateKey };
}

/** Heartbeat carrying revocation events the peer signs for itself. */
async function heartbeatWith(
  baseUrl: string,
  peer: HostilePeer,
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
  const res = await fetch(`${baseUrl}/federation/v1/peer/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: peer.relayId,
      timestamp,
      agent_count: 0,
      signature: bytesToHex(beat),
      revocations,
    }),
  });
  return res.status;
}

async function resolveIdentity(
  baseUrl: string,
  motebitId: string,
): Promise<{ found: boolean; publicKey: string | undefined }> {
  const res = await fetch(`${baseUrl}/api/v1/discover/${motebitId}`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    found?: boolean;
    public_key?: string;
    agent?: { public_key?: string };
  };
  return { found: body.found === true, publicKey: body.public_key ?? body.agent?.public_key };
}

async function credentialRevoked(baseUrl: string, credentialId: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/v1/credentials/${credentialId}/status`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { revoked: boolean }).revoked;
}

describe("booted entry — a federation peer cannot write identity state in the deployed artifact", () => {
  let booted: BootedEntry | null = null;
  let victim: Victim;
  let peer: HostilePeer;

  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER, {
      MOTEBIT_API_TOKEN: MASTER_TOKEN,
      // Keeps the hostile peer's advertised endpoint on loopback: no DNS in CI.
      MOTEBIT_ALLOW_PRIVATE_ENDPOINTS: "1",
    });
    victim = await provisionVictim(booted.baseUrl);
    peer = await becomeActivePeer(booted.baseUrl);
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    killBootedEntry(booted);
  });

  it("arrange holds: the victim resolves with its own key before any attack", async () => {
    const before = await resolveIdentity(booted!.baseUrl, victim.motebitId);
    expect(before.found).toBe(true);
    expect(before.publicKey).toBe(victim.publicKeyHex);
  });

  it("refuses a peer's key_rotated — the identity keeps its own key", async () => {
    const attackerKey = bytesToHex((await generateKeypair()).publicKey);
    const status = await heartbeatWith(booted!.baseUrl, peer, [
      { type: "key_rotated", motebit_id: victim.motebitId, new_public_key: attackerKey },
    ]);
    // The event is ACKNOWLEDGED as honest transport and NOT APPLIED. A non-200
    // here would be a different bug (peer liveness broken by the guard).
    expect(status).toBe(200);

    const after = await resolveIdentity(booted!.baseUrl, victim.motebitId);
    expect(after.publicKey).toBe(victim.publicKeyHex);
    expect(after.publicKey).not.toBe(attackerKey);
  });

  it("refuses a peer's agent_revoked — the identity stays discoverable", async () => {
    const status = await heartbeatWith(booted!.baseUrl, peer, [
      { type: "agent_revoked", motebit_id: victim.motebitId },
    ]);
    expect(status).toBe(200);

    const after = await resolveIdentity(booted!.baseUrl, victim.motebitId);
    expect(after.found).toBe(true);
  });

  it("refuses a peer's credential_revoked, including an id never issued", async () => {
    const credentialId = `urn:uuid:${crypto.randomUUID()}`;
    expect(await credentialRevoked(booted!.baseUrl, credentialId)).toBe(false);

    const status = await heartbeatWith(booted!.baseUrl, peer, [
      { type: "credential_revoked", motebit_id: victim.motebitId, credential_id: credentialId },
    ]);
    expect(status).toBe(200);

    expect(await credentialRevoked(booted!.baseUrl, credentialId)).toBe(false);
  });
});

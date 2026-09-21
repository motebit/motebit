/**
 * Who may revoke a credential — the rule the relay states, finally asserted.
 *
 * `POST /api/v1/agents/:motebitId/revoke-credential` answers 403 "Only the
 * credential subject or issuer can revoke". Until this file, that rule had
 * coverage for exactly two cases: no token (`listing-auth.test.ts`) and the
 * operator master token (`revocation.test.ts`), both of which miss it — the
 * operator path short-circuits the check entirely, because a master-token
 * request sets no `callerMotebitId`.
 *
 * So the two principals the rule NAMES were asserted nowhere, and the rule was
 * binding to the wrong thing: `isSubject` compared the caller to the PATH
 * SEGMENT, which the caller chooses, and never to the credential being
 * revoked. An agent authenticated as itself could revoke anyone's credential.
 *
 * Every test here mints a real signed device token. A master token would take
 * the operator bypass and prove nothing about subject or issuer — which is how
 * the gap survived, so it is worth saying twice.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay, JSON_AUTH, AUTH_HEADER } from "./test-helpers.js";
// eslint-disable-next-line no-restricted-imports -- these tests need real key material
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import { hexPublicKeyToDidKey } from "@motebit/crypto";

interface Agent {
  motebitId: string;
  token: string;
  did: string;
  publicKeyHex: string;
}

/**
 * An identity with a device and a real signed token for the route's audience.
 *
 * `decoyDevicesFirst` registers throwaway devices BEFORE the one whose key
 * becomes the issuer DID. That ordering is the whole point: `listDevices` is
 * `SELECT * FROM devices WHERE motebit_id = ?` with no ORDER BY, so a check
 * reading `devices[0]` consults a decoy and refuses a legitimate issuer.
 * Registering the decoys AFTER leaves the issuing key first and the test
 * passes against the broken code — found by tampering, which is why the
 * ordering is spelled out here rather than left to look incidental.
 */
async function agent(relay: SyncRelay, decoyDevicesFirst = 0): Promise<Agent> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);

  const idRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  expect([200, 201], "arrange: identity").toContain(idRes.status);
  const { motebit_id: motebitId } = (await idRes.json()) as { motebit_id: string };

  for (let i = 0; i < decoyDevicesFirst; i++) {
    const decoy = await generateKeypair();
    const r = await relay.app.request("/device/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: motebitId,
        device_name: `decoy-${i}`,
        public_key: bytesToHex(decoy.publicKey),
      }),
    });
    expect([200, 201], "arrange: decoy device").toContain(r.status);
  }

  const devRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      device_name: "signing",
      public_key: publicKeyHex,
    }),
  });
  expect([200, 201], "arrange: device").toContain(devRes.status);
  const { device_id: deviceId } = (await devRes.json()) as { device_id: string };

  const token = await createSignedToken(
    {
      mid: motebitId,
      did: deviceId,
      iat: Date.now(),
      exp: Date.now() + 300_000,
      jti: crypto.randomUUID(),
      aud: "admin:query",
    },
    kp.privateKey,
  );
  return { motebitId, token, did: hexPublicKeyToDidKey(publicKeyHex), publicKeyHex };
}

function seedCredential(relay: SyncRelay, subject: string, issuerDid: string): string {
  const credentialId = `urn:uuid:${crypto.randomUUID()}`;
  relay.moteDb.db
    .prepare(
      "INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at) VALUES (?,?,?,?,?,?)",
    )
    .run(credentialId, subject, issuerDid, "AgentReputationCredential", "{}", Date.now());
  return credentialId;
}

async function revoke(
  relay: SyncRelay,
  pathId: string,
  credentialId: string,
  auth: Record<string, string>,
): Promise<number> {
  const res = await relay.app.request(`/api/v1/agents/${pathId}/revoke-credential`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ credential_id: credentialId, reason: "test" }),
  });
  return res.status;
}

async function revoked(relay: SyncRelay, credentialId: string): Promise<boolean> {
  const res = await relay.app.request(
    `/api/v1/credentials/${encodeURIComponent(credentialId)}/status`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { revoked: boolean }).revoked;
}

describe("revoke-credential — authority binds to the credential, not to the path", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("a third party naming ITSELF in the path cannot revoke another agent's credential", async () => {
    const victim = await agent(relay);
    const attacker = await agent(relay);
    const credentialId = seedCredential(relay, victim.motebitId, "did:key:zSomeOtherIssuer");

    const status = await revoke(relay, attacker.motebitId, credentialId, {
      Authorization: `Bearer ${attacker.token}`,
    });
    expect(status).not.toBe(200);
    expect(await revoked(relay, credentialId)).toBe(false);
  });

  it("a third party naming the VICTIM in the path cannot revoke it either", async () => {
    const victim = await agent(relay);
    const attacker = await agent(relay);
    const credentialId = seedCredential(relay, victim.motebitId, "did:key:zSomeOtherIssuer");

    const status = await revoke(relay, victim.motebitId, credentialId, {
      Authorization: `Bearer ${attacker.token}`,
    });
    expect(status).toBe(403);
    expect(await revoked(relay, credentialId)).toBe(false);
  });

  it("the SUBJECT revokes its own credential", async () => {
    const subject = await agent(relay);
    const credentialId = seedCredential(relay, subject.motebitId, "did:key:zSomeOtherIssuer");

    const status = await revoke(relay, subject.motebitId, credentialId, {
      Authorization: `Bearer ${subject.token}`,
    });
    expect(status).toBe(200);
    expect(await revoked(relay, credentialId)).toBe(true);
  });

  it("the ISSUER revokes a credential it issued, even with several devices", async () => {
    const subject = await agent(relay);
    // Three decoys registered BEFORE the issuing key — see `agent()`.
    const issuer = await agent(relay, 3);
    const credentialId = seedCredential(relay, subject.motebitId, issuer.did);

    const status = await revoke(relay, subject.motebitId, credentialId, {
      Authorization: `Bearer ${issuer.token}`,
    });
    expect(status).toBe(200);
    expect(await revoked(relay, credentialId)).toBe(true);
  });

  it("an agent cannot deny a credential id this relay does not hold", async () => {
    const caller = await agent(relay);
    const neverIssued = `urn:uuid:${crypto.randomUUID()}`;

    const status = await revoke(relay, caller.motebitId, neverIssued, {
      Authorization: `Bearer ${caller.token}`,
    });
    expect(status).toBe(404);
    expect(await revoked(relay, neverIssued)).toBe(false);
  });

  it("the OPERATOR may still blocklist an id this relay does not hold", async () => {
    // Predates this change and is exercised by `revocation.test.ts`; bounded
    // by holding the operator token. Asserted here so narrowing the agent
    // path cannot silently take it away.
    const holder = await agent(relay);
    const neverIssued = `urn:uuid:${crypto.randomUUID()}`;

    const status = await revoke(relay, holder.motebitId, neverIssued, AUTH_HEADER);
    expect(status).toBe(200);
    expect(await revoked(relay, neverIssued)).toBe(true);
  });

  it("files the row under the credential's holder and names the requester", async () => {
    // Honest about what this guards. Attribution is ENTAILED by the
    // path-consistency check: once a mismatch between the path segment and the
    // credential's subject is refused, reading the subject from the row and
    // reading it from the path cannot differ for any request that gets this
    // far. Tampering attribution alone leaves this green — checked — so the
    // check that must never be removed is the path one, and that is the tamper
    // this file relies on. The assertion stays because this row IS the
    // moderation record and `revoked_by` is its only attribution.
    const subject = await agent(relay);
    const issuer = await agent(relay);
    const credentialId = seedCredential(relay, subject.motebitId, issuer.did);

    expect(
      await revoke(relay, subject.motebitId, credentialId, {
        Authorization: `Bearer ${issuer.token}`,
      }),
    ).toBe(200);

    const row = relay.moteDb.db
      .prepare(
        "SELECT motebit_id, revoked_by FROM relay_revoked_credentials WHERE credential_id = ?",
      )
      .get(credentialId) as { motebit_id: string; revoked_by: string };
    expect(row.motebit_id).toBe(subject.motebitId);
    expect(row.revoked_by).toBe(issuer.motebitId);
  });
});

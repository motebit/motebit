/**
 * #850 — two doors that filed a signed artifact under an identity the
 * request never proved a relationship to.
 *
 * 1. `POST /api/v1/agents/:id/credentials/submit` filed each credential under
 *    the PATH id, never the credential's own `credentialSubject.id`. The row's
 *    subject is who `revoke-credential` lets revoke it (spec/credential-v1.md
 *    §6.2), so X filed V's credential under X, then revoked it as its
 *    "subject" — relay-wide, for V.
 * 2. `POST /api/v1/delegations/revocations` verified a revocation against the
 *    key EMBEDDED in it, never a key the relay holds for the delegator it
 *    names. A stranger's own keypair signed a revocation naming V as the
 *    delegator of any grant_id, and the acceptance fence refused that
 *    grant's tasks.
 *
 * Identities here are real: sovereign ids registered through
 * `register-self` (holder + device row), rotated through the real
 * `rotate-key` route, and authenticated with real signed tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hexPublicKeyToDidKey,
  mintAudienceToken,
  signDelegationRevocation,
  signDeviceRegistration,
  signKeySuccession,
  signVerifiableCredential,
  type DelegationRevocation,
  type KeyPair,
  type VerifiableCredential,
} from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { insertDelegationRevocation } from "../delegation-revocations.js";
import { bindByDelegationRevocation } from "../identity-binding.js";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface Identity {
  mid: string;
  device: string;
  kp: KeyPair;
  hex: string;
  did: string;
}

let relay: SyncRelay;

/** Is a revocation of `grantId` held in the relay's cache (by anyone)? */
function cached(grantId: string): boolean {
  return (
    relay.moteDb.db
      .prepare("SELECT 1 FROM relay_delegation_revocations WHERE grant_id = ?")
      .get(grantId) != null
  );
}

/** The auth-event rows recorded for `path` with `reason` (relay rule 6). */
function authEvents(
  path: string,
  reason: string,
): Array<{ kind: string; motebit_id: string | null }> {
  return relay.moteDb.db
    .prepare("SELECT kind, motebit_id FROM relay_auth_events WHERE path = ? AND reason = ?")
    .all(path, reason) as Array<{ kind: string; motebit_id: string | null }>;
}

beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

/** A registered identity: sovereign by default, or a legacy (non-sovereign) id. */
async function identity(legacyId?: string): Promise<Identity> {
  const kp = await generateKeypair();
  const hex = bytesToHex(kp.publicKey);
  const mid = legacyId ?? (await deriveSovereignMotebitId(hex));
  const device = `dev-${crypto.randomUUID()}`;
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: device,
      public_key: hex,
      device_name: "t",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  expect(res.status, "arrange: register-self").toBe(201);
  return { mid, device, kp, hex, did: hexPublicKeyToDidKey(hex) };
}

async function bearer(who: Identity, aud: TokenAudience): Promise<string> {
  return (await mintAudienceToken({ mid: who.mid, did: who.device, aud }, who.kp.privateKey)).token;
}

async function rotate(who: Identity, to: KeyPair): Promise<void> {
  const record = await signKeySuccession(
    who.kp.privateKey,
    to.privateKey,
    to.publicKey,
    who.kp.publicKey,
  );
  const res = await relay.app.request(`/api/v1/agents/${who.mid}/rotate-key`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${await bearer(who, "rotate-key")}` },
    body: JSON.stringify(record),
  });
  expect(res.status, "arrange: rotate-key").toBe(200);
}

// ── Item 1: credentials ──────────────────────────────────────────────────

async function credential(
  issuer: Identity,
  subjectId: string | undefined,
  id: string = `urn:uuid:${crypto.randomUUID()}`,
): Promise<VerifiableCredential> {
  const now = Date.now();
  return signVerifiableCredential(
    {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiableCredential", "AgentReputationCredential"],
      id,
      issuer: issuer.did,
      credentialSubject: {
        ...(subjectId !== undefined ? { id: subjectId } : {}),
        success_rate: 1,
        task_count: 3,
      },
      validFrom: new Date(now).toISOString(),
      validUntil: new Date(now + 3_600_000).toISOString(),
    } as never,
    issuer.kp.privateKey,
    issuer.kp.publicKey,
  ) as Promise<VerifiableCredential>;
}

async function submit(
  pathId: string,
  vcs: VerifiableCredential[],
): Promise<{ accepted: number; rejected: number; errors?: string[] }> {
  const res = await relay.app.request(`/api/v1/agents/${pathId}/credentials/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ credentials: vcs }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { accepted: number; rejected: number; errors?: string[] };
}

function heldSubject(credentialId: string): string | undefined {
  return (
    relay.moteDb.db
      .prepare("SELECT subject_motebit_id FROM relay_credentials WHERE credential_id = ?")
      .get(credentialId) as { subject_motebit_id: string } | undefined
  )?.subject_motebit_id;
}

async function revokeCredential(caller: Identity, pathId: string, credentialId: string) {
  return relay.app.request(`/api/v1/agents/${pathId}/revoke-credential`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${await bearer(caller, "admin:query")}` },
    body: JSON.stringify({ credential_id: credentialId, reason: "attack" }),
  });
}

async function isRevoked(credentialId: string): Promise<boolean> {
  const res = await relay.app.request(
    `/api/v1/credentials/${encodeURIComponent(credentialId)}/status`,
  );
  return ((await res.json()) as { revoked: boolean }).revoked;
}

describe("credentials/submit files a credential only under the identity it is about (#850 item 1)", () => {
  it("ATTACK: X files V's credential under X and revokes it as its subject — refused at submit; V's credential is not revoked", async () => {
    const issuer = await identity();
    const victim = await identity();
    const attacker = await identity();
    const vc = await credential(issuer, victim.did);
    const credId = (vc as unknown as { id: string }).id;

    const filed = await submit(attacker.mid, [vc]);
    expect(filed.accepted).toBe(0);
    expect(filed.errors).toEqual([
      "credential subject is not this identity (credential_subject:key_not_proven_for_path_identity)",
    ]);
    expect(heldSubject(credId)).toBeUndefined();

    const res = await revokeCredential(attacker, attacker.mid, credId);
    expect(res.status).toBe(404);
    expect(await isRevoked(credId)).toBe(false);

    // …and V's own copy still lands, under V.
    expect((await submit(victim.mid, [vc])).accepted).toBe(1);
    expect(heldSubject(credId)).toBe(victim.mid);
  });

  it("ATTACK, did:motebit spelling: a credential naming did:motebit:V is refused under X", async () => {
    const issuer = await identity();
    const victim = await identity();
    const attacker = await identity();
    const vc = await credential(issuer, `did:motebit:${victim.mid}`);
    expect((await submit(attacker.mid, [vc])).accepted).toBe(0);
    expect(heldSubject((vc as unknown as { id: string }).id)).toBeUndefined();
  });

  it("the issuer's submission about V (did:key of V's key) is filed under V; V then revokes it as its subject", async () => {
    const issuer = await identity();
    const subject = await identity();
    const vc = await credential(issuer, subject.did);
    const credId = (vc as unknown as { id: string }).id;

    expect(await submit(subject.mid, [vc])).toEqual({ accepted: 1, rejected: 0 });
    expect(heldSubject(credId)).toBe(subject.mid);
    // Re-submission of the same credential is idempotent, not a conflict.
    expect(await submit(subject.mid, [vc])).toEqual({ accepted: 1, rejected: 0 });

    const res = await revokeCredential(subject, subject.mid, credId);
    expect(res.status).toBe(200);
    expect(await isRevoked(credId)).toBe(true);
  });

  it("rule 6: a credential refused for naming another identity writes a relay_auth_events row", async () => {
    const issuer = await identity();
    const victim = await identity();
    const attacker = await identity();
    await submit(attacker.mid, [await credential(issuer, victim.did)]);
    const rows = authEvents(
      `/api/v1/agents/${attacker.mid}/credentials/submit`,
      "credential_subject:key_not_proven_for_path_identity",
    );
    expect(rows).toEqual([{ kind: "agent_token_rejected", motebit_id: null }]);
  });

  it("a did:motebit:V subject is filed under V", async () => {
    const issuer = await identity();
    const subject = await identity();
    const vc = await credential(issuer, `did:motebit:${subject.mid}`);
    expect((await submit(subject.mid, [vc])).accepted).toBe(1);
    expect(heldSubject((vc as unknown as { id: string }).id)).toBe(subject.mid);
  });

  it("a credential with no subject id, or an unsupported DID method, binds nobody", async () => {
    const issuer = await identity();
    const subject = await identity();
    const noSubject = await credential(issuer, undefined);
    const webDid = await credential(issuer, `did:web:${subject.mid}.example`);
    const out = await submit(subject.mid, [noSubject, webDid]);
    expect(out.accepted).toBe(0);
    expect(out.rejected).toBe(2);
  });

  // ── #850 review: only EVIDENCE binds a did:key — the sovereign commitment
  // or the #703 holder key. Registry and device-row keys, which bootstrap and
  // /agents/register write without proof of possession, never bind and never
  // block. (Probe: scratchpad/probes/rv850.probe.ts, S1/S2.)

  it("F1: a bootstrap squatting V's key under a new id is refused (#875), and a squat row an earlier relay admitted does NOT block V's did:key credentials", async () => {
    const issuer = await identity();
    const victim = await identity();
    expect((await submit(victim.mid, [await credential(issuer, victim.did)])).accepted).toBe(1);

    const squatId = `squat-${crypto.randomUUID()}`;
    const boot = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        motebit_id: squatId,
        device_id: `d-${crypto.randomUUID()}`,
        public_key: victim.hex,
      }),
    });
    // #875: the writer now demands proof of possession — the squat is refused.
    expect(boot.status).toBe(400);
    expect(((await boot.json()) as { code?: string }).code).toBe("KEY_PROOF_REQUIRED");
    // A squat row a pre-#875 relay admitted still binds nothing and blocks nothing.
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`d-${crypto.randomUUID()}`, squatId, `tok-${crypto.randomUUID()}`, victim.hex, 1);

    expect((await submit(victim.mid, [await credential(issuer, victim.did)])).accepted).toBe(1);
  });

  it("F2: X' registering V's key is refused (#875); a registry row an earlier relay admitted with V's key cannot file V's credential under X' or revoke it; V files it later", async () => {
    const issuer = await identity();
    const vKp = await generateKeypair();
    const vHex = bytesToHex(vKp.publicKey);
    const vDid = hexPublicKeyToDidKey(vHex);
    // X' is a legacy (non-sovereign) id: no E-sov, so its registry key is
    // whatever it wrote — here V's key.
    const xp = await identity(`legacy-${crypto.randomUUID()}`);
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${await bearer(xp, "admin:query")}` },
      body: JSON.stringify({
        endpoint_url: "http://127.0.0.1:9999/mcp",
        capabilities: [],
        public_key: vHex,
      }),
    });
    // #875: X' holds no proof of possession of V's key — the door refuses.
    expect(reg.status).toBe(400);
    expect(((await reg.json()) as { reason?: string }).reason).toBe("key_proof_missing");
    // A registry row a pre-#875 relay admitted: X' planted V's key there.
    relay.moteDb.db
      .prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at) VALUES (?, ?, ?, '[]', 1, 1, ?)",
      )
      .run(xp.mid, vHex, "http://127.0.0.1:9999/mcp", Date.now() + 86_400_000);

    const vc = await credential(issuer, vDid);
    const credId = (vc as unknown as { id: string }).id;
    const filed = await submit(xp.mid, [vc]);
    expect(filed.accepted).toBe(0);
    expect(heldSubject(credId)).toBeUndefined();
    expect((await revokeCredential(xp, xp.mid, credId)).status).toBe(404);
    expect(await isRevoked(credId)).toBe(false);

    // V is sovereign: its id commits to its key, registered here or not.
    const vMid = await deriveSovereignMotebitId(vHex);
    expect((await submit(vMid, [vc])).accepted).toBe(1);
    expect(heldSubject(credId)).toBe(vMid);
  });

  it("same key under two identities: a device row carrying V's key under X binds nothing for X; V still binds", async () => {
    const issuer = await identity();
    const victim = await identity();
    const other = await relay.app.request("/identity", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const { motebit_id: otherId } = (await other.json()) as { motebit_id: string };
    const dev = await relay.app.request("/device/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ motebit_id: otherId, device_name: "dup", public_key: victim.hex }),
    });
    expect([200, 201], "arrange: a second identity's device row holds V's key").toContain(
      dev.status,
    );
    const vc = await credential(issuer, victim.did);
    expect((await submit(otherId, [vc])).accepted).toBe(0);
    expect((await submit(victim.mid, [vc])).accepted).toBe(1);
  });

  it("a holder-keyed (non-sovereign) V binds its did:key; the issuer→subject flow works", async () => {
    const issuer = await identity();
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    const svc = `svc-${crypto.randomUUID()}`;
    // E-op: the operator registers a bare service identity with its key —
    // one of the evidence kinds that writes the #703 holder.
    const reg = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: svc,
        endpoint_url: "http://127.0.0.1:9999/mcp",
        capabilities: [],
        public_key: hex,
      }),
    });
    expect(reg.status).toBe(200);
    expect(
      (
        relay.moteDb.db
          .prepare("SELECT public_key FROM identity_keys WHERE motebit_id = ?")
          .get(svc) as { public_key: string } | undefined
      )?.public_key,
      "arrange: the holder is written",
    ).toBe(hex);

    const vc = await credential(issuer, hexPublicKeyToDidKey(hex));
    expect((await submit(svc, [vc])).accepted).toBe(1);
    expect(heldSubject((vc as unknown as { id: string }).id)).toBe(svc);
  });

  it("POPULATION CHANGE (#850 ruling A): a non-sovereign, holder-less subject's did:key credential is refused with key_not_proven_for_path_identity; its did:motebit credential still binds", async () => {
    // The shape that breaks on purpose: a legacy random id registered through
    // register-self (possession proven, but no sovereign commitment, so no
    // #703 holder is written). Main accepted its did:key credentials on the
    // strength of a device row; only evidence binds now. No remedy path
    // exists today: a rotation moves the holder only when one already exists
    // (`applySuccession`, E-link), and E-sov needs a sovereign id — so such an
    // identity's did:key credentials stay refused. PE ruling on #875 (option
    // b): legacy ids stay unfilled (#703 §5e/§5j); any remedy is a follow-up.
    const issuer = await identity();
    const legacy = await identity(`legacy-${crypto.randomUUID()}`);
    expect(
      relay.moteDb.db.prepare("SELECT 1 FROM identity_keys WHERE motebit_id = ?").get(legacy.mid),
      "arrange: no proven holder",
    ).toBeUndefined();

    const byKey = await submit(legacy.mid, [await credential(issuer, legacy.did)]);
    expect(byKey.accepted).toBe(0);
    expect(byKey.errors).toEqual([
      "credential subject is not this identity (credential_subject:key_not_proven_for_path_identity)",
    ]);
    expect(
      authEvents(
        `/api/v1/agents/${legacy.mid}/credentials/submit`,
        "credential_subject:key_not_proven_for_path_identity",
      ),
    ).toEqual([{ kind: "agent_token_rejected", motebit_id: null }]);

    const byId = await submit(legacy.mid, [await credential(issuer, `did:motebit:${legacy.mid}`)]);
    expect(byId).toEqual({ accepted: 1, rejected: 0 });
  });

  it("a legacy identity created by the operator (/identity + /device/register) is likewise refused for did:key", async () => {
    const issuer = await identity();
    const kp = await generateKeypair();
    const hex = bytesToHex(kp.publicKey);
    const created = await relay.app.request("/identity", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
    });
    const { motebit_id: legacy } = (await created.json()) as { motebit_id: string };
    await relay.app.request("/device/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ motebit_id: legacy, device_name: "d", public_key: hex }),
    });
    expect(
      (await submit(legacy, [await credential(issuer, hexPublicKeyToDidKey(hex))])).accepted,
    ).toBe(0);
    expect(
      (await submit(legacy, [await credential(issuer, `did:motebit:${legacy}`)])).accepted,
    ).toBe(1);
  });

  it("rotation: the genesis key (sovereign commitment) and the current holder key bind; an intermediate retired key does not", async () => {
    const issuer = await identity();
    const subject = await identity();
    const k1 = subject.kp;
    const k2 = await generateKeypair();
    const k3 = await generateKeypair();
    await rotate(subject, k2);
    subject.kp = k2;
    await rotate(subject, k3);
    const did = (kp: KeyPair) => hexPublicKeyToDidKey(bytesToHex(kp.publicKey));
    expect((await submit(subject.mid, [await credential(issuer, did(k2))])).accepted).toBe(0);
    expect((await submit(subject.mid, [await credential(issuer, did(k1))])).accepted).toBe(1);
    expect((await submit(subject.mid, [await credential(issuer, did(k3))])).accepted).toBe(1);
  });

  it("self-issued under two spellings — V's own key about did:motebit:V — is rejected", async () => {
    const self = await identity();
    const vc = await credential(self, `did:motebit:${self.mid}`);
    const out = await submit(self.mid, [vc]);
    expect(out.accepted).toBe(0);
    expect(out.errors).toContain("self-issued credential rejected");
  });

  it("the SAME credential re-submitted with its keys reordered is idempotent (accepted), not a conflict", async () => {
    const issuer = await identity();
    const subject = await identity();
    const vc = await credential(issuer, subject.did);
    expect(await submit(subject.mid, [vc])).toEqual({ accepted: 1, rejected: 0 });
    const reordered = Object.fromEntries(
      Object.entries(vc as unknown as Record<string, unknown>).reverse(),
    ) as unknown as VerifiableCredential;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(vc));
    expect(await submit(subject.mid, [reordered])).toEqual({ accepted: 1, rejected: 0 });
  });

  it("a different credential under an id already held is refused, not reported accepted", async () => {
    const issuer = await identity();
    const subject = await identity();
    const id = `urn:uuid:${crypto.randomUUID()}`;
    expect((await submit(subject.mid, [await credential(issuer, subject.did, id)])).accepted).toBe(
      1,
    );
    const second = await credential(issuer, `did:motebit:${subject.mid}`, id);
    const out = await submit(subject.mid, [second]);
    expect(out.accepted).toBe(0);
    expect(out.errors).toContain("credential_id is already held by a different credential");
  });
});

// ── Item 2: delegation revocations ───────────────────────────────────────

async function revocation(
  delegatorId: string,
  signer: KeyPair,
  grantId: string,
): Promise<DelegationRevocation> {
  return signDelegationRevocation(
    {
      grant_id: grantId,
      delegator_id: delegatorId,
      delegator_public_key: bytesToHex(signer.publicKey),
      revoked_at: Date.now(),
    },
    signer.privateKey,
  );
}

const postRevocation = (body: unknown) =>
  relay.app.request("/api/v1/delegations/revocations", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });

/**
 * `who` submits a task under `grantId`, authenticated by its OWN signed
 * `task:submit` token — so the relay's submitter is `who`, proven.
 */
async function submitTaskUnderGrant(who: Identity, grantId: string) {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: who.mid,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
    }),
  });
  return relay.app.request(`/agent/${who.mid}/task`, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${await bearer(who, "task:submit")}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ prompt: "daily research", grant_id: grantId }),
  });
}

describe("a delegation revocation binds to a key the relay holds for its delegator (#850 item 2)", () => {
  it("ATTACK: a stranger's own keypair signs a revocation naming V — refused 403; V's grant still admits tasks", async () => {
    const victim = await identity();
    const stranger = await generateKeypair();
    const grantId = `grant-${crypto.randomUUID()}`;

    const res = await postRevocation(await revocation(victim.mid, stranger, grantId));
    expect(res.status).toBe(403);
    expect(cached(grantId)).toBe(false);

    const task = await submitTaskUnderGrant(victim, grantId);
    expect(task.status).toBe(201);
  });

  it("ATTACK: registered X revokes V's grant_id under X's OWN key — recorded (X's statement), but it does NOT fence V's grant; V's own revocation does", async () => {
    const victim = await identity();
    const attacker = await identity();
    const grantId = `grant-${crypto.randomUUID()}`;

    // A valid, bound revocation — X signing about itself, naming V's grant_id.
    const res = await postRevocation(await revocation(attacker.mid, attacker.kp, grantId));
    expect(res.status).toBe(200);
    expect(cached(grantId)).toBe(true);

    // V's task under G is admitted: X's revocation has no relationship to V's grant.
    const admitted = await submitTaskUnderGrant(victim, grantId);
    expect(admitted.status).toBe(201);

    // V's own revocation of G does fence V's tasks.
    expect((await postRevocation(await revocation(victim.mid, victim.kp, grantId))).status).toBe(
      200,
    );
    const fenced = await submitTaskUnderGrant(victim, grantId);
    expect(fenced.status).toBe(403);
    expect(JSON.stringify(await fenced.json())).toContain("REVOKED");
  });

  it("rule 6: a refused revocation writes a relay_auth_events row naming the claimed delegator", async () => {
    const victim = await identity();
    const stranger = await generateKeypair();
    const res = await postRevocation(
      await revocation(victim.mid, stranger, `grant-${crypto.randomUUID()}`),
    );
    expect(res.status).toBe(403);
    const rows = authEvents(
      "/api/v1/delegations/revocations",
      "delegation_revocation:key_not_held_by_delegator",
    );
    expect(rows).toEqual([{ kind: "agent_token_rejected", motebit_id: victim.mid }]);
  });

  it("a revocation naming a delegator this relay does not know is refused", async () => {
    const kp = await generateKeypair();
    const grantId = `grant-${crypto.randomUUID()}`;
    const unknown = await deriveSovereignMotebitId(bytesToHex(kp.publicKey));
    const res = await postRevocation(await revocation(unknown, kp, grantId));
    expect(res.status).toBe(403);
    expect(cached(grantId)).toBe(false);
  });

  it("the delegator's own revocation is recorded — carried by anyone — and the fence refuses its grant", async () => {
    const delegator = await identity();
    const grantId = `grant-${crypto.randomUUID()}`;
    const res = await postRevocation(await revocation(delegator.mid, delegator.kp, grantId));
    expect(res.status).toBe(200);
    expect(cached(grantId)).toBe(true);

    const task = await submitTaskUnderGrant(delegator, grantId);
    expect(task.status).toBe(403);
  });

  it("a key the delegator rotated away from no longer revokes; the new key does", async () => {
    const delegator = await identity();
    const oldKp = delegator.kp;
    const newKp = await generateKeypair();
    await rotate(delegator, newKp);

    const g1 = `grant-${crypto.randomUUID()}`;
    expect((await postRevocation(await revocation(delegator.mid, oldKp, g1))).status).toBe(403);
    expect(cached(g1)).toBe(false);

    const g2 = `grant-${crypto.randomUUID()}`;
    expect((await postRevocation(await revocation(delegator.mid, newKp, g2))).status).toBe(200);
    expect(cached(g2)).toBe(true);
  });

  it("the writer refuses a revocation that does not name its bound delegator", async () => {
    const a = await identity();
    const b = await identity();
    const bound = await bindByDelegationRevocation(
      relay.moteDb.db,
      await revocation(a.mid, a.kp, "grant-a"),
    );
    if (!("bound" in bound)) throw new Error("arrange: a's own revocation must bind");
    const bs = await revocation(b.mid, b.kp, "grant-b");
    expect(() => insertDelegationRevocation(relay.moteDb.db, bound.bound, bs)).toThrow(
      /not the bound delegator/,
    );
    expect(cached("grant-b")).toBe(false);
  });

  it("a legacy delegator whose device row stores its key UPPER-case revokes its grant, and the fence refuses its task", async () => {
    const legacy = await identity(`legacy-${crypto.randomUUID()}`);
    // #758: device-registration-guard admits a legacy UPPER(K) spelling.
    relay.moteDb.db
      .prepare("UPDATE devices SET public_key = UPPER(public_key) WHERE motebit_id = ?")
      .run(legacy.mid);
    const grantId = `grant-${crypto.randomUUID()}`;
    expect((await postRevocation(await revocation(legacy.mid, legacy.kp, grantId))).status).toBe(
      200,
    );
    expect((await submitTaskUnderGrant(legacy, grantId)).status).toBe(403);
  });

  it("a tampered revocation is still 422 (not a signed statement)", async () => {
    const delegator = await identity();
    const rev = await revocation(delegator.mid, delegator.kp, "grant-a");
    const res = await postRevocation({ ...rev, grant_id: "grant-b" });
    expect(res.status).toBe(422);
  });
});

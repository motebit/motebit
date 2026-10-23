/**
 * A credential's `issuer` is bound to the key that signed it.
 *
 * The relay's credential doors — `POST /api/v1/agents/:id/credentials/submit`
 * (which indexes credentials that drive routing weight) and
 * `POST /api/v1/credentials/verify` — trust the issuer a credential NAMES once
 * `verifyVerifiableCredential` passes. A proof verifies under the key its own
 * `verificationMethod` names, so the verifier must also require that key to be
 * the issuer's; otherwise a party signs with its own key, names a trusted
 * issuer, and is indexed (and weighted) as that issuer's attestation.
 *
 * Identities are real: sovereign ids registered through `register-self`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hexPublicKeyToDidKey,
  signDeviceRegistration,
  signMigrationRequest,
  signVerifiableCredential,
  verifyCredentialAnchor,
  type KeyPair,
  type VerifiableCredential,
} from "@motebit/crypto";
import { aggregateCredentialReputation, type ReputationVC } from "@motebit/market";
import type { SyncRelay } from "../index.js";
import { createTestRelay, AUTH_HEADER, JSON_AUTH } from "./test-helpers.js";
import { relayMigrations } from "../migrations.js";
import { BOUND_ISSUER_SQL, isBoundRow } from "../credential-reads.js";
import { enrichWithHardwareAttestation } from "../agents.js";
import { cutCredentialBatch, getCredentialAnchorProof } from "../credential-anchoring.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface Identity {
  mid: string;
  kp: KeyPair;
  did: string;
}

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

async function identity(): Promise<Identity> {
  const kp = await generateKeypair();
  const hex = bytesToHex(kp.publicKey);
  const mid = await deriveSovereignMotebitId(hex);
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: `dev-${crypto.randomUUID()}`,
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
  return { mid, kp, did: hexPublicKeyToDidKey(hex) };
}

/** A reputation credential about `subjectId` NAMING `issuer`, signed by `signer`. */
async function credential(
  issuer: unknown,
  signer: KeyPair,
  subjectId: string,
): Promise<VerifiableCredential & { id: string }> {
  const now = Date.now();
  return signVerifiableCredential(
    {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiableCredential", "AgentReputationCredential"],
      id: `urn:uuid:${crypto.randomUUID()}`,
      issuer,
      credentialSubject: {
        id: subjectId,
        success_rate: 1,
        avg_latency_ms: 5,
        task_count: 50,
        trust_score: 1,
        availability: 1,
        sample_size: 50,
        measured_at: now,
      },
      validFrom: new Date(now).toISOString(),
      validUntil: new Date(now + 3_600_000).toISOString(),
    } as never,
    signer.privateKey,
    signer.publicKey,
  ) as Promise<VerifiableCredential & { id: string }>;
}

/** A reputation credential from `issuer` about `subjectId`, already past its validity window. */
async function expiredCredential(
  issuer: Identity,
  subjectId: string,
): Promise<VerifiableCredential & { id: string }> {
  const now = Date.now();
  return signVerifiableCredential(
    {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiableCredential", "AgentReputationCredential"],
      id: `urn:uuid:${crypto.randomUUID()}`,
      issuer: issuer.did,
      credentialSubject: {
        id: subjectId,
        success_rate: 1,
        avg_latency_ms: 5,
        task_count: 50,
        trust_score: 1,
        availability: 1,
        sample_size: 50,
        measured_at: now,
      },
      validFrom: new Date(now - 7_200_000).toISOString(),
      validUntil: new Date(now - 3_600_000).toISOString(),
    } as never,
    issuer.kp.privateKey,
    issuer.kp.publicKey,
  ) as Promise<VerifiableCredential & { id: string }>;
}

async function submit(pathId: string, vcs: VerifiableCredential[]) {
  const res = await relay.app.request(`/api/v1/agents/${pathId}/credentials/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ credentials: vcs }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { accepted: number; rejected: number; errors?: string[] };
}

function heldRows(subjectMid: string): Array<{ credential_json: string; issuer_did: string }> {
  return relay.moteDb.db
    .prepare(
      "SELECT credential_json, issuer_did FROM relay_credentials WHERE subject_motebit_id = ?",
    )
    .all(subjectMid) as Array<{ credential_json: string; issuer_did: string }>;
}

/** The weight routing would give the held credentials, with `trusted` fully trusted. */
function routingWeight(subjectMid: string, trusted: string): number {
  const vcs = heldRows(subjectMid).map((r) => JSON.parse(r.credential_json) as ReputationVC);
  const agg = aggregateCredentialReputation(vcs, (did) => (did === trusted ? 1 : 0));
  return agg?.total_weight ?? 0;
}

describe("credentials/submit indexes a credential only when its signer is its issuer", () => {
  it("ATTACK: S signs a credential about itself naming trusted issuer T — refused, nothing indexed, no routing weight", async () => {
    const trusted = await identity();
    const subject = await identity();
    const forged = await credential(trusted.did, subject.kp, `did:motebit:${subject.mid}`);

    const r = await submit(subject.mid, [forged]);
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(1);
    expect(heldRows(subject.mid)).toEqual([]);
    expect(routingWeight(subject.mid, trusted.did)).toBe(0);
  });

  it("ATTACK, third-party signer: X signs about S naming T — refused", async () => {
    const trusted = await identity();
    const subject = await identity();
    const stranger = await identity();
    const forged = await credential(trusted.did, stranger.kp, `did:motebit:${subject.mid}`);
    expect((await submit(subject.mid, [forged])).accepted).toBe(0);
    expect(heldRows(subject.mid)).toEqual([]);
  });

  it("ATTACK, object issuer: {id: T} signed by S — refused", async () => {
    const trusted = await identity();
    const subject = await identity();
    const forged = await credential({ id: trusted.did }, subject.kp, `did:motebit:${subject.mid}`);
    expect((await submit(subject.mid, [forged])).accepted).toBe(0);
    expect(heldRows(subject.mid)).toEqual([]);
  });

  it("SELF-ISSUANCE through an object issuer: {id: S's did:key} signed by S — refused as self-issued", async () => {
    const subject = await identity();
    const selfIssued = await credential(
      { id: subject.did },
      subject.kp,
      `did:motebit:${subject.mid}`,
    );
    const r = await submit(subject.mid, [selfIssued]);
    expect(r.accepted).toBe(0);
    expect(r.errors).toEqual(["self-issued credential rejected"]);
    expect(heldRows(subject.mid)).toEqual([]);
  });

  it("an honest credential from T about S is indexed and carries T's weight", async () => {
    const trusted = await identity();
    const subject = await identity();
    const honest = await credential(trusted.did, trusted.kp, `did:motebit:${subject.mid}`);
    expect((await submit(subject.mid, [honest])).accepted).toBe(1);
    expect(heldRows(subject.mid).map((r) => r.issuer_did)).toEqual([trusted.did]);
    expect(routingWeight(subject.mid, trusted.did)).toBeGreaterThan(0);
  });

  it("an honest object-issuer credential {id: T} signed by T is indexed under T's DID", async () => {
    const trusted = await identity();
    const subject = await identity();
    const honest = await credential({ id: trusted.did }, trusted.kp, `did:motebit:${subject.mid}`);
    expect((await submit(subject.mid, [honest])).accepted).toBe(1);
    expect(heldRows(subject.mid).map((r) => r.issuer_did)).toEqual([trusted.did]);
    expect(routingWeight(subject.mid, trusted.did)).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/credentials/verify", () => {
  async function verifyRoute(vc: unknown) {
    const res = await relay.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(vc),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { valid: boolean; issuer: unknown };
  }

  it("ATTACK: a credential naming T but signed by S is not valid", async () => {
    const trusted = await identity();
    const subject = await identity();
    const forged = await credential(trusted.did, subject.kp, `did:motebit:${subject.mid}`);
    expect((await verifyRoute(forged)).valid).toBe(false);
  });

  it("an honest credential is valid and reports its bound issuer", async () => {
    const trusted = await identity();
    const subject = await identity();
    const honest = await credential(trusted.did, trusted.kp, `did:motebit:${subject.mid}`);
    const r = await verifyRoute(honest);
    expect(r.valid).toBe(true);
    expect(r.issuer).toBe(trusted.did);
  });
});

describe("a forged credential already in storage carries no weight (rows from before the binding)", () => {
  /** Write a row the way the relay's submit door accepted it before the fix. */
  function storeRaw(
    subjectMid: string,
    vc: VerifiableCredential & { id: string },
    issuerDid: string,
  ) {
    // Migration v59's triggers refuse such a row; drop them to stand in for a
    // database from before v59, so these cells prove the readers' own layer.
    relay.moteDb.db.exec(
      "DROP TRIGGER IF EXISTS relay_credentials_signer_is_issuer_insert; DROP TRIGGER IF EXISTS relay_credentials_signer_is_issuer_update;",
    );
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        vc.id,
        subjectMid,
        issuerDid,
        "AgentReputationCredential",
        JSON.stringify(vc),
        Date.now(),
      );
  }

  it("ATTACK: S's self-signed credential naming trusted T, stored directly, gives routing no weight", async () => {
    const trusted = await identity();
    const subject = await identity();
    const forged = await credential(trusted.did, subject.kp, `did:motebit:${subject.mid}`);
    storeRaw(subject.mid, forged, trusted.did);
    expect(heldRows(subject.mid)).toHaveLength(1);
    expect(routingWeight(subject.mid, trusted.did)).toBe(0);
  });

  it("an honest credential stored the same way still carries T's weight", async () => {
    const trusted = await identity();
    const subject = await identity();
    const honest = await credential(trusted.did, trusted.kp, `did:motebit:${subject.mid}`);
    storeRaw(subject.mid, honest, trusted.did);
    expect(routingWeight(subject.mid, trusted.did)).toBeGreaterThan(0);
  });

  it("the relay never presents a stored forgery; an honest one is still presented", async () => {
    const trusted = await identity();
    const subject = await identity();
    const forged = await credential(trusted.did, subject.kp, `did:motebit:${subject.mid}`);
    const honest = await credential(trusted.did, trusted.kp, `did:motebit:${subject.mid}`);
    storeRaw(subject.mid, forged, trusted.did);
    storeRaw(subject.mid, honest, trusted.did);
    const res = await relay.app.request(`/api/v1/agents/${subject.mid}/presentation`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      presentation: { verifiableCredential: Array<{ id: string }> };
      credential_count: number;
    };
    expect(body.credential_count).toBe(1);
    expect(body.presentation.verifiableCredential.map((c) => c.id)).toEqual([honest.id]);
  });
});

const DROP_V59_TRIGGERS =
  "DROP TRIGGER IF EXISTS relay_credentials_signer_is_issuer_insert; DROP TRIGGER IF EXISTS relay_credentials_signer_is_issuer_update;";

function insertCredential(
  vc: VerifiableCredential & { id: string },
  subjectMid: string,
  issuerDid: string,
  type = "AgentReputationCredential",
) {
  relay.moteDb.db
    .prepare(
      "INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(vc.id, subjectMid, issuerDid, type, JSON.stringify(vc), Date.now());
}

function storedIds(subjectMid: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT credential_id FROM relay_credentials WHERE subject_motebit_id = ?")
      .all(subjectMid) as Array<{ credential_id: string }>
  ).map((r) => r.credential_id);
}

describe("migration v59: the table holds only credentials whose signer is their issuer", () => {
  const v59 = () => relayMigrations.find((m) => m.version === 59)!;

  it("removes a stored forgery, keeps an honest row, and installs the triggers", async () => {
    const trusted = await identity();
    const subject = await identity();
    const forged = await credential(trusted.did, subject.kp, `did:motebit:${subject.mid}`);
    const honest = await credential(trusted.did, trusted.kp, `did:motebit:${subject.mid}`);
    relay.moteDb.db.exec(DROP_V59_TRIGGERS); // a database from before v59
    insertCredential(forged, subject.mid, trusted.did);
    insertCredential(honest, subject.mid, trusted.did);
    v59().up(relay.moteDb.db);
    expect(storedIds(subject.mid)).toEqual([honest.id]);
    expect(() => insertCredential(forged, subject.mid, trusted.did)).toThrow(
      /signer is not its issuer/,
    );
  });

  it("the trigger refuses a forgery from any writer, and refuses rewriting an honest row into one", async () => {
    const trusted = await identity();
    const subject = await identity();
    const subjectId = `did:motebit:${subject.mid}`;
    const forged = await credential(trusted.did, subject.kp, subjectId);
    const objectForged = await credential({ id: trusted.did }, subject.kp, subjectId);
    const honest = await credential(trusted.did, trusted.kp, subjectId);
    const honestObject = await credential({ id: trusted.did }, trusted.kp, subjectId);
    expect(() => insertCredential(forged, subject.mid, trusted.did)).toThrow(
      /signer is not its issuer/,
    );
    expect(() => insertCredential(objectForged, subject.mid, trusted.did)).toThrow(
      /signer is not its issuer/,
    );
    insertCredential(honest, subject.mid, trusted.did);
    insertCredential(honestObject, subject.mid, trusted.did);
    expect(() =>
      relay.moteDb.db
        .prepare("UPDATE relay_credentials SET credential_json = ? WHERE credential_id = ?")
        .run(JSON.stringify({ ...forged, id: honest.id }), honest.id),
    ).toThrow(/signer is not its issuer/);
    expect(storedIds(subject.mid).sort()).toEqual([honest.id, honestObject.id].sort());
  });
});

describe("discovery's hardware-attestation badge comes only from a credential its issuer signed", () => {
  it("ATTACK: a stored self-signed AgentTrustCredential naming T yields no badge; T's own does", async () => {
    const trusted = await identity();
    const subject = await identity();
    const now = Date.now();
    const trustVc = (signer: KeyPair) =>
      signVerifiableCredential(
        {
          "@context": ["https://www.w3.org/ns/credentials/v2"],
          type: ["VerifiableCredential", "AgentTrustCredential"],
          id: `urn:uuid:${crypto.randomUUID()}`,
          issuer: trusted.did,
          credentialSubject: {
            id: `did:motebit:${subject.mid}`,
            trust_level: "verified",
            interaction_count: 1,
            successful_tasks: 1,
            failed_tasks: 0,
            first_seen_at: now,
            last_seen_at: now,
            hardware_attestation: { platform: "secure_enclave", key_exported: false },
          },
          validFrom: new Date(now).toISOString(),
        } as never,
        signer.privateKey,
        signer.publicKey,
      ) as Promise<VerifiableCredential & { id: string }>;

    relay.moteDb.db.exec(DROP_V59_TRIGGERS); // a row stored before v59
    insertCredential(await trustVc(subject.kp), subject.mid, trusted.did, "AgentTrustCredential");
    const [forgedView] = enrichWithHardwareAttestation(
      [{ motebit_id: subject.mid }],
      relay.moteDb.db,
    );
    expect(forgedView).not.toHaveProperty("hardware_attestation");

    insertCredential(await trustVc(trusted.kp), subject.mid, trusted.did, "AgentTrustCredential");
    const [honestView] = enrichWithHardwareAttestation(
      [{ motebit_id: subject.mid }],
      relay.moteDb.db,
    );
    expect(honestView).toHaveProperty("hardware_attestation");
  });
});

describe("migration v59 keeps anchored rows, so honest anchor proofs still verify", () => {
  it("an anchored forgery is kept (and inert); an unanchored one is removed", async () => {
    const trusted = await identity();
    const subject = await identity();
    const subjectId = `did:motebit:${subject.mid}`;
    const anchoredForgery = await credential(trusted.did, subject.kp, subjectId);
    const looseForgery = await credential(trusted.did, subject.kp, subjectId);
    relay.moteDb.db.exec(DROP_V59_TRIGGERS);
    insertCredential(anchoredForgery, subject.mid, trusted.did);
    insertCredential(looseForgery, subject.mid, trusted.did);
    relay.moteDb.db
      .prepare("UPDATE relay_credentials SET anchor_batch_id = ? WHERE credential_id = ?")
      .run("batch-1", anchoredForgery.id);
    relayMigrations.find((m) => m.version === 59)!.up(relay.moteDb.db);
    expect(storedIds(subject.mid)).toEqual([anchoredForgery.id]);
    expect(routingWeight(subject.mid, trusted.did)).toBe(0);
  });

  it("the trigger refuses a row whose issuer_did column is not the bound issuer", async () => {
    const trusted = await identity();
    const subject = await identity();
    const honest = await credential(trusted.did, trusted.kp, `did:motebit:${subject.mid}`);
    expect(() => insertCredential(honest, subject.mid, subject.did)).toThrow(
      /signer is not its issuer/,
    );
    insertCredential(honest, subject.mid, trusted.did);
    expect(() =>
      relay.moteDb.db
        .prepare("UPDATE relay_credentials SET issuer_did = ? WHERE credential_id = ?")
        .run(subject.did, honest.id),
    ).toThrow(/signer is not its issuer/);
  });
});

describe("an honest credential's anchor proof survives v59 (cold review 3)", () => {
  it("a forgery anchored in the same batch is kept, so the honest proof still verifies", async () => {
    const trusted = await identity();
    const subject = await identity();
    const subjectId = `did:motebit:${subject.mid}`;
    const honest = await credential(trusted.did, trusted.kp, subjectId);
    const forged = await credential(trusted.did, subject.kp, subjectId);
    const db = relay.moteDb.db;
    db.exec(DROP_V59_TRIGGERS); // both rows stored before v59
    insertCredential(honest, subject.mid, trusted.did);
    insertCredential(forged, subject.mid, trusted.did);
    const idRow = db
      .prepare("SELECT relay_motebit_id, private_key_hex FROM relay_identity")
      .get() as { relay_motebit_id: string; private_key_hex: string };
    const batch = await cutCredentialBatch(db, {
      relayMotebitId: idRow.relay_motebit_id,
      privateKey: Uint8Array.from(Buffer.from(idRow.private_key_hex, "hex")),
    } as never);
    expect(batch?.leaf_count).toBe(2);

    relayMigrations.find((m) => m.version === 59)!.up(db);

    const proof = await getCredentialAnchorProof(db, honest.id);
    expect(proof).not.toBeNull();
    expect(proof!.merkle_root).toBe(batch!.merkle_root);
    expect((await verifyCredentialAnchor(honest as never, proof as never)).valid).toBe(true);
  });
});

describe("a kept anchored forgery reaches no reader as a credential from its named issuer", () => {
  it("the owner's list shows it marked unbound; the departure count and the export omit it", async () => {
    const trusted = await identity();
    const subject = await identity();
    const subjectId = `did:motebit:${subject.mid}`;
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: subject.mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["web_search"],
        public_key: bytesToHex(subject.kp.publicKey),
      }),
    });
    const forged = await credential(trusted.did, subject.kp, subjectId);
    const honest = await credential(trusted.did, trusted.kp, subjectId);
    // An honest credential past its validity window: the relay issues
    // reputation credentials valid for an hour, so most of an established
    // agent's history looks like this (spec/migration-v1.md §6.2).
    const expired = await expiredCredential(trusted, subjectId);
    relay.moteDb.db.exec(DROP_V59_TRIGGERS); // all stored before v59
    insertCredential(forged, subject.mid, trusted.did);
    insertCredential(honest, subject.mid, trusted.did);
    insertCredential(expired, subject.mid, trusted.did);
    relay.moteDb.db
      .prepare("UPDATE relay_credentials SET anchor_batch_id = ? WHERE credential_id = ?")
      .run("batch-pre-v59", forged.id);
    relayMigrations.find((m) => m.version === 59)!.up(relay.moteDb.db);
    expect(storedIds(subject.mid).sort()).toEqual([forged.id, honest.id, expired.id].sort());

    const list = await relay.app.request(`/api/v1/agents/${subject.mid}/credentials`, {
      headers: AUTH_HEADER,
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      credentials: Array<{ credential_id: string; issuer_bound: boolean }>;
    };
    // Evidence, not trust: the owner sees both, with which one is bound.
    expect(
      Object.fromEntries(listed.credentials.map((c) => [c.credential_id, c.issuer_bound])),
    ).toEqual({ [honest.id]: true, [expired.id]: true, [forged.id]: false });

    const req = await signMigrationRequest(
      {
        motebit_id: subject.mid,
        reason: "test",
        requested_at: Date.now(),
        suite: "motebit-jcs-ed25519-b64-v1",
      } as never,
      subject.kp.privateKey,
    );
    const migrate = await relay.app.request(`/api/v1/agents/${subject.mid}/migrate`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(req),
    });
    expect(migrate.status).toBeLessThan(300);

    const att = await relay.app.request(`/api/v1/agents/${subject.mid}/migration/attestation`, {
      headers: AUTH_HEADER,
    });
    expect(att.status).toBe(200);
    const attested = (await att.json()) as {
      departure_attestation: { credentials_issued: number };
    };
    expect(attested.departure_attestation.credentials_issued).toBe(2);

    const exp = await relay.app.request(`/api/v1/agents/${subject.mid}/migration/export`, {
      headers: AUTH_HEADER,
    });
    expect(exp.status).toBe(200);
    const exported = (await exp.json()) as {
      credential_bundle: { credentials: Array<{ id: string }> };
      excluded_credentials: number;
    };
    // The expired honest credential is the agent's history and travels; only
    // the forgery is held back, and it is counted.
    expect(exported.credential_bundle.credentials.map((c) => c.id).sort()).toEqual(
      [honest.id, expired.id].sort(),
    );
    expect(exported.excluded_credentials).toBe(1);
  });
});

describe("filtering happens before the LIMIT, and signed outputs re-verify", () => {
  it("50 newer stored forgeries do not push an older honest credential out of routing's window", async () => {
    const trusted = await identity();
    const subject = await identity();
    const subjectId = `did:motebit:${subject.mid}`;
    const honest = await credential(trusted.did, trusted.kp, subjectId);
    insertCredential(honest, subject.mid, trusted.did);
    relay.moteDb.db.exec(DROP_V59_TRIGGERS); // forgeries stored before v59, kept because anchored
    for (let i = 0; i < 50; i++) {
      const forged = await credential(trusted.did, subject.kp, subjectId);
      relay.moteDb.db
        .prepare(
          "INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at, anchor_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          forged.id,
          subject.mid,
          trusted.did,
          "AgentReputationCredential",
          JSON.stringify(forged),
          Date.now() + 1000 + i,
          "batch-old",
        );
    }
    const bound = relay.moteDb.db
      .prepare(
        `SELECT credential_id FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = 'AgentReputationCredential' AND ${BOUND_ISSUER_SQL} ORDER BY issued_at DESC LIMIT 50`,
      )
      .all(subject.mid) as Array<{ credential_id: string }>;
    expect(bound.map((r) => r.credential_id)).toEqual([honest.id]);
  });

  it("an expired credential, bound but no longer valid, is not put into the relay's presentation", async () => {
    const trusted = await identity();
    const subject = await identity();
    const subjectId = `did:motebit:${subject.mid}`;
    const now = Date.now();
    const expired = (await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential", "AgentReputationCredential"],
        id: `urn:uuid:${crypto.randomUUID()}`,
        issuer: trusted.did,
        credentialSubject: {
          id: subjectId,
          success_rate: 1,
          avg_latency_ms: 5,
          task_count: 50,
          trust_score: 1,
          availability: 1,
          sample_size: 50,
          measured_at: now,
        },
        validFrom: new Date(now - 7_200_000).toISOString(),
        validUntil: new Date(now - 3_600_000).toISOString(),
      } as never,
      trusted.kp.privateKey,
      trusted.kp.publicKey,
    )) as VerifiableCredential & { id: string };
    const honest = await credential(trusted.did, trusted.kp, subjectId);
    insertCredential(expired, subject.mid, trusted.did);
    insertCredential(honest, subject.mid, trusted.did);
    const res = await relay.app.request(`/api/v1/agents/${subject.mid}/presentation`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      presentation: { verifiableCredential: Array<{ id: string }> };
    };
    expect(body.presentation.verifiableCredential.map((c) => c.id)).toEqual([honest.id]);
  });
});

describe("the SQL binding predicate and the TypeScript rule agree, and fail closed when ambiguous", () => {
  it("every edge case: string and object issuers, malformed JSON, missing fields, '#' placement, issuer_did, duplicate keys", async () => {
    const T = "did:key:z6MkTrusted";
    const S = "did:key:z6MkSigner";
    const cases: Array<{ name: string; json: string; issuerDid: string; bound: boolean }> = [
      {
        name: "string issuer, signer = issuer",
        json: JSON.stringify({ issuer: T, proof: { verificationMethod: `${T}#k` } }),
        issuerDid: T,
        bound: true,
      },
      {
        name: "object issuer, signer = issuer.id",
        json: JSON.stringify({ issuer: { id: T }, proof: { verificationMethod: `${T}#k` } }),
        issuerDid: T,
        bound: true,
      },
      {
        name: "no fragment",
        json: JSON.stringify({ issuer: T, proof: { verificationMethod: T } }),
        issuerDid: T,
        bound: true,
      },
      {
        name: "several '#'",
        json: JSON.stringify({ issuer: T, proof: { verificationMethod: `${T}#a#b` } }),
        issuerDid: T,
        bound: true,
      },
      {
        name: "signer is someone else",
        json: JSON.stringify({ issuer: T, proof: { verificationMethod: `${S}#k` } }),
        issuerDid: T,
        bound: false,
      },
      {
        name: "object issuer, someone else signed",
        json: JSON.stringify({ issuer: { id: T }, proof: { verificationMethod: `${S}#k` } }),
        issuerDid: T,
        bound: false,
      },
      {
        name: "issuer_did column is not the issuer",
        json: JSON.stringify({ issuer: T, proof: { verificationMethod: `${T}#k` } }),
        issuerDid: S,
        bound: false,
      },
      {
        name: "issuer id is a number",
        json: JSON.stringify({ issuer: { id: 7 }, proof: { verificationMethod: "7#k" } }),
        issuerDid: "7",
        bound: false,
      },
      {
        name: "empty issuer",
        json: JSON.stringify({ issuer: "", proof: { verificationMethod: "#k" } }),
        issuerDid: "",
        bound: false,
      },
      { name: "no proof", json: JSON.stringify({ issuer: T }), issuerDid: T, bound: false },
      {
        name: "verificationMethod not a string",
        json: JSON.stringify({ issuer: T, proof: { verificationMethod: [T] } }),
        issuerDid: T,
        bound: false,
      },
      { name: "malformed JSON", json: "{not json", issuerDid: T, bound: false },
      {
        name: "top-level array",
        json: JSON.stringify([{ issuer: T }]),
        issuerDid: T,
        bound: false,
      },
      {
        name: "duplicate issuer key, first bound",
        json: `{"issuer":"${T}","proof":{"verificationMethod":"${T}#k"},"issuer":"${S}"}`,
        issuerDid: T,
        bound: false,
      },
      {
        name: "duplicate issuer key, last bound",
        json: `{"issuer":"${S}","proof":{"verificationMethod":"${T}#k"},"issuer":"${T}"}`,
        issuerDid: T,
        bound: false,
      },
      {
        name: "non-canonical whitespace",
        json: `{ "issuer": "${T}", "proof": { "verificationMethod": "${T}#k" } }`,
        issuerDid: T,
        bound: false,
      },
    ];
    const db = relay.moteDb.db;
    db.exec(DROP_V59_TRIGGERS);
    cases.forEach((c, i) =>
      db
        .prepare(
          "INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(`case-${i}`, "edge", c.issuerDid, "AgentReputationCredential", c.json, i),
    );
    const sqlPass = new Set(
      (
        db
          .prepare(
            `SELECT credential_id FROM relay_credentials WHERE subject_motebit_id = 'edge' AND ${BOUND_ISSUER_SQL}`,
          )
          .all() as Array<{ credential_id: string }>
      ).map((r) => r.credential_id),
    );
    const outcome = cases.map((c, i) => {
      const ts =
        isBoundRow({ credential_json: c.json }) &&
        c.issuerDid !== "" &&
        (() => {
          try {
            const v = JSON.parse(c.json) as { issuer: unknown };
            const id = typeof v.issuer === "string" ? v.issuer : (v.issuer as { id?: unknown }).id;
            return id === c.issuerDid;
          } catch {
            return false;
          }
        })();
      return { name: c.name, bound: sqlPass.has(`case-${i}`) && ts };
    });
    expect(outcome).toEqual(cases.map((c) => ({ name: c.name, bound: c.bound })));
    // Where the two rules could disagree, a row must pass both to count.
    for (const [i, c] of cases.entries()) {
      if (c.bound)
        expect({
          name: c.name,
          sql: sqlPass.has(`case-${i}`),
          ts: isBoundRow({ credential_json: c.json }),
        }).toEqual({ name: c.name, sql: true, ts: true });
    }
  });
});

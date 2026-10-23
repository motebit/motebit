/**
 * The credential anchoring cut is ONE transaction (relay CLAUDE.md rule 30):
 * the signed batch row and its leaf assignments commit together, and a leaf is
 * assigned only while `anchor_batch_id IS NULL`, so a credential is anchored in
 * at most one batch and every batch owns exactly the leaves it signed.
 *
 * The sibling settlement cuts (`cutBatch`, `cutAgentSettlementBatch` in
 * anchoring.ts) already hold this shape; these tests pin it for the credential
 * stream:
 *
 *   1. a throw after the batch INSERT, before or during the assignments,
 *      leaves nothing: no batch row, no assigned leaf;
 *   2. a cut whose candidate set another cut assigned first (during its
 *      awaits) does not re-assign those credentials, and writes no batch;
 *   3. after that race the first batch's inclusion proofs still verify.
 *
 * The race is made deterministic by gating the relay's batch signature (the
 * cut's last await before it writes): cut A lists its candidates, then waits
 * at the gate while cut B lists, signs and writes in full.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFederationTables } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import { cutCredentialBatch, getCredentialAnchorProof } from "../credential-anchoring.js";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, issueReputationCredential } from "@motebit/encryption";
import { verifyCredentialAnchor } from "@motebit/crypto";

const signGate = vi.hoisted(() => ({ next: null as Promise<void> | null }));

vi.mock("@motebit/encryption", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/encryption")>();
  return {
    ...actual,
    sign: async (...args: Parameters<typeof actual.sign>) => {
      const gate = signGate.next;
      if (gate) {
        signGate.next = null;
        await gate;
      }
      return actual.sign(...args);
    },
  };
});

let db: DatabaseDriver;
let relayIdentity: RelayIdentity;

async function makeRelayIdentity(): Promise<RelayIdentity> {
  const keypair = await generateKeypair();
  return {
    relayMotebitId: `relay-${crypto.randomUUID()}`,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyHex: bytesToHex(keypair.publicKey),
    did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
  };
}

async function insertCredential(issuedAt: number): Promise<string> {
  const id = `cred-${issuedAt}`;
  const keypair = await generateKeypair();
  const vc = await issueReputationCredential(
    {
      success_rate: 0.95,
      avg_latency_ms: 120,
      task_count: 42,
      trust_score: 0.8,
      availability: 0.99,
      measured_at: issuedAt,
    },
    keypair.privateKey,
    keypair.publicKey,
    "did:key:zSubjectCutAtomic",
  );
  db.prepare(
    `INSERT INTO relay_credentials
       (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "agent-1", vc.issuer, "AgentReputationCredential", JSON.stringify(vc), issuedAt);
  return id;
}

function batchIdOf(credentialId: string): string | null {
  return (
    db
      .prepare("SELECT anchor_batch_id FROM relay_credentials WHERE credential_id = ?")
      .get(credentialId) as { anchor_batch_id: string | null }
  ).anchor_batch_id;
}

function batchIds(): string[] {
  return (
    db.prepare("SELECT batch_id FROM relay_credential_anchor_batches").all() as {
      batch_id: string;
    }[]
  ).map((r) => r.batch_id);
}

function credentialObject(credentialId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT credential_json FROM relay_credentials WHERE credential_id = ?")
    .get(credentialId) as { credential_json: string };
  return JSON.parse(row.credential_json) as Record<string, unknown>;
}

/**
 * The same database, except that the cut's leaf-assignment statement throws on
 * its `failOnRun`-th execution (1 = before any leaf is assigned).
 */
function failingAssignments(failOnRun: number): DatabaseDriver {
  let runs = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver) as unknown;
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!/^\s*UPDATE relay_credentials SET anchor_batch_id/.test(sql)) return stmt;
        return new Proxy(stmt, {
          get(s, p, r) {
            if (p !== "run") return Reflect.get(s, p, r) as unknown;
            return (...params: unknown[]) => {
              runs += 1;
              if (runs === failOnRun) throw new Error("injected: crash during the assignments");
              return s.run(...params);
            };
          },
        });
      };
    },
  });
}

beforeEach(async () => {
  signGate.next = null;
  const moteDb = await openMotebitDatabase(":memory:");
  db = moteDb.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_credentials (
      credential_id TEXT PRIMARY KEY,
      subject_motebit_id TEXT NOT NULL,
      issuer_did TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      credential_json TEXT NOT NULL,
      issued_at INTEGER NOT NULL
    );
  `);
  createFederationTables(db);
  relayIdentity = await makeRelayIdentity();
  db.prepare(
    `INSERT OR REPLACE INTO relay_identity
       (relay_motebit_id, public_key, private_key_hex, did, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    relayIdentity.relayMotebitId,
    relayIdentity.publicKeyHex,
    bytesToHex(relayIdentity.privateKey),
    relayIdentity.did,
    Date.now(),
  );
});

describe("credential anchoring cut: all or nothing", () => {
  for (const failOnRun of [1, 2, 3]) {
    it(`a throw at assignment ${failOnRun} of 3 leaves no batch and no assigned leaf`, async () => {
      const ids = [await insertCredential(1000), await insertCredential(2000)];
      ids.push(await insertCredential(3000));

      await expect(
        cutCredentialBatch(failingAssignments(failOnRun), relayIdentity),
      ).rejects.toThrow(/injected/);

      expect(batchIds(), "a signed batch row was left without all its leaves").toEqual([]);
      for (const id of ids) {
        expect(batchIdOf(id), `${id} was assigned to a batch that does not exist`).toBeNull();
      }

      // The stream is intact: the next cut takes every leaf.
      const batch = await cutCredentialBatch(db, relayIdentity);
      expect(batch!.leaf_count).toBe(3);
      for (const id of ids) expect(batchIdOf(id)).toBe(batch!.batch_id);
    });
  }
});

describe("credential anchoring cut: a credential is anchored in at most one batch", () => {
  /**
   * Cut A (maxSize 2) lists [c1, c2] and waits at the signature gate; cut B
   * (maxSize 50) then lists [c1, c2, c3] and commits. A resumes over leaves B
   * already holds.
   */
  async function race(): Promise<{
    ids: string[];
    first: Awaited<ReturnType<typeof cutCredentialBatch>>;
    second: PromiseSettledResult<Awaited<ReturnType<typeof cutCredentialBatch>>>;
  }> {
    const ids = [await insertCredential(1000), await insertCredential(2000)];
    ids.push(await insertCredential(3000));

    let release!: () => void;
    signGate.next = new Promise<void>((r) => (release = r));
    const second = cutCredentialBatch(db, relayIdentity, 2);
    // Let A list its candidates and reach the gate.
    await vi.waitFor(() => expect(signGate.next).toBeNull());

    const first = await cutCredentialBatch(db, relayIdentity, 50);
    expect(first!.leaf_count).toBe(3);
    release();
    const [settled] = await Promise.allSettled([second]);
    return { ids, first, second: settled! };
  }

  it("a cut over leaves another cut assigned first re-assigns none and writes no batch", async () => {
    const { ids, first, second } = await race();

    for (const id of ids) {
      expect(batchIdOf(id), `${id} was moved out of the batch that first anchored it`).toBe(
        first!.batch_id,
      );
    }
    expect(second.status, "the late cut must refuse, not commit a second batch").toBe("rejected");
    expect(batchIds(), "a batch row exists for leaves it does not own").toEqual([first!.batch_id]);
  });

  it("after the race every inclusion proof for the first batch verifies", async () => {
    const { ids, first } = await race();

    // c3 first: it is the leaf a re-assignment strands alone in the first batch.
    for (const id of [...ids].reverse()) {
      const proof = await getCredentialAnchorProof(db, id);
      expect(proof, `${id} has no proof`).not.toBeNull();
      const result = await verifyCredentialAnchor(credentialObject(id), proof!);
      expect(result.valid, `${id}: ${JSON.stringify(result.steps)}`).toBe(true);
      expect(proof!.batch_id).toBe(first!.batch_id);
      expect(proof!.merkle_root).toBe(first!.merkle_root);
    }
  });
});

/**
 * Signed revocation evidence at the relay (standing-delegation@1.3 §5.2–§5.3,
 * §8.1; money-authority increment 2).
 *
 *   - `GET /api/v1/delegations/revocations/head` serves a
 *     `DelegationRevocationSetAttestation` signed by the relay's identity key:
 *     every revocation held for the delegator, strictly ascending by seq,
 *     under the relay-wide `seq_high_water`, echoing the consumer's challenge.
 *   - `POST /api/v1/delegations/revocations` carries a
 *     `DelegationRevocationInclusionReceipt` for `recorded` and
 *     `already_recorded` alike (the original seq on repeat).
 *   - Relay atomicity MUST: `seq_high_water` is the highest seq of a COMMITTED,
 *     VISIBLE record, read in one snapshot with the entries. Proven across two
 *     real SQLite connections on one WAL file, with a commit landing between
 *     the snapshot's two reads.
 *
 * Every artifact is verified with the `@motebit/crypto` law a consumer runs,
 * under the relay key a consumer would pin. Keys are ephemeral test keys.
 * Tamper entries: `scripts/tampers/relay-revocation-evidence.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  signDelegationRevocation,
  signRevocationSetAttestation,
  verifyRevocationSetAttestation,
  verifyRevocationInclusionReceipt,
  verifyRevocationOmissionProof,
  computeRevocationRecordsDigest,
  type DelegationRevocation,
} from "@motebit/crypto";
import type {
  DelegationRevocationInclusionReceipt,
  DelegationRevocationSetAttestation,
} from "@motebit/protocol";
import {
  createMotebitDatabase,
  type DatabaseDriver,
  type MotebitDatabase,
  type PreparedStatement,
} from "@motebit/persistence";
import { readDelegationRevocationSet } from "../delegation-revocations.js";
import { createTestRelay, createAgent } from "./test-helpers.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array; motebitId: string };

async function registeredDelegator(relay: SyncRelay): Promise<Kp> {
  const kp = await generateKeypair();
  const { motebitId } = await createAgent(relay, bytesToHex(kp.publicKey));
  return { ...kp, motebitId };
}

async function makeRevocation(delegator: Kp, grantId: string): Promise<DelegationRevocation> {
  return signDelegationRevocation(
    {
      grant_id: grantId,
      delegator_id: delegator.motebitId,
      delegator_public_key: bytesToHex(delegator.publicKey),
      revoked_at: Date.now(),
    },
    delegator.privateKey,
  );
}

interface PostBody {
  ok: boolean;
  grant_id: string;
  status: "recorded" | "already_recorded";
  inclusion_receipt: DelegationRevocationInclusionReceipt;
}

async function post(relay: SyncRelay, revocation: DelegationRevocation): Promise<PostBody> {
  const res = await relay.app.request("/api/v1/delegations/revocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(revocation),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PostBody;
}

/** A fresh 32-byte hex challenge (the spec §5.2 MUST). */
function freshChallenge(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function headUrl(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  return `/api/v1/delegations/revocations/head?${q.toString()}`;
}

async function head(
  relay: SyncRelay,
  delegatorId: string,
  challenge: string,
): Promise<DelegationRevocationSetAttestation> {
  const res = await relay.app.request(headUrl({ delegator_motebit_id: delegatorId, challenge }));
  expect(res.status).toBe(200);
  return (await res.json()) as DelegationRevocationSetAttestation;
}

function maxSeq(relay: SyncRelay): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM relay_delegation_revocations")
      .get() as { m: number }
  ).m;
}

/** The relay's own (ephemeral, plaintext in a test DB) private key — for crafting a dishonest attestation only. */
function relayPrivateKey(relay: SyncRelay): Uint8Array {
  const row = relay.moteDb.db
    .prepare("SELECT private_key_hex FROM relay_identity LIMIT 1")
    .get() as {
    private_key_hex: string;
  };
  return hexToBytes(row.private_key_hex);
}

describe("revocation set attestation route", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("serves an attestation that verifies under the relay key with every field correct", async () => {
    const alice = await registeredDelegator(relay);
    const r1 = await makeRevocation(alice, "grant-a1");
    const r2 = await makeRevocation(alice, "grant-a2");
    const p1 = await post(relay, r1);
    const p2 = await post(relay, r2);

    const challenge = freshChallenge();
    const before = Date.now();
    const att = await head(relay, alice.motebitId, challenge);
    const after = Date.now();

    const verdict = await verifyRevocationSetAttestation(att, {
      pinnedRelayPublicKey: relay.relayIdentity.publicKeyHex,
      challenge,
      delegatorMotebitId: alice.motebitId,
      now: Date.now(),
      lastSeenSeq: 0,
    });
    expect(verdict).toEqual({ valid: true });

    expect(att.spec).toBe("motebit/delegation-revocation-set-attestation@1.0");
    expect(att.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(att.relay_motebit_id).toBe(relay.relayIdentity.relayMotebitId);
    expect(att.relay_public_key).toBe(relay.relayIdentity.publicKeyHex.toLowerCase());
    expect(att.delegator_motebit_id).toBe(alice.motebitId);
    expect(att.challenge).toBe(challenge);
    expect(att.as_of).toBeGreaterThanOrEqual(before);
    expect(att.as_of).toBeLessThanOrEqual(after);
    expect(att.seq_high_water).toBe(maxSeq(relay));
    expect(att.count).toBe(2);
    expect(att.entries).toEqual([
      {
        seq: p1.inclusion_receipt.seq,
        received_at: p1.inclusion_receipt.received_at,
        record: r1,
      },
      {
        seq: p2.inclusion_receipt.seq,
        received_at: p2.inclusion_receipt.received_at,
        record: r2,
      },
    ]);
    expect(att.records_digest).toBe(await computeRevocationRecordsDigest(att.entries));
  });

  it("entries are strictly ascending, scoped to the delegator, and carry no other delegator's records", async () => {
    const alice = await registeredDelegator(relay);
    const bob = await registeredDelegator(relay);
    // Interleaved, so alice's seqs are not contiguous and bob's sit between them.
    await post(relay, await makeRevocation(alice, "g-1"));
    await post(relay, await makeRevocation(bob, "g-2"));
    await post(relay, await makeRevocation(alice, "g-3"));
    await post(relay, await makeRevocation(bob, "g-4"));
    await post(relay, await makeRevocation(alice, "g-5"));

    const att = await head(relay, alice.motebitId, freshChallenge());
    expect(att.entries.map((e) => e.record.grant_id)).toEqual(["g-1", "g-3", "g-5"]);
    expect(att.entries.every((e) => e.record.delegator_id === alice.motebitId)).toBe(true);
    const seqs = att.entries.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    // seq_high_water is relay-wide: it covers bob's last record too.
    expect(att.seq_high_water).toBe(maxSeq(relay));

    const bobAtt = await head(relay, bob.motebitId, freshChallenge());
    expect(bobAtt.entries.map((e) => e.record.grant_id)).toEqual(["g-2", "g-4"]);
    expect(bobAtt.seq_high_water).toBe(att.seq_high_water);
  });

  it("a delegator with no revocations gets a valid empty attestation at the current relay-wide high-water", async () => {
    // Empty relay: high-water 0.
    const nobody = await registeredDelegator(relay);
    const c0 = freshChallenge();
    const att0 = await head(relay, nobody.motebitId, c0);
    expect(att0.entries).toEqual([]);
    expect(att0.count).toBe(0);
    expect(att0.seq_high_water).toBe(0);
    expect(
      await verifyRevocationSetAttestation(att0, {
        pinnedRelayPublicKey: relay.relayIdentity.publicKeyHex,
        challenge: c0,
        delegatorMotebitId: nobody.motebitId,
        now: Date.now(),
        lastSeenSeq: 0,
      }),
    ).toEqual({ valid: true });

    // Others' revocations raise the relay-wide high-water; the set stays empty.
    const alice = await registeredDelegator(relay);
    await post(relay, await makeRevocation(alice, "g-x"));
    await post(relay, await makeRevocation(alice, "g-y"));
    const c1 = freshChallenge();
    const att1 = await head(relay, nobody.motebitId, c1);
    expect(att1.entries).toEqual([]);
    expect(att1.count).toBe(0);
    expect(att1.seq_high_water).toBe(maxSeq(relay));
    expect(att1.seq_high_water).toBeGreaterThan(0);
    expect(
      await verifyRevocationSetAttestation(att1, {
        pinnedRelayPublicKey: relay.relayIdentity.publicKeyHex,
        challenge: c1,
        delegatorMotebitId: nobody.motebitId,
        now: Date.now(),
        lastSeenSeq: att0.seq_high_water,
      }),
    ).toEqual({ valid: true });
    // An id the relay has never seen is answered the same way (it holds nothing for it).
    const unknown = await head(relay, "never-registered-id", freshChallenge());
    expect(unknown.entries).toEqual([]);
  });

  it("refuses a missing, short or overlong challenge (400)", async () => {
    const alice = await registeredDelegator(relay);
    const id = alice.motebitId;
    for (const challenge of [undefined, "", "a".repeat(31), "a".repeat(257)]) {
      const res = await relay.app.request(headUrl({ delegator_motebit_id: id, challenge }));
      expect(res.status, `challenge length ${challenge?.length ?? "missing"}`).toBe(400);
    }
    // The bounds themselves are accepted (32 and 256 characters).
    for (const challenge of ["a".repeat(32), "b".repeat(256)]) {
      const res = await relay.app.request(headUrl({ delegator_motebit_id: id, challenge }));
      expect(res.status).toBe(200);
    }
  });

  it("refuses a missing or invalid delegator id (400)", async () => {
    const challenge = freshChallenge();
    for (const delegator of [undefined, "", "a:b", "id with space", "x".repeat(257)]) {
      const res = await relay.app.request(headUrl({ delegator_motebit_id: delegator, challenge }));
      expect(res.status, `delegator ${JSON.stringify(delegator)}`).toBe(400);
    }
  });

  it("is public and on the read tier, separate from the write tier the cache path uses", async () => {
    const alice = await registeredDelegator(relay);
    // No token: served (public, like the unsigned feed).
    const first = await relay.app.request(
      headUrl({ delegator_motebit_id: alice.motebitId, challenge: freshChallenge() }),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Limit")).toBe("60");
    // More than the write tier's 30/min all succeed: the write limiter on
    // `/api/v1/delegations/revocations` does not also bind `/head`.
    for (let i = 0; i < 35; i++) {
      const res = await relay.app.request(
        headUrl({ delegator_motebit_id: alice.motebitId, challenge: freshChallenge() }),
      );
      expect(res.status).toBe(200);
    }
  });
});

describe("inclusion receipt on POST", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("recorded and already_recorded each carry a receipt that verifies, with the same seq on repeat", async () => {
    const alice = await registeredDelegator(relay);
    const revocation = await makeRevocation(alice, "grant-r");

    const first = await post(relay, revocation);
    expect(first.status).toBe("recorded");
    expect(
      await verifyRevocationInclusionReceipt(first.inclusion_receipt, {
        pinnedRelayPublicKey: relay.relayIdentity.publicKeyHex,
        revocation,
      }),
    ).toEqual({ valid: true });
    expect(first.inclusion_receipt.relay_motebit_id).toBe(relay.relayIdentity.relayMotebitId);
    expect(first.inclusion_receipt.seq).toBe(maxSeq(relay));

    // Another record in between, and a clock tick, so a recomputed seq or
    // received_at would differ from the stored row's.
    await post(relay, await makeRevocation(alice, "grant-other"));
    await new Promise((r) => setTimeout(r, 5));

    const again = await post(relay, revocation);
    expect(again.status).toBe("already_recorded");
    expect(
      await verifyRevocationInclusionReceipt(again.inclusion_receipt, {
        pinnedRelayPublicKey: relay.relayIdentity.publicKeyHex,
        revocation,
      }),
    ).toEqual({ valid: true });
    expect(again.inclusion_receipt.seq).toBe(first.inclusion_receipt.seq);
    expect(again.inclusion_receipt.received_at).toBe(first.inclusion_receipt.received_at);
    // Rebuilt from the stored row: the same bytes (Ed25519 is deterministic).
    expect(again.inclusion_receipt).toEqual(first.inclusion_receipt);
  });

  it("a receipted seq is covered by the next attestation, which carries the record at that seq", async () => {
    const alice = await registeredDelegator(relay);
    const revocation = await makeRevocation(alice, "grant-c");
    const { inclusion_receipt: receipt } = await post(relay, revocation);
    const att = await head(relay, alice.motebitId, freshChallenge());
    expect(att.seq_high_water).toBeGreaterThanOrEqual(receipt.seq);
    expect(att.entries).toContainEqual({
      seq: receipt.seq,
      received_at: receipt.received_at,
      record: revocation,
    });
  });

  it("omission proof: honest route gives valid:false; a crafted attestation dropping the record gives valid:true", async () => {
    const alice = await registeredDelegator(relay);
    const revocation = await makeRevocation(alice, "grant-o");
    await post(relay, await makeRevocation(alice, "grant-kept"));
    const { inclusion_receipt: receipt } = await post(relay, revocation);

    const honest = await head(relay, alice.motebitId, freshChallenge());
    expect(await verifyRevocationOmissionProof(receipt, honest)).toEqual({
      valid: false,
      reason: "record_carried",
    });

    // Test only: the same relay key signs a set that drops the receipted record.
    const crafted = await signRevocationSetAttestation(
      {
        relay_motebit_id: honest.relay_motebit_id,
        relay_public_key: honest.relay_public_key,
        delegator_motebit_id: honest.delegator_motebit_id,
        challenge: freshChallenge(),
        as_of: Date.now(),
        seq_high_water: honest.seq_high_water,
        entries: honest.entries.filter((e) => e.seq !== receipt.seq),
      },
      relayPrivateKey(relay),
    );
    expect(crafted.entries).toHaveLength(honest.entries.length - 1);
    expect(await verifyRevocationOmissionProof(receipt, crafted)).toEqual({ valid: true });
  });
});

describe("relay atomicity (spec §5.2/§8.1): high-water never covers an invisible record", () => {
  // The relay's own database on a WAL file (the reader), and a second real
  // connection to the same file (the writer) standing in for a concurrent POST.
  let dir: string;
  let relay: SyncRelay;
  let reader: MotebitDatabase;
  let writer: MotebitDatabase;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "motebit-revset-"));
    const path = join(dir, "relay.db");
    relay = await createTestRelay({ dbPath: path });
    reader = relay.moteDb;
    writer = createMotebitDatabase(path);
  });

  afterEach(async () => {
    writer.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;
  /** A committed insert on the OTHER connection (its own autocommit statement). */
  function writerInsert(delegatorId: string): number {
    n += 1;
    const record = {
      grant_id: `g-${n}`,
      delegator_id: delegatorId,
      delegator_public_key: "00".repeat(32),
      revoked_at: n,
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: `sig-${n}-${Math.random()}`,
    };
    writer.db
      .prepare(
        `INSERT INTO relay_delegation_revocations
           (grant_id, delegator_id, delegator_public_key, revoked_at, suite, signature, record_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.grant_id,
        record.delegator_id,
        record.delegator_public_key,
        record.revoked_at,
        record.suite,
        record.signature,
        JSON.stringify(record),
        Date.now(),
      );
    const row = writer.db
      .prepare("SELECT id FROM relay_delegation_revocations WHERE signature = ?")
      .get(record.signature) as { id: number };
    return row.id;
  }

  /**
   * The reader's driver, with a commit on the writer connection injected
   * immediately AFTER the snapshot's entries read returns and BEFORE its
   * high-water read: the interleaving a concurrent POST can produce.
   */
  function interleaving(real: DatabaseDriver, onEntriesRead: () => void): DatabaseDriver {
    let fired = false;
    return {
      driverName: real.driverName,
      exec: (sql) => real.exec(sql),
      pragma: (sql) => real.pragma(sql),
      close: () => real.close(),
      transaction: (fn) => real.transaction(fn),
      prepare: (sql): PreparedStatement => {
        const st = real.prepare(sql);
        if (!sql.includes("WHERE delegator_id = ?")) return st;
        return {
          run: (...p) => st.run(...p),
          get: (...p) => st.get(...p),
          all: (...p) => {
            const rows = st.all(...p);
            if (!fired) {
              fired = true;
              onEntriesRead();
            }
            return rows;
          },
        };
      },
    };
  }

  it("a record committed between the snapshot's reads has seq > high-water, and appears once committed-before", () => {
    const first = writerInsert("alice");
    let concurrent = 0;
    const db = interleaving(reader.db, () => {
      concurrent = writerInsert("alice");
    });

    const snap = readDelegationRevocationSet(db, "alice");
    expect(concurrent).toBeGreaterThan(first);
    const seqs = snap.entries.map((e) => e.seq);
    // Either the concurrent record is in the set at seq <= high-water, or its
    // seq is above the high-water. Never a high-water covering a record the
    // set does not carry.
    if (seqs.includes(concurrent)) {
      expect(concurrent).toBeLessThanOrEqual(snap.seqHighWater);
    } else {
      expect(concurrent).toBeGreaterThan(snap.seqHighWater);
    }
    expect(snap.seqHighWater).toBe(first);
    expect(seqs).toEqual([first]);

    // The next snapshot sees the committed record, covered by its high-water.
    const next = readDelegationRevocationSet(reader.db, "alice");
    expect(next.entries.map((e) => e.seq)).toEqual([first, concurrent]);
    expect(next.seqHighWater).toBe(concurrent);
  });

  it("a concurrent commit for ANOTHER delegator does not raise this snapshot's high-water", () => {
    const mine = writerInsert("alice");
    let theirs = 0;
    const db = interleaving(reader.db, () => {
      theirs = writerInsert("bob");
    });
    const snap = readDelegationRevocationSet(db, "alice");
    expect(theirs).toBeGreaterThan(mine);
    // Both reads see the same snapshot: the high-water is that snapshot's MAX,
    // not a later commit's seq.
    expect(snap.seqHighWater).toBe(mine);
  });

  it("with no later inserts, high-water equals MAX(seq) of the returned set when the delegator wrote last", () => {
    writerInsert("bob");
    writerInsert("alice");
    const last = writerInsert("alice");
    const snap = readDelegationRevocationSet(reader.db, "alice");
    expect(snap.seqHighWater).toBe(Math.max(...snap.entries.map((e) => e.seq)));
    expect(snap.seqHighWater).toBe(last);
  });
});

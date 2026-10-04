/**
 * The one persistence step every surface runs after a pairing is accepted
 * (and after a motebit.md restore): the VERIFIED lineage to the held key joins
 * the roster replica, so this device can later be Device A for the identity
 * — its outgoing key transfer carries the replica's links even when the relay
 * holds no chain (an offline rotation uploads nothing). Real signatures; the
 * replica merge is the real `mergeReplicas` a surface's `saveReplica` runs.
 */
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  signKeySuccession,
  type KeyPair,
} from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/sdk";
import {
  emptyReplica,
  mergeReplicas,
  persistVerifiedLineage,
  type MachineRosterReplica,
} from "../index.js";

const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

async function offlineRotated() {
  const g = await generateKeypair();
  const k1 = await generateKeypair();
  const k2 = await generateKeypair();
  const chain: KeySuccessionRecord[] = [
    await signKeySuccession(g.privateKey, k1.privateKey, k1.publicKey, g.publicKey),
  ];
  // Strictly later timestamp for the second link.
  await new Promise((r) => setTimeout(r, 5));
  chain.push(await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey));
  return { motebitId: await deriveSovereignMotebitId(hex(g)), current: hex(k2), chain };
}

/** A surface's `saveReplica`: merge into what is stored (nothing is ever removed). */
function store() {
  const replicas = new Map<string, MachineRosterReplica>();
  const writes: MachineRosterReplica[] = [];
  return {
    replicas,
    writes,
    save: async (r: MachineRosterReplica) => {
      writes.push(r);
      const prev = replicas.get(r.motebit_id);
      replicas.set(r.motebit_id, prev ? mergeReplicas(prev, r) : r);
    },
  };
}

describe("persistVerifiedLineage", () => {
  it("persists the verified lineage to the held key into the replica", async () => {
    const id = await offlineRotated();
    const s = store();
    const n = await persistVerifiedLineage(s.save, {
      motebitId: id.motebitId,
      publicKeyHex: id.current,
      records: id.chain,
    });
    expect(n).toBe(2);
    expect(s.replicas.get(id.motebitId)?.succession).toEqual(id.chain);
  });

  it("is idempotent: persisting the same lineage again leaves the replica unchanged", async () => {
    const id = await offlineRotated();
    const s = store();
    const input = { motebitId: id.motebitId, publicKeyHex: id.current, records: id.chain };
    await persistVerifiedLineage(s.save, input);
    const once = structuredClone(s.replicas.get(id.motebitId));
    await persistVerifiedLineage(s.save, input);
    expect(s.replicas.get(id.motebitId)).toEqual(once);
  });

  it("never lets an unverified record in: forged and foreign records are dropped", async () => {
    const id = await offlineRotated();
    const other = await offlineRotated();
    const forged = { ...id.chain[0]!, new_key_signature: "00".repeat(64) };
    const s = store();
    await persistVerifiedLineage(s.save, {
      motebitId: id.motebitId,
      publicKeyHex: id.current,
      records: [forged, ...id.chain, ...other.chain, "junk", null],
    });
    expect(s.replicas.get(id.motebitId)?.succession).toEqual(id.chain);
  });

  it("writes nothing when the records do not reach the held key, or the id commits to no key", async () => {
    const id = await offlineRotated();
    const stranger = await generateKeypair();
    const s = store();
    expect(
      await persistVerifiedLineage(s.save, {
        motebitId: id.motebitId,
        publicKeyHex: hex(stranger),
        records: id.chain,
      }),
    ).toBe(0);
    expect(
      await persistVerifiedLineage(s.save, {
        motebitId: "0190f1a2-0000-7000-8000-00000000abcd",
        publicKeyHex: id.current,
        records: id.chain,
      }),
    ).toBe(0);
    expect(s.writes).toEqual([]);
  });

  it("never throws: a failing save is reported as nothing persisted", async () => {
    const id = await offlineRotated();
    const n = await persistVerifiedLineage(() => Promise.reject(new Error("disk full")), {
      motebitId: id.motebitId,
      publicKeyHex: id.current,
      records: id.chain,
    });
    expect(n).toBe(0);
  });

  it("writes only the succession set (no roster entries, captures or verdicts)", async () => {
    const id = await offlineRotated();
    const s = store();
    await persistVerifiedLineage(s.save, {
      motebitId: id.motebitId,
      publicKeyHex: id.current,
      records: id.chain,
    });
    expect(s.writes[0]).toEqual({ ...emptyReplica(id.motebitId), succession: id.chain });
  });
});

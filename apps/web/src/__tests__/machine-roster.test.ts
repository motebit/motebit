/**
 * The browser's machine roster — `docs/proposals/machine-roster-surfaces-v1.md`
 * C-2a: the IndexedDB replica (one transaction per merge-save, per
 * motebit_id, corrupt values kept aside), the bounded open, the ports
 * (device token under the held key, Retry-After), the cross-tab locks and
 * the presentation leader, and the rotation commit's roster step.
 *
 * fake-indexeddb supplies IndexedDB; each test opens its own IDBFactory so
 * no state crosses tests.
 */
import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  bytesToHex,
  generateKeypair,
  hexToBytes,
  hostEnrollmentId,
  hostRetirementId,
  signHostEnrollment,
  signHostRetirement,
  signKeySuccession,
  verifySignedToken,
  type KeyPair,
} from "@motebit/encryption";
import { MAX_RETRY_AFTER_MS, emptyReplica, type MachineRosterReplica } from "@motebit/surface-kit";
import type { HostEnrollment, HostRetirement, KeySuccessionRecord } from "@motebit/sdk";
import {
  listAside,
  loadPresentationRecord,
  loadReplica,
  openRosterDb,
  putPresentationRecord,
  saveReplica,
} from "../machine-roster-store.js";
import {
  NO_LOCKS,
  PRESENT_LOCK,
  createWebMachineRoster,
  retryAfterMs,
  rosterAfterRotationCommit,
  webRosterPorts,
  type RosterLocks,
} from "../machine-roster.js";
import { rotateWebKey } from "../key-rotation.js";
import type { EncryptedKeyStore } from "../encrypted-keystore.js";

const MID = "0190f1a2-0000-7000-8000-00000000abcd"; // legacy
const OTHER_MID = "0190f1a2-0000-7000-8000-00000000ef01";
const NOW = 1_800_000_000_000;
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

const freshDb = () => {
  const factory = new IDBFactory();
  let db: Promise<IDBDatabase> | null = null;
  return () => (db ??= openRosterDb(factory));
};

const enrol = (kp: KeyPair, deviceId: string, motebitId = MID) =>
  signHostEnrollment(
    { motebit_id: motebitId, device_id: deviceId, public_key: hex(kp), enrolled_at: NOW },
    kp.privateKey,
  );
const retire = async (kp: KeyPair, e: HostEnrollment) =>
  signHostRetirement(
    {
      motebit_id: MID,
      enrollment_id: await hostEnrollmentId(e),
      public_key: hex(kp),
      retired_at: NOW,
    },
    kp.privateKey,
  );

/** A FIFO Web Locks stand-in: one holder per name, waiters queued. */
class FakeLocks implements RosterLocks {
  private tails = new Map<string, Promise<unknown>>();
  requested: string[] = [];
  request<T>(name: string, _o: { mode: "exclusive" }, fn: () => Promise<T>): Promise<T> {
    this.requested.push(name);
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }
}

/** The relay, behind `fetch`: the part-B routes the adapter calls. */
class FetchRelay {
  enr = new Map<string, HostEnrollment>();
  ret = new Map<string, HostRetirement>();
  chain: KeySuccessionRecord[] = [];
  current: string | null = null;
  rows: Array<{
    device_id: string;
    bound_under: string;
    last_seen_at: number;
    sockets_open: number;
  }> = [];
  retryAfter: string | null = null;
  /** Entry id → the per-entry refusal reason this relay answers (spec §11's 422 shape). */
  refuse = new Map<string, string>();
  /** Every POSTed body, as sent. */
  bodies: string[] = [];
  auth: string[] = [];
  posts = 0;
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization")) this.auth.push(headers.get("Authorization")!);
    if (url.endsWith("/succession")) {
      return Response.json({ chain: this.chain, current_public_key: this.current });
    }
    if (url.endsWith("/roster") && (init?.method ?? "GET") === "GET") {
      return Response.json({
        enrollments: [...this.enr.values()],
        retirements: [...this.ret.values()],
        liveness: {
          observed_by: "relay",
          retention_days: 90,
          observing_since: NOW - 90 * 86_400_000,
          rows: this.rows,
          live_unenrolled: [],
        },
      });
    }
    if (url.endsWith("/roster")) {
      this.posts++;
      if (this.retryAfter != null) {
        return new Response(JSON.stringify({ error: "rate" }), {
          status: 429,
          headers: { "Retry-After": this.retryAfter },
        });
      }
      this.bodies.push(init!.body as string);
      const body = JSON.parse(init!.body as string) as {
        enrollments: HostEnrollment[];
        retirements: HostRetirement[];
      };
      const refused: Array<{ kind: string; index: number; reason: string }> = [];
      for (const [index, e] of body.enrollments.entries()) {
        const id = await hostEnrollmentId(e);
        const reason = this.refuse.get(id);
        if (reason != null) refused.push({ kind: "enrollment", index, reason });
        else this.enr.set(id, e);
      }
      for (const r of body.retirements) this.ret.set(await hostRetirementId(r), r);
      if (refused.length > 0) return Response.json({ accepted: [], refused }, { status: 422 });
      return Response.json({ accepted: [] });
    }
    return new Response("not found", { status: 404 });
  };
}

function tab(
  relay: FetchRelay,
  key: KeyPair,
  db: () => Promise<IDBDatabase>,
  locks: RosterLocks | null,
  opts: { deviceId?: string; motebitId?: string; now?: () => number } = {},
) {
  return createWebMachineRoster({
    motebitId: opts.motebitId ?? MID,
    deviceId: opts.deviceId ?? "tab-device",
    loadPrivateKeyHex: async () => bytesToHex(key.privateKey),
    syncUrl: () => "https://relay.test/",
    db,
    locks,
    fetchImpl: relay.fetch as typeof fetch,
    now: opts.now ?? (() => NOW),
  });
}

describe("IndexedDB replica — one transaction per merge-save", () => {
  it("F3: two tabs saving at once never lose a retirement", async () => {
    const a = await generateKeypair();
    const e = await enrol(a, "dev-host");
    const r = await retire(a, e);
    const factory = new IDBFactory();
    const tab1 = await openRosterDb(factory);
    const tab2 = await openRosterDb(factory);
    for (let i = 0; i < 5; i++) {
      await Promise.all([
        saveReplica(tab1, { ...emptyReplica(MID), retirements: [r] }),
        saveReplica(tab2, { ...emptyReplica(MID), enrollments: [e] }),
      ]);
    }
    const got = await loadReplica(tab1, MID);
    expect(got.kind).toBe("value");
    if (got.kind === "value") {
      expect(got.replica.retirements).toEqual([r]);
      expect(got.replica.enrollments).toEqual([e]);
    }
  });

  it("F4: replicas are keyed per motebit — another identity never inherits or destroys one", async () => {
    const a = await generateKeypair();
    const db = await freshDb()();
    await saveReplica(db, { ...emptyReplica(MID), enrollments: [await enrol(a, "d1")] });
    await saveReplica(db, {
      ...emptyReplica(OTHER_MID),
      enrollments: [await enrol(a, "d2", OTHER_MID)],
    });
    const one = await loadReplica(db, MID);
    const two = await loadReplica(db, OTHER_MID);
    expect(one.kind === "value" && one.replica.enrollments.map((x) => x.device_id)).toEqual(["d1"]);
    expect(two.kind === "value" && two.replica.enrollments.map((x) => x.device_id)).toEqual(["d2"]);
    expect((await loadReplica(db, "0190f1a2-0000-7000-8000-000000000000")).kind).toBe("absent");
  });

  it("R3: a corrupt value is kept aside, byte-for-byte, and reads as corrupt once; the name is then free", async () => {
    const db = await freshDb()();
    const junk = { version: 1, motebit_id: MID, succession: "not a list" };
    await rawPut(db, MID, junk);
    expect((await loadReplica(db, MID)).kind).toBe("corrupt");
    expect(await listAside(db)).toEqual([
      { motebit_id: MID, store: "replicas", at: expect.any(Number) as number, raw: junk },
    ]);
    expect((await loadReplica(db, MID)).kind).toBe("absent");
  });

  it("R3: a save over a corrupt value keeps it aside inside the same transaction, then writes", async () => {
    const a = await generateKeypair();
    const db = await freshDb()();
    await rawPut(db, MID, "garbage");
    const replica: MachineRosterReplica = {
      ...emptyReplica(MID),
      enrollments: [await enrol(a, "d")],
    };
    await saveReplica(db, replica);
    expect((await listAside(db)).map((x) => x.raw)).toEqual(["garbage"]);
    const got = await loadReplica(db, MID);
    expect(got.kind === "value" && got.replica).toEqual(replica);
  });

  it("a replica stored under the wrong motebit id is corrupt, never merged", async () => {
    const db = await freshDb()();
    await rawPut(db, MID, emptyReplica(OTHER_MID));
    expect((await loadReplica(db, MID)).kind).toBe("corrupt");
  });
});

async function rawPut(db: IDBDatabase, key: string, value: unknown, store = "replicas") {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("put failed"));
  });
}

// ── The bounded open, and the rotation commit's link (F7) ───────────

describe("openRosterDb never hangs; the rotation commit appends its link", () => {
  it("a blocked open rejects at once, and an open that never settles times out", async () => {
    const blocked = {
      open: () => {
        const req = {} as IDBOpenDBRequest;
        setTimeout(() => (req.onblocked as (() => void) | null)?.(), 0);
        return req;
      },
    } as unknown as IDBFactory;
    await expect(openRosterDb(blocked, 60_000)).rejects.toThrow(/blocked by another tab/);
    const wedged = { open: () => ({}) as IDBOpenDBRequest } as unknown as IDBFactory;
    await expect(openRosterDb(wedged, 10)).rejects.toThrow(/did not open in time/);
  });

  it("a late success after a timeout closes the connection nobody holds", async () => {
    let req!: { onsuccess: (() => void) | null; result: IDBDatabase };
    const closed: boolean[] = [];
    const late = {
      open: () => {
        req = {
          onsuccess: null,
          result: { close: () => closed.push(true) } as unknown as IDBDatabase,
        };
        return req;
      },
    } as unknown as IDBFactory;
    await expect(openRosterDb(late, 5)).rejects.toThrow(/in time/);
    req.onsuccess?.();
    expect(closed).toEqual([true]);
  });

  it("the rotation commit's roster step appends the link, idempotently, and never throws", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const db = freshDb();
    await rosterAfterRotationCommit({ motebitId: MID, record, db });
    await rosterAfterRotationCommit({ motebitId: MID, record, db });
    const rep = await loadReplica(await db(), MID);
    expect(rep.kind === "value" && rep.replica.succession).toEqual([record]);
    await expect(
      rosterAfterRotationCommit({
        motebitId: MID,
        record,
        db: () => Promise.reject(new Error("x")),
      }),
    ).resolves.toBeUndefined();
    // A wedged database is bounded: the rotation proceeds.
    const wedged = { open: () => ({}) as IDBOpenDBRequest } as unknown as IDBFactory;
    await expect(
      rosterAfterRotationCommit({ motebitId: MID, record, db: () => openRosterDb(wedged, 10) }),
    ).resolves.toBeUndefined();
  });

  it("web's rotation commit takes the record and runs the roster step after the key is stored", async () => {
    const a = await generateKeypair();
    const stored: string[] = [bytesToHex(a.privateKey)];
    let pending: string | null = null;
    const keyStore = {
      loadPrivateKey: async () => stored[stored.length - 1]!,
      storePrivateKey: async (h: string) => {
        stored.push(h);
      },
      loadPendingRotation: async () => pending,
      storePendingRotation: async (p: string) => {
        pending = p;
      },
      clearPendingRotation: async () => {
        pending = null;
      },
      setAsidePendingRotation: async () => {
        pending = null;
      },
    } as unknown as EncryptedKeyStore;
    localStorage.setItem("motebit:device_public_key", hex(a));
    const db = freshDb();
    const seen: Array<{ keysStored: number; record: KeySuccessionRecord }> = [];
    const out = await rotateWebKey({
      keyStore,
      motebitId: MID,
      deviceId: "tab-device",
      syncUrl: null,
      onCommitted: () => undefined,
      afterCommit: async ({ record }) => {
        seen.push({ keysStored: stored.length, record });
        await rosterAfterRotationCommit({ motebitId: MID, record, db });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.keysStored).toBe(2); // the new key was stored first
    expect(seen[0]!.record.old_public_key).toBe(hex(a));
    expect(seen[0]!.record.new_public_key).toBe(out.newPublicKey);
    const rep = await loadReplica(await db(), MID);
    expect(rep.kind === "value" && rep.replica.succession).toEqual([seen[0]!.record]);
  });
});

// ── F8 — the presentation record ─────────────────────────────────────

describe("F8 — presentation record and Retry-After", () => {
  it("the record round-trips; a malformed one reads as none", async () => {
    const db = await freshDb()();
    expect(await loadPresentationRecord(db, MID)).toBeNull();
    await putPresentationRecord(db, MID, { digest: "d", taken_at: 1, retry_until: 2 });
    expect(await loadPresentationRecord(db, MID)).toEqual({
      digest: "d",
      taken_at: 1,
      retry_until: 2,
    });
    await rawPut(db, MID, { digest: 3 }, "presentation");
    expect(await loadPresentationRecord(db, MID)).toBeNull();
  });

  it("Retry-After: delta-seconds or an HTTP date", () => {
    expect(retryAfterMs(null, NOW)).toBeUndefined();
    expect(retryAfterMs(" ", NOW)).toBeUndefined();
    expect(retryAfterMs("30", NOW)).toBe(30_000);
    expect(retryAfterMs(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000);
    expect(retryAfterMs("soon", NOW)).toBeUndefined();
  });
});

// ── The ports ────────────────────────────────────────────────────────

describe("web ports", () => {
  it("the roster routes carry a device:auth token under the HELD key (never a master token)", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    const ports = webRosterPorts({
      motebitId: MID,
      deviceId: "tab-device",
      loadPrivateKeyHex: async () => bytesToHex(a.privateKey),
      syncUrl: () => "https://relay.test",
      db: freshDb(),
      fetchImpl: relay.fetch as typeof fetch,
    });
    const signer = (await ports.signer())!;
    expect(signer.publicKeyHex).toBe(hex(a));
    expect((await ports.fetchRoster(signer)).ok).toBe(true);
    const token = relay.auth[0]!.replace(/^Bearer /, "");
    const payload = await verifySignedToken(token, a.publicKey);
    expect(payload).toMatchObject({ mid: MID, did: "tab-device", aud: "device:auth" });
  });

  it("no key → no signer; no relay → failed reads; a non-chain body is a failed read", async () => {
    const relay = new FetchRelay();
    const base = {
      motebitId: MID,
      deviceId: "tab-device",
      db: freshDb(),
      fetchImpl: relay.fetch as typeof fetch,
    };
    const none = webRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => null,
      syncUrl: () => null,
    });
    expect(await none.signer()).toBeNull();
    expect(await none.fetchSuccession()).toEqual({ ok: false, reason: "no relay is configured" });
    const a = await generateKeypair();
    const s = (await webRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => bytesToHex(a.privateKey),
      syncUrl: () => "",
    }).signer())!;
    expect(await none.presentRoster(s, { enrollments: [], retirements: [] })).toEqual({
      status: null,
      reason: "no relay is configured",
    });
    const odd = webRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => null,
      syncUrl: () => "https://relay.test",
      fetchImpl: (async () => Response.json({ chain: "nope" })) as typeof fetch,
    });
    expect(await odd.fetchSuccession()).toEqual({
      ok: false,
      reason: "the succession route's answer was not a key chain",
    });
    const down = webRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => null,
      syncUrl: () => "https://relay.test",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(await down.fetchSuccession()).toEqual({ ok: false, reason: "offline" });
    expect(await down.presentRoster(s, { enrollments: [], retirements: [] })).toEqual({
      status: null,
      reason: "offline",
    });
    const status = webRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => null,
      syncUrl: () => "https://relay.test",
      fetchImpl: (async () => new Response("x", { status: 503 })) as typeof fetch,
    });
    expect(await status.fetchSuccession()).toEqual({
      ok: false,
      reason: "succession route answered 503",
    });
  });

  it("a 429 carries its Retry-After beside the response", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.retryAfter = "12";
    const ports = webRosterPorts({
      motebitId: MID,
      deviceId: "tab-device",
      loadPrivateKeyHex: async () => bytesToHex(a.privateKey),
      syncUrl: () => "https://relay.test",
      db: freshDb(),
      fetchImpl: relay.fetch as typeof fetch,
      now: () => NOW,
    });
    const res = await ports.presentRoster((await ports.signer())!, {
      enrollments: [],
      retirements: [],
    });
    expect(res).toMatchObject({ status: 429, retryAfterMs: 12_000 });
  });

  it("exclusive uses a cross-tab Web Lock per motebit; without Web Locks it refuses", async () => {
    const locks = new FakeLocks();
    const base = {
      motebitId: MID,
      deviceId: "tab-device",
      loadPrivateKeyHex: async () => null,
      syncUrl: () => null,
      db: freshDb(),
    };
    const withLocks = webRosterPorts({ ...base, locks });
    expect(await withLocks.cache.exclusive(async () => 7)).toBe(7);
    expect(locks.requested).toEqual([`motebit-roster-mint:${MID}`]);
    const without = webRosterPorts({ ...base, locks: null });
    await expect(without.cache.exclusive(async () => 7)).rejects.toThrow(NO_LOCKS);
  });
});

// ── The roster in a tab ──────────────────────────────────────────────

describe("createWebMachineRoster", () => {
  it("only one tab presents: the first holds the leader lock; disposing it hands over", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    const locks = new FakeLocks();
    const db = freshDb();
    const t1 = tab(relay, a, db, locks);
    const t2 = tab(relay, a, db, locks);
    await Promise.resolve();
    await Promise.resolve();
    expect(t1.isPresenter()).toBe(true);
    expect(t2.isPresenter()).toBe(false);
    expect(locks.requested.filter((n) => n === PRESENT_LOCK)).toHaveLength(2);
    t1.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(t1.isPresenter()).toBe(false);
    expect(t2.isPresenter()).toBe(true);
    t2.dispose();
  });

  it("a tab without Web Locks reads but cannot write, and never presents", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const t = tab(relay, a, freshDb(), null);
    await t.section.refresh();
    const s = t.section.getState();
    expect(s.view?.kind).toBe("roster");
    expect(s.writeBlocked).toBe(NO_LOCKS);
    expect(s.lineActions.some((x) => x.retire || x.enroll)).toBe(false);
    expect(t.isPresenter()).toBe(false);
    expect(relay.posts).toBe(0);
  });

  it("an identity key the relay names (legacy route 3) retires end to end; the retirement lands in IndexedDB and at the relay", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const db = freshDb();
    const t = tab(relay, a, db, new FakeLocks());
    await t.section.refresh();
    expect(t.section.getState().heldKey).toEqual({ kind: "identity", basis: "relay" });
    await t.section.retire("dev-host");
    expect(t.section.getState().notice?.tone).toBe("done");
    expect(relay.ret.size).toBe(1);
    const rep = await loadReplica(await db(), MID);
    expect(rep.kind === "value" && rep.replica.retirements).toHaveLength(1);
    t.dispose();
  });

  it("#797: a legacy identity-key browser whose relay names no key is unconfirmed — lines, no count, actions hidden and refused", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay(); // current_public_key: null
    relay.enr.set("x", await enrol(a, "dev-host"));
    const t = tab(relay, a, freshDb(), new FakeLocks());
    await t.section.refresh();
    const s = t.section.getState();
    expect(s.heldKey).toEqual({ kind: "unconfirmed", why: "legacy-unproven" });
    expect(s.heldKeyText).toMatch(/counts need the CLI or a sovereign identity/);
    expect(s.view?.kind === "roster" && s.view.claim).toBeNull();
    expect(s.view?.kind === "roster" && s.view.lines).toHaveLength(1);
    expect(s.lineActions.every((x) => !x.retire && !x.enroll)).toBe(true);
    await t.section.retire("dev-host");
    expect(relay.ret.size).toBe(0);
    t.dispose();
  });

  it("#797 probe: a browser holding an approver's device-only key (2 identity enrolments, hint null) never counts and never enrols", async () => {
    const k = await generateKeypair();
    const d = await generateKeypair();
    const relay = new FetchRelay();
    relay.enr.set("1", await enrol(k, "host-1"));
    relay.enr.set("2", await enrol(k, "host-2"));
    relay.rows = [{ device_id: "host-3", bound_under: hex(k), last_seen_at: NOW, sockets_open: 1 }];
    const t = tab(relay, d, freshDb(), new FakeLocks());
    await t.section.refresh();
    const s = t.section.getState();
    expect(s.heldKey?.kind).not.toBe("identity");
    expect(s.view?.kind === "roster" && s.view.claim).toBeNull();
    expect(s.lineActions.some((x) => x.enroll || x.retire)).toBe(false);
    await t.section.enroll("host-3", { force: true });
    expect(relay.enr.size).toBe(2);
    expect(relay.posts).toBe(0);
    t.dispose();
  });

  it("enroll of this browser's own id is refused; the leader presents on refresh, and a 429 defers the next", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const db = freshDb();
    const t = tab(relay, a, db, new FakeLocks());
    await Promise.resolve();
    await t.section.enroll("tab-device", { force: true });
    expect(t.section.getState().notice?.text).toBe("This device is not a host.");
    await t.section.refresh();
    expect(relay.posts).toBe(1);
    expect((await loadPresentationRecord(await db(), MID))?.digest).toEqual(expect.any(String));
    await t.section.refresh();
    expect(relay.posts).toBe(1); // unchanged, and not yet due
    // A retirement changes the replica; the relay then rate-limits.
    relay.retryAfter = "60";
    await t.section.retire("dev-host");
    expect((await loadPresentationRecord(await db(), MID))?.retry_until).toBe(NOW + 60_000);
    const before = relay.posts;
    await t.section.refresh();
    expect(relay.posts).toBe(before); // deferred by Retry-After
    t.dispose();
  });
});

describe("#799 F1 — a stored Retry-After holds the first presentation of a fresh tab", () => {
  for (const stored of [true, false]) {
    it(`omission repair on the first refresh ${stored ? "waits" : "(control: nothing stored) runs"}`, async () => {
      const a = await generateKeypair();
      const relay = new FetchRelay();
      relay.current = hex(a);
      relay.enr.set("x", await enrol(a, "dev-host"));
      const db = freshDb();
      // The replica holds an enrolment the relay omits: acquire repairs it.
      await saveReplica(await db(), {
        ...emptyReplica(MID),
        enrollments: [await enrol(a, "dev-omitted")],
      });
      if (stored) {
        await putPresentationRecord(await db(), MID, {
          digest: null,
          taken_at: 0,
          retry_until: NOW + 60_000,
        });
      }
      const t = tab(relay, a, db, new FakeLocks()); // a fresh tab: nothing in memory
      await Promise.resolve();
      await Promise.resolve();
      expect(t.isPresenter()).toBe(true);
      await t.section.refresh();
      if (stored) expect(relay.posts).toBe(0);
      else expect(relay.posts).toBeGreaterThan(0);
      t.dispose();
    });
  }
});

describe("#801 F1 — a Retry-After is bounded (MAX_RETRY_AFTER_MS)", () => {
  async function omitted(a: KeyPair, db: () => Promise<IDBDatabase>) {
    await saveReplica(await db(), {
      ...emptyReplica(MID),
      enrollments: [await enrol(a, "dev-omitted")],
    });
  }

  it("a stored retry_until ten years out never freezes presenting: the first refresh repairs", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    const db = freshDb();
    await omitted(a, db);
    await putPresentationRecord(await db(), MID, {
      digest: null,
      taken_at: 0,
      retry_until: NOW + 10 * 365 * 86_400_000,
    });
    const t = tab(relay, a, db, new FakeLocks());
    await Promise.resolve();
    await Promise.resolve();
    await t.section.refresh();
    expect(relay.posts).toBeGreaterThan(0);
    t.dispose();
  });

  it("a stored retry_until inside the bound holds, then presents once it elapses", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    const db = freshDb();
    await omitted(a, db);
    await putPresentationRecord(await db(), MID, {
      digest: null,
      taken_at: 0,
      retry_until: NOW + 30 * 60_000,
    });
    let clock = NOW;
    const t = tab(relay, a, db, new FakeLocks(), { now: () => clock });
    await Promise.resolve();
    await Promise.resolve();
    await t.section.refresh();
    expect(relay.posts).toBe(0);
    clock = NOW + 31 * 60_000;
    await t.section.refresh();
    expect(relay.posts).toBeGreaterThan(0);
    t.dispose();
  });

  it("a 429 with Retry-After: 999999999 is stored as at most now + the bound", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    relay.retryAfter = "999999999";
    const db = freshDb();
    const t = tab(relay, a, db, new FakeLocks());
    await Promise.resolve();
    await Promise.resolve();
    await t.section.refresh();
    expect(relay.posts).toBeGreaterThan(0);
    const rec = await loadPresentationRecord(await db(), MID);
    expect(rec?.retry_until).toBe(NOW + MAX_RETRY_AFTER_MS);
    t.dispose();
  });
});

describe("#802 — a permanent refusal, through the browser's ports and IndexedDB", () => {
  it("too_large is kept in IndexedDB with its reason, never presented again, and the count stands with a note", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const big = await enrol(a, "b".repeat(5000));
    const id = await hostEnrollmentId(big);
    relay.refuse.set(id, "too_large");
    const db = freshDb();
    await saveReplica(await db(), { ...emptyReplica(MID), enrollments: [big] });
    const t = tab(relay, a, db, new FakeLocks());
    await Promise.resolve();
    await t.section.refresh();

    const rep = await loadReplica(await db(), MID);
    expect(rep.kind === "value" && rep.replica.relay_refused).toEqual([
      { id, reason: "too_large" },
    ]);
    const sentBig = () => relay.bodies.filter((b) => b.includes("b".repeat(1000))).length;
    expect(sentBig()).toBe(1); // once: the omission repair
    const view = t.section.getState().view;
    if (view?.kind !== "roster") throw new Error(String(view?.kind));
    expect(view.claim).not.toBeNull(); // not an omission: the count stands
    expect(view.notes.map((n) => n.text)).toContain(
      "the relay will not hold 1 entry this device holds (too_large); kept here and counted, not presented again",
    );
    // The presentation was taken in full (nothing left to retry): the digest is stamped.
    expect((await loadPresentationRecord(await db(), MID))?.digest).toEqual(expect.any(String));

    // A later act presents again — never the refused entry, and never promised it.
    await t.section.retire("dev-host");
    expect(t.section.getState().notice?.text).not.toMatch(/presented again/);
    await t.section.refresh();
    expect(sentBig()).toBe(1);
    t.dispose();
  });

  it("a reason this browser does not know stays retryable: presented again, and the count suppressed", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const odd = await enrol(a, "odd");
    relay.refuse.set(await hostEnrollmentId(odd), "some_future_reason");
    const db = freshDb();
    await saveReplica(await db(), { ...emptyReplica(MID), enrollments: [odd] });
    const t = tab(relay, a, db, new FakeLocks());
    await Promise.resolve();
    await t.section.refresh();
    const rep = await loadReplica(await db(), MID);
    expect(rep.kind === "value" && rep.replica.relay_refused).toEqual([]);
    const view = t.section.getState().view;
    expect(view?.kind === "roster" && view.claim).toBeNull();
    const sentOdd = () => relay.bodies.filter((b) => b.includes('"odd"')).length;
    const before = sentOdd();
    await t.section.refresh();
    expect(sentOdd()).toBeGreaterThan(before);
    t.dispose();
  });
});

describe("F8 — an act while the relay has asked to wait", () => {
  it("is kept in IndexedDB and reported not taken; it is not sent until the wait is over", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const db = freshDb();
    await putPresentationRecord(await db(), MID, {
      digest: null,
      taken_at: 0,
      retry_until: NOW + 60_000,
    });
    const t = tab(relay, a, db, new FakeLocks());
    await Promise.resolve();
    await t.section.refresh(); // learns the pending Retry-After
    expect(relay.posts).toBe(0);
    await t.section.retire("dev-host");
    expect(relay.posts).toBe(0);
    expect(t.section.getState().notice?.text).toMatch(
      /Not yet taken by the relay; kept here and presented again/,
    );
    const rep = await loadReplica(await db(), MID);
    expect(rep.kind === "value" && rep.replica.retirements).toHaveLength(1);
    t.dispose();
  });
});

void hexToBytes;

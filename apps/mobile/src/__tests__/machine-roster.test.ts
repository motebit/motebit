/**
 * The phone's machine roster — `docs/proposals/machine-roster-surfaces-v1.md`
 * C-2b: the AsyncStorage replica (one key per motebit, merge-save on its own
 * in-process chain, corrupt values kept aside), the ports (device token under
 * the held key, the stored motebit.md as a record source, Retry-After), the
 * gated roster (own-enroll refused, legacy hint-null unconfirmed, device-only
 * hidden), the presentation cadence, and the rotation commit's link.
 *
 * AsyncStorage is an in-memory map that YIELDS between operations, so an
 * unserialized get → merge → set interleaves exactly as it can on a phone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const kvData = new Map<string, string>();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => {
      await tick();
      return kvData.get(k) ?? null;
    }),
    setItem: vi.fn(async (k: string, v: string) => {
      await tick();
      kvData.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      await tick();
      kvData.delete(k);
    }),
  },
}));

import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hostEnrollmentId,
  hostRetirementId,
  signHostEnrollment,
  signHostRetirement,
  signGuardianRecoverySuccession,
  signKeySuccession,
  verifySignedToken,
  type KeyPair,
} from "@motebit/encryption";
import { generate, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { MAX_RETRY_AFTER_MS, emptyReplica, type MachineRosterReplica } from "@motebit/surface-kit";
import type { HostEnrollment, HostRetirement, KeySuccessionRecord } from "@motebit/sdk";
import {
  loadPresentationRecord,
  loadReplica,
  putPresentationRecord,
  rosterExclusive,
  saveReplica,
  type RosterKV,
} from "../machine-roster-store";
import {
  DISPOSED,
  createMobileMachineRoster,
  identityFileRecords,
  mobileRosterPorts,
  retryAfterMs,
  rosterAfterRotationCommit,
} from "../machine-roster";
import { rotateMobileKey } from "../key-rotation";
import { machinesModel } from "../machines-render-model";
import { machineRosterKey, machineRosterPresentationKey } from "../storage-keys";

const MID = "0190f1a2-0000-7000-8000-00000000abcd"; // legacy
const OTHER_MID = "0190f1a2-0000-7000-8000-00000000ef01";
const NOW = 1_800_000_000_000;
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

beforeEach(() => {
  kvData.clear();
});

const enrol = (kp: KeyPair, deviceId: string, motebitId = MID) =>
  signHostEnrollment(
    { motebit_id: motebitId, device_id: deviceId, public_key: hex(kp), enrolled_at: NOW },
    kp.privateKey,
  );
const retire = async (kp: KeyPair, e: HostEnrollment, motebitId = MID) =>
  signHostRetirement(
    {
      motebit_id: motebitId,
      enrollment_id: await hostEnrollmentId(e),
      public_key: hex(kp),
      retired_at: NOW,
    },
    kp.privateKey,
  );

const asideKeys = () => [...kvData.keys()].filter((k) => k.includes(".corrupt-"));

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
      const body = JSON.parse(init!.body as string) as {
        enrollments: HostEnrollment[];
        retirements: HostRetirement[];
      };
      for (const e of body.enrollments) this.enr.set(await hostEnrollmentId(e), e);
      for (const r of body.retirements) this.ret.set(await hostRetirementId(r), r);
      return Response.json({ accepted: [] });
    }
    return new Response("not found", { status: 404 });
  };
}

function phone(
  relay: FetchRelay,
  key: KeyPair,
  opts: {
    deviceId?: string;
    motebitId?: string;
    identityFile?: string | null;
    now?: () => number;
  } = {},
) {
  return createMobileMachineRoster({
    motebitId: opts.motebitId ?? MID,
    deviceId: opts.deviceId ?? "phone-device",
    loadPrivateKeyHex: async () => bytesToHex(key.privateKey),
    syncUrl: async () => "https://relay.test/",
    loadIdentityFile: async () => opts.identityFile ?? null,
    fetchImpl: relay.fetch as typeof fetch,
    now: opts.now ?? (() => NOW),
  });
}

const stored = (id = MID): MachineRosterReplica | null => {
  const raw = kvData.get(machineRosterKey(id));
  return raw == null ? null : (JSON.parse(raw) as MachineRosterReplica);
};

// ── The AsyncStorage replica ─────────────────────────────────────────

describe("AsyncStorage replica — one key per motebit, merge-save on its own chain", () => {
  it("F4: each motebit has its own key — another identity never inherits or destroys one", async () => {
    const a = await generateKeypair();
    await saveReplica({ ...emptyReplica(MID), enrollments: [await enrol(a, "d1")] });
    await saveReplica({
      ...emptyReplica(OTHER_MID),
      enrollments: [await enrol(a, "d2", OTHER_MID)],
    });
    expect([...kvData.keys()].sort()).toEqual(
      [machineRosterKey(MID), machineRosterKey(OTHER_MID)].sort(),
    );
    expect(machineRosterKey(MID)).toBe(`@motebit/machine_roster/${MID}`);
    const one = await loadReplica(MID);
    const two = await loadReplica(OTHER_MID);
    expect(one.kind === "value" && one.replica.enrollments.map((x) => x.device_id)).toEqual(["d1"]);
    expect(two.kind === "value" && two.replica.enrollments.map((x) => x.device_id)).toEqual(["d2"]);
    expect((await loadReplica("0190f1a2-0000-7000-8000-000000000000")).kind).toBe("absent");
  });

  it("F3: concurrent saves never lose a retirement", async () => {
    const a = await generateKeypair();
    const e = await enrol(a, "dev-host");
    const r = await retire(a, e);
    for (let i = 0; i < 5; i++) {
      await Promise.all([
        saveReplica({ ...emptyReplica(MID), retirements: [r] }),
        saveReplica({ ...emptyReplica(MID), enrollments: [e] }),
        rosterAfterRotationCommit({
          motebitId: MID,
          record: await signKeySuccession(a.privateKey, a.privateKey, a.publicKey, a.publicKey),
        }),
      ]);
    }
    const got = stored();
    expect(got?.retirements).toEqual([r]);
    expect(got?.enrollments).toEqual([e]);
  });

  it("F3: the save chain is separate from exclusive — a save inside exclusive completes", async () => {
    const a = await generateKeypair();
    const out = await rosterExclusive(MID, async () => {
      await saveReplica({ ...emptyReplica(MID), enrollments: [await enrol(a, "d")] });
      return 7;
    });
    expect(out).toBe(7);
    expect(stored()?.enrollments).toHaveLength(1);
  });

  it("exclusive serializes its holders", async () => {
    const order: string[] = [];
    await Promise.all([
      rosterExclusive(MID, async () => {
        order.push("a+");
        await tick();
        await tick();
        order.push("a-");
      }),
      rosterExclusive(MID, async () => {
        order.push("b+");
        order.push("b-");
      }),
    ]);
    expect(order).toEqual(["a+", "a-", "b+", "b-"]);
  });

  it("R3: a corrupt value is kept aside, byte-for-byte, and reads as corrupt once; the name is then free", async () => {
    kvData.set(machineRosterKey(MID), "{not json");
    expect((await loadReplica(MID, undefined, () => 42)).kind).toBe("corrupt");
    expect(kvData.get(`${machineRosterKey(MID)}.corrupt-42`)).toBe("{not json");
    expect((await loadReplica(MID)).kind).toBe("absent");
  });

  it("R3: a save over a corrupt value keeps it aside before writing", async () => {
    const a = await generateKeypair();
    const junk = JSON.stringify({ version: 1, motebit_id: MID, succession: "not a list" });
    kvData.set(machineRosterKey(MID), junk);
    const replica: MachineRosterReplica = {
      ...emptyReplica(MID),
      enrollments: [await enrol(a, "d")],
    };
    await saveReplica(replica);
    expect(asideKeys().map((k) => kvData.get(k))).toEqual([junk]);
    expect(stored()).toEqual(replica);
  });

  it("R3: when the aside copy fails, nothing is written over the corrupt value", async () => {
    const a = await generateKeypair();
    kvData.set(machineRosterKey(MID), "garbage");
    const kv: RosterKV = {
      getItem: async (k) => kvData.get(k) ?? null,
      setItem: async (k, v) => {
        if (k.includes(".corrupt-")) throw new Error("disk full");
        kvData.set(k, v);
      },
      removeItem: async (k) => {
        kvData.delete(k);
      },
    };
    await expect(
      saveReplica({ ...emptyReplica(MID), enrollments: [await enrol(a, "d")] }, kv),
    ).rejects.toThrow("disk full");
    await expect(loadReplica(MID, kv)).rejects.toThrow("disk full");
    expect(kvData.get(machineRosterKey(MID))).toBe("garbage");
  });

  it("a replica stored under the wrong motebit id is corrupt, never merged", async () => {
    kvData.set(machineRosterKey(MID), JSON.stringify(emptyReplica(OTHER_MID)));
    expect((await loadReplica(MID)).kind).toBe("corrupt");
  });

  it("the presentation record round-trips per motebit; a malformed one reads as none", async () => {
    expect(await loadPresentationRecord(MID)).toBeNull();
    await putPresentationRecord(MID, { digest: "d", taken_at: 1, retry_until: 2 });
    expect(await loadPresentationRecord(MID)).toEqual({ digest: "d", taken_at: 1, retry_until: 2 });
    expect(await loadPresentationRecord(OTHER_MID)).toBeNull();
    kvData.set(machineRosterPresentationKey(MID), JSON.stringify({ digest: 3 }));
    expect(await loadPresentationRecord(MID)).toBeNull();
    kvData.set(machineRosterPresentationKey(MID), "{");
    expect(await loadPresentationRecord(MID)).toBeNull();
  });
});

// ── The ports ────────────────────────────────────────────────────────

describe("mobile ports", () => {
  it("the roster routes carry a device:auth token under the HELD key (never a master token)", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    const ports = mobileRosterPorts({
      motebitId: MID,
      deviceId: "phone-device",
      loadPrivateKeyHex: async () => bytesToHex(a.privateKey),
      syncUrl: async () => "https://relay.test",
      loadIdentityFile: async () => null,
      fetchImpl: relay.fetch as typeof fetch,
    });
    const signer = (await ports.signer())!;
    expect(signer.publicKeyHex).toBe(hex(a));
    expect((await ports.fetchRoster(signer)).ok).toBe(true);
    const token = relay.auth[0]!.replace(/^Bearer /, "");
    const payload = await verifySignedToken(token, a.publicKey);
    expect(payload).toMatchObject({ mid: MID, did: "phone-device", aud: "device:auth" });
  });

  it("no key → no signer; no relay → failed reads; a non-chain body is a failed read; a 429 carries Retry-After", async () => {
    const a = await generateKeypair();
    const base = {
      motebitId: MID,
      deviceId: "phone-device",
      loadIdentityFile: async () => null,
      now: () => NOW,
    };
    const none = mobileRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => null,
      syncUrl: async () => null,
    });
    expect(await none.signer()).toBeNull();
    expect(await none.fetchSuccession()).toEqual({ ok: false, reason: "no relay is configured" });
    const odd = mobileRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => null,
      syncUrl: async () => "https://relay.test",
      fetchImpl: (async () => Response.json({ chain: "nope" })) as typeof fetch,
    });
    expect(await odd.fetchSuccession()).toEqual({
      ok: false,
      reason: "the succession route's answer was not a key chain",
    });
    const relay = new FetchRelay();
    relay.retryAfter = "12";
    const ports = mobileRosterPorts({
      ...base,
      loadPrivateKeyHex: async () => bytesToHex(a.privateKey),
      syncUrl: async () => "https://relay.test",
      fetchImpl: relay.fetch as typeof fetch,
    });
    const res = await ports.presentRoster((await ports.signer())!, {
      enrollments: [],
      retirements: [],
    });
    expect(res).toMatchObject({ status: 429, retryAfterMs: 12_000 });
    expect(retryAfterMs(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000);
    expect(retryAfterMs("soon", NOW)).toBeUndefined();
  });

  it("the stored motebit.md is a record source only when it verifies and names THIS motebit", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const g = await generateKeypair();
    const file = await generate(
      {
        motebitId: MID,
        ownerId: "owner",
        publicKeyHex: hex(a),
        guardian: { public_key: hex(g), established_at: "2026-01-01T00:00:00.000Z" },
      },
      a.privateKey,
    );
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const rotated = await rotateIdentityFile({
      existingContent: file,
      newPublicKey: b.publicKey,
      newPrivateKey: b.privateKey,
      successionRecord: record,
    });
    const recs = await identityFileRecords(MID, rotated, hex(b));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.new_public_key).toBe(hex(b));
    // #799 W1 — a file whose current key is not the held key contributes nothing.
    expect(await identityFileRecords(MID, rotated, hex(a))).toEqual([]);
    expect(await identityFileRecords(MID, rotated, null)).toEqual([]);
    expect(await identityFileRecords(OTHER_MID, rotated, hex(b))).toEqual([]);
    const tampered = rotated.replace(hex(g), hex(a));
    expect(await identityFileRecords(MID, tampered, hex(b))).toEqual([]);
    expect(await identityFileRecords(MID, null, hex(b))).toEqual([]);
  });

  it("#799 W1: the phone never pins a guardian, whatever its stored file names", async () => {
    const a = await generateKeypair();
    const g = await generateKeypair();
    const file = await generate(
      {
        motebitId: MID,
        ownerId: "owner",
        publicKeyHex: hex(a),
        guardian: { public_key: hex(g), established_at: "2026-01-01T00:00:00.000Z" },
      },
      a.privateKey,
    );
    const ports = mobileRosterPorts({
      motebitId: MID,
      deviceId: "phone-device",
      loadPrivateKeyHex: async () => bytesToHex(a.privateKey),
      syncUrl: async () => null,
      loadIdentityFile: async () => file,
    });
    expect(await ports.pinnedGuardian()).toBeNull();
    expect(await ports.localSuccession()).toEqual([]); // no records, and the key matches
  });
});

// ── The gated roster on the phone ────────────────────────────────────

describe("createMobileMachineRoster", () => {
  it("S2: enroll of this phone's own id is refused — nothing signed, nothing sent", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const p = phone(relay, a);
    await p.section.refresh();
    const posts = relay.posts;
    await p.section.enroll("phone-device", { force: true });
    expect(p.section.getState().notice?.text).toBe("This device is not a host.");
    expect(relay.posts).toBe(posts);
    expect([...relay.enr.values()].some((e) => e.device_id === "phone-device")).toBe(false);
    expect(stored()?.enrollments.some((e) => e.device_id === "phone-device") ?? false).toBe(false);
    expect(stored()?.own_device_ids ?? []).toEqual([]);
  });

  it("an identity key the relay names (legacy route 3) retires end to end; the retirement lands under this motebit's key and at the relay", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const p = phone(relay, a);
    await p.section.refresh();
    expect(p.section.getState().heldKey).toEqual({ kind: "identity", basis: "relay" });
    expect(p.section.getState().lineActions).toEqual([{ retire: true, enroll: false }]);
    await p.section.retire("dev-host");
    expect(p.section.getState().notice?.tone).toBe("done");
    expect(relay.ret.size).toBe(1);
    expect(stored()?.retirements).toHaveLength(1);
  });

  it("#797: a legacy identity whose relay names no key is unconfirmed — lines, no count, no actions, acts refused", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay(); // current_public_key: null
    relay.enr.set("x", await enrol(a, "dev-host"));
    const p = phone(relay, a);
    await p.section.refresh();
    const s = p.section.getState();
    expect(s.heldKey).toEqual({ kind: "unconfirmed", why: "legacy-unproven" });
    expect(s.rosterHidden).toBe(false);
    expect(s.view?.kind === "roster" && s.view.claim).toBeNull();
    expect(s.view?.kind === "roster" && s.view.lines).toHaveLength(1);
    expect(s.lineActions.every((x) => !x.retire && !x.enroll)).toBe(true);
    await p.section.retire("dev-host");
    expect(relay.ret.size).toBe(0);
    expect(relay.posts).toBe(0);
  });

  it("a device-only key (the relay names another key current) hides the roster and signs nothing", async () => {
    const k = await generateKeypair();
    const d = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(k);
    relay.enr.set("1", await enrol(k, "host-1"));
    relay.rows = [{ device_id: "host-3", bound_under: hex(k), last_seen_at: NOW, sockets_open: 1 }];
    const p = phone(relay, d);
    await p.section.refresh();
    const s = p.section.getState();
    expect(s.heldKey?.kind).toBe("device-key");
    expect(s.rosterHidden).toBe(true);
    await p.section.enroll("host-3", { force: true });
    expect(relay.enr.size).toBe(1);
    expect(relay.posts).toBe(0);
  });

  for (const fileKey of ["held", "foreign"] as const) {
    it(`#799 W1 probe (${fileKey} file key): a planted self-signed motebit.md naming a guardian with a recovery onto the device-only key never makes it the identity key`, async () => {
      const g = await generateKeypair(); // the sovereign genesis key
      const d = await generateKeypair(); // the phone's device-only key
      const a = await generateKeypair(); // the planted file's signer
      const gg = await generateKeypair(); // the guardian the planted file names
      const y = await deriveSovereignMotebitId(hex(g));
      const recovery = await signGuardianRecoverySuccession(
        gg.privateKey,
        d.privateKey,
        g.publicKey,
        d.publicKey,
      );
      const planted = await generate(
        {
          motebitId: y,
          ownerId: "o",
          publicKeyHex: hex(a),
          guardian: { public_key: hex(gg), established_at: "2026-01-01T00:00:00.000Z" },
        },
        a.privateKey,
      );
      const to = fileKey === "held" ? d : await generateKeypair();
      const file = await rotateIdentityFile({
        existingContent: planted,
        newPublicKey: to.publicKey,
        newPrivateKey: to.privateKey,
        successionRecord: recovery,
      });
      const relay = new FetchRelay();
      relay.enr.set("1", await enrol(g, "host-1", y));
      relay.enr.set("2", await enrol(g, "host-2", y));
      const p = phone(relay, d, { motebitId: y, identityFile: file });
      await p.section.refresh();
      const s = p.section.getState();
      expect(s.heldKey?.kind).not.toBe("identity");
      expect(s.view?.kind === "roster" ? s.view.claim : null).toBeNull();
      expect(s.lineActions.some((x) => x.retire || x.enroll)).toBe(false);
      await p.section.retire("host-1");
      expect(relay.ret.size).toBe(0);
      expect(relay.posts).toBe(0);
    });
  }

  it("route 1 on the phone: a rotated sovereign identity roots through the stored motebit.md's link while the relay serves no chain", async () => {
    const g = await generateKeypair();
    const b = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(g));
    const file = await generate(
      { motebitId: mid, ownerId: "o", publicKeyHex: hex(g) },
      g.privateKey,
    );
    const record = await signKeySuccession(g.privateKey, b.privateKey, b.publicKey, g.publicKey);
    const rotated = await rotateIdentityFile({
      existingContent: file,
      newPublicKey: b.publicKey,
      newPrivateKey: b.privateKey,
      successionRecord: record,
    });
    const relay = new FetchRelay(); // chain [], current null: a relay that lost its database
    const p = phone(relay, b, { motebitId: mid, identityFile: rotated });
    await p.section.refresh();
    expect(p.section.getState().heldKey).toEqual({ kind: "identity", basis: "rooted" });
  });

  it("F8: presents on refresh when due, not again while unchanged, and a 429 defers the next", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const p = phone(relay, a);
    await p.section.refresh();
    expect(relay.posts).toBe(1);
    expect((await loadPresentationRecord(MID))?.digest).toEqual(expect.any(String));
    await p.section.refresh();
    expect(relay.posts).toBe(1);
    relay.retryAfter = "60";
    await p.section.retire("dev-host");
    expect((await loadPresentationRecord(MID))?.retry_until).toBe(NOW + 60_000);
    const before = relay.posts;
    await p.section.refresh();
    expect(relay.posts).toBe(before);
  });

  for (const stored of [true, false]) {
    it(`#799 F1: after a restart, a stored Retry-After ${stored ? "holds" : "(control: absent) does not hold"} the omission repair on the first refresh`, async () => {
      const a = await generateKeypair();
      const relay = new FetchRelay();
      relay.current = hex(a);
      relay.enr.set("x", await enrol(a, "dev-host"));
      // The replica holds an enrolment the relay omits: acquire repairs it.
      await saveReplica({ ...emptyReplica(MID), enrollments: [await enrol(a, "dev-omitted")] });
      if (stored) {
        await putPresentationRecord(MID, { digest: null, taken_at: 0, retry_until: NOW + 60_000 });
      }
      const p = phone(relay, a); // a fresh process: nothing in memory
      await p.section.refresh();
      if (stored) expect(relay.posts).toBe(0);
      else expect(relay.posts).toBeGreaterThan(0);
    });
  }

  it("#801 F1: a stored retry_until ten years out never freezes presenting — the first refresh repairs", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    await saveReplica({ ...emptyReplica(MID), enrollments: [await enrol(a, "dev-omitted")] });
    await putPresentationRecord(MID, {
      digest: null,
      taken_at: 0,
      retry_until: NOW + 10 * 365 * 86_400_000,
    });
    const p = phone(relay, a);
    await p.section.refresh();
    expect(relay.posts).toBeGreaterThan(0);
  });

  it("#801 F1: a stored retry_until inside the bound holds, then presents once it elapses", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    await saveReplica({ ...emptyReplica(MID), enrollments: [await enrol(a, "dev-omitted")] });
    await putPresentationRecord(MID, { digest: null, taken_at: 0, retry_until: NOW + 30 * 60_000 });
    let clock = NOW;
    const p = phone(relay, a, { now: () => clock });
    await p.section.refresh();
    expect(relay.posts).toBe(0);
    clock = NOW + 31 * 60_000;
    await p.section.refresh();
    expect(relay.posts).toBeGreaterThan(0);
  });

  it("#801 F1: a 429 with Retry-After: 999999999 is stored as at most now + the bound", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    relay.retryAfter = "999999999";
    const p = phone(relay, a);
    await p.section.refresh();
    expect(relay.posts).toBeGreaterThan(0);
    expect((await loadPresentationRecord(MID))?.retry_until).toBe(NOW + MAX_RETRY_AFTER_MS);
  });

  it("F8: an act while the relay has asked to wait is kept and reported not taken", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    await putPresentationRecord(MID, { digest: null, taken_at: 0, retry_until: NOW + 60_000 });
    const p = phone(relay, a);
    await p.section.refresh();
    expect(relay.posts).toBe(0);
    await p.section.retire("dev-host");
    expect(relay.posts).toBe(0);
    expect(p.section.getState().notice?.text).toMatch(/Not yet taken by the relay/);
    expect(stored()?.retirements).toHaveLength(1);
  });

  it("a disposed roster (identity switch, stop) presents nothing and refuses acts", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const p = phone(relay, a);
    p.dispose();
    await p.section.refresh();
    expect(relay.posts).toBe(0);
    expect(p.section.getState().writeBlocked).toBe(DISPOSED);
    await p.section.retire("dev-host");
    expect(p.section.getState().notice?.text).toBe(DISPOSED);
    expect(relay.ret.size).toBe(0);
  });
});

// ── F7 — the rotation commit appends its link ────────────────────────

describe("the rotation commit's roster step", () => {
  function keyring(initial: KeyPair) {
    const slots = new Map<string, string>([
      ["device_private_key", bytesToHex(initial.privateKey)],
      ["device_public_key", hex(initial)],
    ]);
    return {
      slots,
      get: async (k: string) => slots.get(k) ?? null,
      set: async (k: string, v: string) => {
        slots.set(k, v);
      },
      delete: async (k: string) => {
        slots.delete(k);
      },
    };
  }

  it("mobile's commit runs it after the key is stored, and the link lands in the replica", async () => {
    const a = await generateKeypair();
    const kr = keyring(a);
    const seen: Array<{ slotKey: string | undefined; record: KeySuccessionRecord }> = [];
    const out = await rotateMobileKey({
      keyring: kr,
      motebitId: MID,
      deviceId: "phone-device",
      syncUrl: null,
      identityFile: { load: async () => null, save: async () => undefined },
      onCommitted: () => undefined,
      afterCommit: async ({ record }) => {
        seen.push({ slotKey: kr.slots.get("device_public_key"), record });
        await rosterAfterRotationCommit({ motebitId: MID, record });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slotKey).toBe(out.newPublicKey); // the new key was stored first
    expect(seen[0]!.record.old_public_key).toBe(hex(a));
    expect(seen[0]!.record.new_public_key).toBe(out.newPublicKey);
    expect(stored()?.succession).toEqual([seen[0]!.record]);
  });

  it("a roster failure never fails the rotation", async () => {
    const a = await generateKeypair();
    const kr = keyring(a);
    const out = await rotateMobileKey({
      keyring: kr,
      motebitId: MID,
      deviceId: "phone-device",
      syncUrl: null,
      identityFile: { load: async () => null, save: async () => undefined },
      onCommitted: () => undefined,
      afterCommit: async () => {
        throw new Error("storage wedged");
      },
    });
    expect(kr.slots.get("device_public_key")).toBe(out.newPublicKey);
    const bad: RosterKV = {
      getItem: async () => {
        throw new Error("x");
      },
      setItem: async () => undefined,
      removeItem: async () => undefined,
    };
    const record = await signKeySuccession(a.privateKey, a.privateKey, a.publicKey, a.publicKey);
    await expect(
      rosterAfterRotationCommit({ motebitId: MID, record, kv: bad }),
    ).resolves.toBeUndefined();
  });

  it("the link append is idempotent", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    await rosterAfterRotationCommit({ motebitId: MID, record });
    await rosterAfterRotationCommit({ motebitId: MID, record });
    expect(stored()?.succession).toEqual([record]);
  });
});

// ── The render model (what MachinesSection.tsx lays out) ─────────────

describe("machinesModel — the Settings → Identity → Machines render", () => {
  it("identity key: the count, each line with its actions", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const p = phone(relay, a);
    await p.section.refresh();
    const m = machinesModel(p.section.getState());
    expect(m.claim).toEqual(expect.any(String));
    expect(m.noCount).toBeNull();
    expect(m.lines).toEqual([
      expect.objectContaining({ deviceId: "dev-host", retire: true, enroll: false }),
    ]);
  });

  it("#797 legacy hint-null: lines, NO count (the reason instead), no actions", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.enr.set("x", await enrol(a, "dev-host"));
    const p = phone(relay, a);
    await p.section.refresh();
    const m = machinesModel(p.section.getState());
    expect(m.claim).toBeNull();
    expect(m.noCount).toMatch(/^No count: /);
    expect(m.head.map((n) => n.text).join(" ")).toMatch(/counts need the CLI/);
    expect(m.lines).toHaveLength(1);
    expect(m.lines.some((l) => l.retire || l.enroll)).toBe(false);
  });

  it("device-only key: only the reason — no count, no lines, no notes", async () => {
    const k = await generateKeypair();
    const d = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(k);
    relay.enr.set("1", await enrol(k, "host-1"));
    const p = phone(relay, d);
    await p.section.refresh();
    const s = p.section.getState();
    const m = machinesModel(s);
    expect(m.head.map((n) => n.text)).toEqual([s.heldKeyText]);
    expect(m.claim).toBeNull();
    expect(m.noCount).toBeNull();
    expect(m.lines).toEqual([]);
    expect(m.tail).toEqual([]);
  });

  it("a claim is never shown when the view carries none, even with lines; F6 enroll and the second tap pass through", () => {
    const view = {
      kind: "roster" as const,
      claim: null,
      suppressed: ["held_key_unconfirmed"],
      lines: [
        { kind: "retired", device_id: "m1", text: "m1 retired" },
        { kind: "liveness", device_id: "m2", text: "m2 seen" },
      ],
      empty: null,
      notes: [{ text: "a note" }],
    };
    const m = machinesModel({
      phase: "ready",
      view: view as never,
      heldKey: { kind: "identity", basis: "rooted" },
      heldKeyText: null,
      rosterHidden: false,
      writeBlocked: null,
      lineActions: [
        { retire: false, enroll: true },
        { retire: false, enroll: false },
      ],
      busy: { deviceId: "m1", action: "enroll" },
      confirmForce: { deviceId: "m1", why: "no-such-line", text: "second tap?" },
      notice: { deviceId: "m1", text: "boom", tone: "error" },
      error: "offline",
    });
    expect(m.claim).toBeNull();
    expect(m.noCount).toMatch(/^No count: /);
    expect(m.lines.map((l) => [l.deviceId, l.retire, l.enroll])).toEqual([
      ["m1", false, true],
      ["m2", false, false],
    ]);
    expect(m.confirmForce).toEqual({ deviceId: "m1", text: "second tap?" });
    expect(m.notice).toEqual({ text: "boom", tone: "error" });
    expect(m.busy).toBe(true);
    expect(m.head).toContainEqual({ text: "The roster could not be read: offline", tone: "error" });
    expect(m.tail).toEqual([{ text: "a note", tone: "plain" }]);
  });

  it("loading and no-roster views say so, and nothing else", () => {
    const base = {
      heldKey: null,
      heldKeyText: null,
      rosterHidden: false,
      writeBlocked: null,
      lineActions: [],
      busy: null,
      confirmForce: null,
      notice: null,
      error: null,
    };
    expect(machinesModel({ ...base, phase: "loading", view: null }).head).toEqual([
      { text: "Reading the roster…", tone: "plain" },
    ]);
    const m = machinesModel({
      ...base,
      phase: "ready",
      view: { kind: "no-key", text: "no key here" } as never,
    });
    expect(m.head).toEqual([{ text: "no key here", tone: "plain" }]);
    expect(m.lines).toEqual([]);
  });
});

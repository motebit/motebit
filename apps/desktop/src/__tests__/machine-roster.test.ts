/**
 * The desktop's machine roster — `docs/proposals/machine-roster-surfaces-v1.md`
 * C-2c: the desktop-owned replica file (per-motebit, compare-and-swap,
 * corrupt bytes kept aside, crash-safe), the `exclusive` lease, the ports
 * (device:auth under the held key — never the master token; the config's
 * identity file as a record source only under the #799 rule; no guardian
 * pin; F5a key-store sources), the gated roster (enroll(own) through R17,
 * legacy hint-null unconfirmed, device-only hidden), the stored Retry-After,
 * and the rotation commit's link.
 *
 * `FakeDisk` is the Rust side (`src-tauri/src/roster_replica.rs`, whose own
 * `cargo test`s prove the real file lock, rename and aside): the same CAS
 * contract over a string, yielding between operations so two writers
 * interleave as two processes can.
 */
import { describe, it, expect, vi } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hostEnrollmentId,
  hostRetirementId,
  sha256,
  signGuardianRecoverySuccession,
  signHostEnrollment,
  signHostRetirement,
  signKeySuccession,
  verifySignedToken,
  type KeyPair,
} from "@motebit/encryption";
import { generate, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { emptyReplica, type MachineRosterReplica } from "@motebit/surface-kit";
import type { HostEnrollment, HostRetirement, KeySuccessionRecord } from "@motebit/sdk";
import {
  CONFLICT,
  LOCKED,
  loadPresentationRecord,
  loadReplica,
  parseRosterFile,
  putPresentationRecord,
  saveReplica,
  tauriRosterIO,
  withRosterLease,
  type InvokeFn,
  type RosterFileIO,
} from "../machine-roster-store";
import {
  DISPOSED,
  createDesktopMachineRoster,
  desktopRosterPorts,
  identityFileRecords,
  retryAfterMs,
  rosterAfterRotationCommit,
} from "../machine-roster";
import { rotateDesktopKey } from "../key-rotation";
import { IdentityManager } from "../identity-manager";
import { machinesModel } from "../machines-render-model";

const MID = "0190f1a2-0000-7000-8000-00000000abcd"; // legacy
const OTHER_MID = "0190f1a2-0000-7000-8000-00000000ef01";
const NOW = 1_800_000_000_000;
const MASTER = "MASTER-TOKEN-never-on-the-roster-routes";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const digestOf = async (s: string) => bytesToHex(await sha256(new TextEncoder().encode(s)));

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

/** The Rust commands' contract, in memory. */
class FakeDisk {
  bytes: string | null = null;
  binary = false;
  asides: string[] = [];
  conflicts = 0;
  lease: string | null = null;
  leases = 0;
  /** Runs inside a write after its digest was chosen: a second process can write here. */
  beforeWrite: (() => Promise<void>) | null = null;
  /** Throws from a write before anything changes (a crash before the rename). */
  crash = false;
  io(): RosterFileIO {
    return {
      read: async () => {
        await tick();
        if (this.bytes == null) return { kind: "absent" };
        const digest = await digestOf(this.bytes);
        return this.binary
          ? { kind: "unreadable", digest }
          : { kind: "text", digest, contents: this.bytes };
      },
      write: async (expected, contents, aside) => {
        await tick();
        const hook = this.beforeWrite;
        if (hook != null) {
          this.beforeWrite = null;
          await hook();
        }
        if (this.crash) throw new Error("staged, then the process died before the rename");
        const now = this.bytes == null ? null : await digestOf(this.bytes);
        if (now !== expected) {
          this.conflicts++;
          throw new Error(CONFLICT);
        }
        if (aside && this.bytes != null) this.asides.push(this.bytes);
        this.bytes = contents;
        this.binary = false;
      },
      leaseAcquire: async () => {
        await tick();
        if (this.lease != null) return null;
        this.lease = `t${++this.leases}`;
        return this.lease;
      },
      leaseRelease: async (token) => {
        if (this.lease !== token) return false;
        this.lease = null;
        return true;
      },
    };
  }
  file(): ReturnType<typeof parseRosterFile> {
    return this.bytes == null ? null : parseRosterFile(this.bytes);
  }
  replica(id = MID): MachineRosterReplica | null {
    return this.file()?.replicas[id] ?? null;
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
  auth: string[] = [];
  urls: string[] = [];
  posts = 0;
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.urls.push(url);
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

/** Tauri `invoke` over a key store, a config and the fake disk. */
function fakeInvoke(
  disk: FakeDisk,
  key: KeyPair | null,
  config: Record<string, unknown> = {},
): InvokeFn & { calls: Array<{ cmd: string; args?: Record<string, unknown> }> } {
  const keyring = new Map<string, string>([["sync_master_token", MASTER]]);
  if (key) keyring.set("device_private_key", bytesToHex(key.privateKey));
  const cfg: Record<string, unknown> = { sync_url: "https://relay.test/", ...config };
  const io = disk.io();
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const fn = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, ...(args ? { args } : {}) });
    switch (cmd) {
      case "keyring_get":
        return keyring.get(args!.key as string) ?? null;
      case "keyring_set":
        keyring.set(args!.key as string, args!.value as string);
        return undefined;
      case "keyring_delete":
      case "keyring_set_aside":
        keyring.delete(args!.key as string);
        return undefined;
      case "read_config":
        return JSON.stringify(cfg);
      case "update_config": {
        const patch = JSON.parse(args!.patch as string) as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete cfg[k];
          else cfg[k] = v;
        }
        return undefined;
      }
      case "roster_replica_read":
        return io.read();
      case "roster_replica_write":
        return io.write(
          args!.expected as string | null,
          args!.contents as string,
          args!.aside as boolean,
        );
      case "roster_lease_acquire":
        return io.leaseAcquire(args!.ttl as number);
      case "roster_lease_release":
        return io.leaseRelease(args!.token as string);
      default:
        return undefined;
    }
  }) as InvokeFn & { calls: Array<{ cmd: string; args?: Record<string, unknown> }> };
  fn.calls = calls;
  return fn;
}

function desktop(
  disk: FakeDisk,
  relay: FetchRelay,
  key: KeyPair | null,
  opts: {
    deviceId?: string;
    motebitId?: string;
    config?: Record<string, unknown>;
    listDeviceKeys?: () => Promise<string[]>;
  } = {},
) {
  const invoke = fakeInvoke(disk, key, opts.config);
  const roster = createDesktopMachineRoster({
    motebitId: opts.motebitId ?? MID,
    deviceId: opts.deviceId ?? "desk-device",
    invoke,
    fetchImpl: relay.fetch as typeof fetch,
    now: () => NOW,
    ...(opts.listDeviceKeys ? { listDeviceKeys: opts.listDeviceKeys } : {}),
  });
  return Object.assign(roster, { invoke });
}

// ── The replica file ─────────────────────────────────────────────────

describe("the desktop replica file — per motebit, compare-and-swap", () => {
  it("F4: each motebit has its own replica inside the file; saving one never touches another", async () => {
    const disk = new FakeDisk();
    const io = disk.io();
    const a = await generateKeypair();
    await saveReplica(io, { ...emptyReplica(MID), enrollments: [await enrol(a, "d1")] });
    const before = JSON.stringify(disk.replica(MID));
    await saveReplica(io, {
      ...emptyReplica(OTHER_MID),
      enrollments: [await enrol(a, "d2", OTHER_MID)],
    });
    expect(Object.keys(disk.file()!.replicas).sort()).toEqual([MID, OTHER_MID].sort());
    expect(JSON.stringify(disk.replica(MID))).toBe(before);
    const one = await loadReplica(io, MID);
    const two = await loadReplica(io, OTHER_MID);
    expect(one.kind === "value" && one.replica.enrollments.map((x) => x.device_id)).toEqual(["d1"]);
    expect(two.kind === "value" && two.replica.enrollments.map((x) => x.device_id)).toEqual(["d2"]);
    expect((await loadReplica(io, "0190f1a2-0000-7000-8000-000000000000")).kind).toBe("absent");
  });

  it("F3: a second process writing between this read and this write is re-read and merged, never overwritten", async () => {
    const disk = new FakeDisk();
    const a = await generateKeypair();
    const e = await enrol(a, "dev-host");
    const r = await retire(a, e);
    await saveReplica(disk.io(), { ...emptyReplica(MID), enrollments: [e] });
    // The other desktop process lands its retirement while this one is writing.
    // (Written directly: that process has its own in-memory writer chain.)
    disk.beforeWrite = async () => {
      const f = disk.file()!;
      f.replicas[MID] = { ...f.replicas[MID]!, retirements: [r] };
      disk.bytes = JSON.stringify(f);
    };
    const e2 = await enrol(a, "dev-2");
    await saveReplica(disk.io(), { ...emptyReplica(MID), enrollments: [e2] });
    expect(disk.conflicts).toBe(1);
    expect(disk.replica()?.retirements).toHaveLength(1);
    expect(
      disk
        .replica()
        ?.enrollments.map((x) => x.device_id)
        .sort(),
    ).toEqual(["dev-2", "dev-host"]);
  });

  it("F3: concurrent saves in this window never lose a retirement", async () => {
    const disk = new FakeDisk();
    const io = disk.io();
    const a = await generateKeypair();
    const e = await enrol(a, "dev-host");
    const r = await retire(a, e);
    await Promise.all([
      saveReplica(io, { ...emptyReplica(MID), retirements: [r] }),
      saveReplica(io, { ...emptyReplica(MID), enrollments: [e] }),
      saveReplica(io, {
        ...emptyReplica(OTHER_MID),
        enrollments: [await enrol(a, "x", OTHER_MID)],
      }),
    ]);
    expect(disk.replica()?.retirements).toHaveLength(1);
    expect(disk.replica()?.enrollments).toHaveLength(1);
    expect(disk.replica(OTHER_MID)?.enrollments).toHaveLength(1);
  });

  it("a crash between the staged write and the rename leaves the prior replica", async () => {
    const disk = new FakeDisk();
    const io = disk.io();
    const a = await generateKeypair();
    const e = await enrol(a, "dev-host");
    await saveReplica(io, { ...emptyReplica(MID), enrollments: [e] });
    const prior = disk.bytes;
    disk.crash = true;
    await expect(
      saveReplica(io, { ...emptyReplica(MID), retirements: [await retire(a, e)] }),
    ).rejects.toThrow(/died before the rename/);
    expect(disk.bytes).toBe(prior);
    disk.crash = false;
    const got = await loadReplica(io, MID);
    expect(got.kind === "value" && got.replica.enrollments).toHaveLength(1);
  });

  it("R3: an unreadable file is kept aside (bytes intact) and reads as corrupt once; a save over it keeps it too", async () => {
    const disk = new FakeDisk();
    const io = disk.io();
    disk.bytes = "{ not json";
    expect((await loadReplica(io, MID)).kind).toBe("corrupt");
    expect(disk.asides).toEqual(["{ not json"]);
    expect((await loadReplica(io, MID)).kind).toBe("absent");
    // A file whose one replica is malformed is unreadable as a whole (never read smaller).
    disk.bytes = JSON.stringify({ version: 1, replicas: { [MID]: { version: 1 } } });
    const bad = disk.bytes;
    await saveReplica(io, emptyReplica(OTHER_MID));
    expect(disk.asides).toContain(bad);
    expect(Object.keys(disk.file()!.replicas)).toEqual([OTHER_MID]);
    disk.bytes = "\u0000";
    disk.binary = true;
    expect((await loadReplica(io, MID)).kind).toBe("corrupt");
  });

  it("a replica stored under another motebit's key is corrupt, never merged", () => {
    const r = { ...emptyReplica(OTHER_MID) };
    expect(parseRosterFile(JSON.stringify({ version: 1, replicas: { [MID]: r } }))).toBeNull();
  });

  it("the presentation record round-trips per motebit; a malformed one reads as none", async () => {
    const disk = new FakeDisk();
    const io = disk.io();
    await putPresentationRecord(io, MID, { digest: "d", taken_at: 1, retry_until: 2 });
    expect(await loadPresentationRecord(io, MID)).toEqual({
      digest: "d",
      taken_at: 1,
      retry_until: 2,
    });
    expect(await loadPresentationRecord(io, OTHER_MID)).toBeNull();
    const f = JSON.parse(disk.bytes!) as { presentation: Record<string, unknown> };
    f.presentation[MID] = { digest: 3 };
    disk.bytes = JSON.stringify(f);
    expect(await loadPresentationRecord(io, MID)).toBeNull();
  });

  it("R4: the lease excludes, waits, times out as an error, and is released however fn ends", async () => {
    const disk = new FakeDisk();
    const io = disk.io();
    const sleep = async () => tick();
    let inside = 0;
    let max = 0;
    const section = async () => {
      inside++;
      max = Math.max(max, inside);
      await tick();
      await tick();
      inside--;
    };
    await Promise.all([
      withRosterLease(io, section, { sleep }),
      withRosterLease(io, section, { sleep }),
    ]);
    expect(max).toBe(1);
    await expect(
      withRosterLease(
        io,
        async () => {
          throw new Error("boom");
        },
        { sleep },
      ),
    ).rejects.toThrow("boom");
    expect(disk.lease).toBeNull();
    disk.lease = "held-by-another-window";
    await expect(withRosterLease(io, section, { sleep, waitMs: 100 })).rejects.toThrow(LOCKED);
  });

  it("the Tauri IO names the four commands with their argument names", async () => {
    const seen: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      seen.push([cmd, args]);
      return null;
    }) as InvokeFn;
    const io = tauriRosterIO(invoke);
    await io.read();
    await io.write(null, "x", true);
    await io.leaseAcquire(5);
    await io.leaseRelease("t");
    expect(seen).toEqual([
      ["roster_replica_read", undefined],
      ["roster_replica_write", { expected: null, contents: "x", aside: true }],
      ["roster_lease_acquire", { ttl: 5 }],
      ["roster_lease_release", { token: "t" }],
    ]);
  });
});

// ── The ports ────────────────────────────────────────────────────────

describe("desktop ports", () => {
  it("the roster routes carry a device:auth token under the HELD key — never the master token", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const d = desktop(disk, relay, a);
    await d.section.refresh();
    await d.section.retire("dev-host");
    expect(relay.ret.size).toBe(1);
    expect(relay.auth.length).toBeGreaterThanOrEqual(3); // GET, POST (refresh), GET/POST (act)
    for (const header of relay.auth) {
      expect(header).not.toContain(MASTER);
      const payload = await verifySignedToken(header.replace(/^Bearer /, ""), a.publicKey);
      expect(payload).toMatchObject({ mid: MID, did: "desk-device", aud: "device:auth" });
    }
    // The master token's slot is never even read.
    expect(
      d.invoke.calls.some((c) => c.cmd === "keyring_get" && c.args?.key === "sync_master_token"),
    ).toBe(false);
  });

  it("no key → no signer; no relay → failed reads; a non-chain body is a failed read; a 429 carries Retry-After", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const none = desktopRosterPorts({
      motebitId: MID,
      deviceId: "desk-device",
      invoke: fakeInvoke(disk, null, { sync_url: null }),
    });
    expect(await none.signer()).toBeNull();
    expect(await none.fetchSuccession()).toEqual({ ok: false, reason: "no relay is configured" });
    const odd = desktopRosterPorts({
      motebitId: MID,
      deviceId: "desk-device",
      invoke: fakeInvoke(disk, null),
      fetchImpl: (async () => Response.json({ chain: "nope" })) as typeof fetch,
    });
    expect(await odd.fetchSuccession()).toEqual({
      ok: false,
      reason: "the succession route's answer was not a key chain",
    });
    const relay = new FetchRelay();
    relay.retryAfter = "12";
    const ports = desktopRosterPorts({
      motebitId: MID,
      deviceId: "desk-device",
      invoke: fakeInvoke(disk, a),
      fetchImpl: relay.fetch as typeof fetch,
      now: () => NOW,
    });
    const res = await ports.presentRoster((await ports.signer())!, {
      enrollments: [],
      retirements: [],
    });
    expect(res).toMatchObject({ status: 429, retryAfterMs: 12_000 });
    expect(retryAfterMs(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000);
    expect(retryAfterMs("soon", NOW)).toBeUndefined();
    expect(retryAfterMs(null, NOW)).toBeUndefined();
  });

  it("F5a: storedPublicKeyHex and rotationInFlight come from the desktop's own key store, never config", async () => {
    const a = await generateKeypair();
    const other = await generateKeypair();
    const disk = new FakeDisk();
    const invoke = fakeInvoke(disk, a, {
      device_public_key: hex(other),
      cli_pending_rotation: "{}",
    });
    const ports = desktopRosterPorts({ motebitId: MID, deviceId: "desk-device", invoke });
    expect(await ports.storedPublicKeyHex!()).toBe(hex(a));
    expect(await ports.rotationInFlight!()).toBe(false);
    await invoke("keyring_set", { key: "pending_rotation", value: "{}" });
    expect(await ports.rotationInFlight!()).toBe(true);
  });

  it("the config's motebit.md is a record source only when it verifies, names THIS motebit, and its key is the held key", async () => {
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
    expect(await identityFileRecords(MID, rotated, hex(b))).toHaveLength(1);
    // #799 — a file whose current key is not the held key contributes nothing.
    expect(await identityFileRecords(MID, rotated, hex(a))).toEqual([]);
    expect(await identityFileRecords(MID, rotated, null)).toEqual([]);
    expect(await identityFileRecords(OTHER_MID, rotated, hex(b))).toEqual([]);
    expect(await identityFileRecords(MID, rotated.replace(hex(g), hex(a)), hex(b))).toEqual([]);
    expect(await identityFileRecords(MID, null, hex(b))).toEqual([]);
    // Through the port: the held key and the config's `_identity_file`.
    const ports = desktopRosterPorts({
      motebitId: MID,
      deviceId: "desk-device",
      invoke: fakeInvoke(new FakeDisk(), b, { _identity_file: rotated }),
    });
    expect(await ports.localSuccession()).toHaveLength(1);
    // #799 W1: never a guardian pin, whatever the file names.
    expect(await ports.pinnedGuardian()).toBeNull();
  });
});

// ── The gated roster on the desktop ──────────────────────────────────

describe("createDesktopMachineRoster", () => {
  it("F5b: enroll(own id) goes through the kit's R17 path — a second tap, and no own mint recorded", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(a);
    const d = desktop(disk, relay, a);
    await d.section.refresh();
    await d.section.enroll("desk-device");
    expect(d.section.getState().notice?.text).not.toBe("This device is not a host.");
    expect(d.section.getState().confirmForce?.deviceId).toBe("desk-device");
    expect(relay.enr.size).toBe(0);
    await d.section.enroll("desk-device", { force: true });
    expect([...relay.enr.values()].map((e) => e.device_id)).toEqual(["desk-device"]);
    expect(disk.replica()?.own_minted).toEqual([]);
    expect(disk.replica()?.own_device_ids).toEqual([]);
  });

  it("an identity key the relay names (legacy route 2) retires end to end, held in the file and at the relay", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const d = desktop(disk, relay, a);
    await d.section.refresh();
    expect(d.section.getState().heldKey).toEqual({ kind: "identity", basis: "relay" });
    expect(d.section.getState().lineActions).toEqual([{ retire: true, enroll: false }]);
    await d.section.retire("dev-host");
    expect(d.section.getState().notice?.tone).toBe("done");
    expect(relay.ret.size).toBe(1);
    expect(disk.replica()?.retirements).toHaveLength(1);
    expect(disk.lease).toBeNull();
  });

  it("#797: a legacy identity whose relay names no key — lines, no count, no actions, acts refused", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.enr.set("x", await enrol(a, "dev-host"));
    const d = desktop(disk, relay, a);
    await d.section.refresh();
    const s = d.section.getState();
    expect(s.heldKey).toEqual({ kind: "unconfirmed", why: "legacy-unproven" });
    expect(s.view?.kind === "roster" && s.view.claim).toBeNull();
    expect(s.view?.kind === "roster" && s.view.lines).toHaveLength(1);
    expect(s.lineActions.every((x) => !x.retire && !x.enroll)).toBe(true);
    await d.section.retire("dev-host");
    expect(relay.ret.size).toBe(0);
    expect(relay.posts).toBe(0);
  });

  it("a device-only key (the relay names another key current) hides the roster and signs nothing", async () => {
    const k = await generateKeypair();
    const dk = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(k);
    relay.enr.set("1", await enrol(k, "host-1"));
    relay.rows = [{ device_id: "host-3", bound_under: hex(k), last_seen_at: NOW, sockets_open: 1 }];
    const d = desktop(disk, relay, dk);
    await d.section.refresh();
    expect(d.section.getState().heldKey?.kind).toBe("device-key");
    expect(d.section.getState().rosterHidden).toBe(true);
    await d.section.enroll("host-3", { force: true });
    expect(relay.enr.size).toBe(1);
    expect(relay.posts).toBe(0);
  });

  for (const fileKey of ["held", "foreign"] as const) {
    it(`#799 probe (${fileKey} file key): a motebit.md naming a guardian, with a guardian-signed recovery onto the device-only key, never makes it the identity key`, async () => {
      const g = await generateKeypair(); // the sovereign genesis key
      const dk = await generateKeypair(); // the desktop's device-only key
      const a = await generateKeypair(); // the planted file's signer
      const gg = await generateKeypair(); // the guardian the planted file names
      const y = await deriveSovereignMotebitId(hex(g));
      const recovery = await signGuardianRecoverySuccession(
        gg.privateKey,
        dk.privateKey,
        g.publicKey,
        dk.publicKey,
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
      const to = fileKey === "held" ? dk : await generateKeypair();
      const file = await rotateIdentityFile({
        existingContent: planted,
        newPublicKey: to.publicKey,
        newPrivateKey: to.privateKey,
        successionRecord: recovery,
      });
      const disk = new FakeDisk();
      const relay = new FetchRelay();
      relay.enr.set("1", await enrol(g, "host-1", y));
      relay.enr.set("2", await enrol(g, "host-2", y));
      const d = desktop(disk, relay, dk, { motebitId: y, config: { _identity_file: file } });
      await d.section.refresh();
      const s = d.section.getState();
      expect(s.heldKey?.kind).not.toBe("identity");
      expect(s.view?.kind === "roster" ? s.view.claim : null).toBeNull();
      expect(s.lineActions.some((x) => x.retire || x.enroll)).toBe(false);
      await d.section.retire("host-1");
      expect(relay.ret.size).toBe(0);
      expect(relay.posts).toBe(0);
    });
  }

  it("route 1: a rotated sovereign identity roots through the config's motebit.md link while the relay serves no chain", async () => {
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
    const relay = new FetchRelay();
    const d = desktop(new FakeDisk(), relay, b, {
      motebitId: mid,
      config: { _identity_file: rotated },
    });
    await d.section.refresh();
    expect(d.section.getState().heldKey).toEqual({ kind: "identity", basis: "rooted" });
  });

  it("C6.3: knownDeviceKeys from the local devices list relabels a linked device's row", async () => {
    const a = await generateKeypair();
    const linked = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.rows = [
      { device_id: "phone-1", bound_under: hex(linked), last_seen_at: NOW, sockets_open: 1 },
    ];
    const listed = vi.fn(async () => [hex(linked), hex(a)]);
    const d = desktop(new FakeDisk(), relay, a, { listDeviceKeys: listed });
    await d.section.refresh();
    expect(listed).toHaveBeenCalled();
    const s = d.section.getState();
    expect(s.view?.kind === "roster" && s.view.lines.map((l) => l.kind)).toContain("linked-device");
  });

  it("F8: presents on refresh when due, not again while unchanged, and a 429 defers the next", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const d = desktop(disk, relay, a);
    await d.section.refresh();
    expect(relay.posts).toBe(1);
    expect((await loadPresentationRecord(disk.io(), MID))?.digest).toEqual(expect.any(String));
    await d.section.refresh();
    expect(relay.posts).toBe(1);
    relay.retryAfter = "60";
    await d.section.retire("dev-host");
    expect((await loadPresentationRecord(disk.io(), MID))?.retry_until).toBe(NOW + 60_000);
    const before = relay.posts;
    await d.section.refresh();
    expect(relay.posts).toBe(before);
  });

  it("F8 + #799 round 2: a Retry-After stored by an earlier process holds a fresh one — no omission repair, no post", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(a);
    // The replica holds an enrolment the relay has lost: acquire() would
    // repair the omission by presenting, BEFORE presentation.due is asked.
    const e = await enrol(a, "dev-host");
    await saveReplica(disk.io(), { ...emptyReplica(MID), enrollments: [e] });
    await putPresentationRecord(disk.io(), MID, {
      digest: null,
      taken_at: 0,
      retry_until: NOW + 60_000,
    });
    const fresh = desktop(disk, relay, a); // a new process: nothing in memory
    await fresh.section.refresh();
    expect(relay.posts).toBe(0);
    // An act meanwhile: the unrepaired omission refuses it (the kit's
    // rule), and still nothing is sent.
    await fresh.section.retire("dev-host");
    expect(relay.posts).toBe(0);
    expect(fresh.section.getState().notice?.text).toMatch(/relay is missing 1 entry/);
  });

  it("an unreadable presentation store holds every presentation until it reads", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(a);
    // An omission to repair: the replica holds what the relay lost.
    await saveReplica(disk.io(), { ...emptyReplica(MID), enrollments: [await enrol(a, "h")] });
    const base = disk.io();
    let failNext = 1; // the seed's read fails once; the acquisition's reads succeed
    const io: RosterFileIO = {
      ...base,
      read: async () => {
        if (failNext-- > 0) throw new Error("EIO");
        return base.read();
      },
    };
    const d = createDesktopMachineRoster({
      motebitId: MID,
      deviceId: "desk-device",
      invoke: fakeInvoke(disk, a),
      io,
      fetchImpl: relay.fetch as typeof fetch,
      now: () => NOW,
    });
    await d.section.refresh();
    expect(relay.posts).toBe(0);
    await d.section.refresh(); // the store reads now: the repair goes out
    expect(relay.posts).toBeGreaterThan(0);
  });

  it("a disposed roster reads no key, presents nothing and refuses acts", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const d = desktop(disk, relay, a);
    d.dispose();
    await d.section.refresh();
    expect(relay.posts).toBe(0);
    expect(d.section.getState().writeBlocked).toBe(DISPOSED);
    expect(
      d.invoke.calls.some((c) => c.cmd === "keyring_get" && c.args?.key === "device_private_key"),
    ).toBe(false);
    await d.section.retire("dev-host");
    expect(d.section.getState().notice?.text).toBe(DISPOSED);
    expect(relay.ret.size).toBe(0);
  });
});

// ── F7 — the rotation commit appends its link ────────────────────────

describe("the rotation commit's roster step", () => {
  it("rotateDesktopKey hands onCommitted the record after the key is stored; the link lands in the replica", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const invoke = fakeInvoke(disk, a, { device_public_key: hex(a), sync_url: null });
    const seen: Array<{ slot: string | null; record: KeySuccessionRecord }> = [];
    const out = await rotateDesktopKey({
      invoke,
      motebitId: MID,
      deviceId: "desk-device",
      onCommitted: async (_pub, record) => {
        seen.push({
          slot: await invoke<string | null>("keyring_get", { key: "device_private_key" }),
          record,
        });
        await rosterAfterRotationCommit({ motebitId: MID, record, io: disk.io() });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slot).not.toBe(bytesToHex(a.privateKey)); // the new key was stored first
    expect(seen[0]!.record.old_public_key).toBe(hex(a));
    expect(seen[0]!.record.new_public_key).toBe(out.newPublicKeyHex);
    expect(disk.replica()?.succession).toEqual([seen[0]!.record]);
  });

  it("IdentityManager.rotateKey appends the committed link to the desktop's replica file", async () => {
    const a = await generateKeypair();
    const disk = new FakeDisk();
    const invoke = fakeInvoke(disk, a, { device_public_key: hex(a), sync_url: null });
    const im = new IdentityManager();
    im.motebitId = MID;
    im.deviceId = "desk-device";
    im.publicKey = hex(a);
    const out = await im.rotateKey(invoke);
    const links = disk.replica()?.succession ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]!.old_public_key).toBe(hex(a));
    expect(links[0]!.new_public_key.slice(0, 16)).toBe(out.newKeyFingerprint);
  });

  it("the append is idempotent and a failure never throws", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const disk = new FakeDisk();
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    await rosterAfterRotationCommit({ motebitId: MID, record, io: disk.io() });
    await rosterAfterRotationCommit({ motebitId: MID, record, io: disk.io() });
    expect(disk.replica()?.succession).toEqual([record]);
    disk.crash = true;
    await expect(
      rosterAfterRotationCommit({ motebitId: MID, record, io: disk.io() }),
    ).resolves.toBeUndefined();
  });
});

// ── The render model (what ui/machines-section.ts lays out) ──────────

describe("machinesModel — Settings → Identity → Machines", () => {
  it("identity key: the count, each line with its actions", async () => {
    const a = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(a);
    relay.enr.set("x", await enrol(a, "dev-host"));
    const d = desktop(new FakeDisk(), relay, a);
    await d.section.refresh();
    const m = machinesModel(d.section.getState());
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
    const d = desktop(new FakeDisk(), relay, a);
    await d.section.refresh();
    const m = machinesModel(d.section.getState());
    expect(m.claim).toBeNull();
    expect(m.noCount).toMatch(/^No count: /);
    expect(m.head.map((n) => n.text).join(" ")).toMatch(/counts need the CLI/);
    expect(m.lines.some((l) => l.retire || l.enroll)).toBe(false);
  });

  it("device-only key: only the reason — no count, no lines", async () => {
    const k = await generateKeypair();
    const dk = await generateKeypair();
    const relay = new FetchRelay();
    relay.current = hex(k);
    relay.enr.set("1", await enrol(k, "host-1"));
    const d = desktop(new FakeDisk(), relay, dk);
    await d.section.refresh();
    const s = d.section.getState();
    const m = machinesModel(s);
    expect(m.head.map((n) => n.text)).toEqual([s.heldKeyText]);
    expect(m.claim).toBeNull();
    expect(m.lines).toEqual([]);
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
      error: "offline",
    });
    expect(m.head).toEqual([
      { text: "The roster could not be read: offline", tone: "error" },
      { text: "no key here", tone: "plain" },
    ]);
  });
});

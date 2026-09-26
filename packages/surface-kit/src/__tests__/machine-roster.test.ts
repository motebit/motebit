/**
 * The machine-roster controller at its port seam —
 * `docs/proposals/machine-roster-clients-v1.md` C1 (consumer half), C3–C6,
 * §2A. The relay is an in-memory fake with the part-B semantics that matter
 * here (idempotent union, 422 per-entry refusal, roster_full, 413, liveness
 * rows); the key chain and the law are the real primitives.
 */
import { describe, it, expect } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hostEnrollmentId,
  hostRetirementId,
  signGuardianRecoverySuccession,
  signHostEnrollment,
  signHostRetirement,
  signKeySuccession,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { HostEnrollment, HostRetirement, KeySuccessionRecord } from "@motebit/sdk";

import {
  MachineRoster,
  createRosterSigner,
  parseServedRoster,
  type LiveUnenrolled,
  type LivenessRow,
  type MachineRosterPorts,
  type RosterAcquired,
  type RosterSigner,
} from "../machine-roster.js";
import {
  emptyReplica,
  mergeReplicas,
  parseReplica,
  type MachineRosterReplica,
} from "../machine-roster-replica.js";
import { buildRosterView, keyFingerprint, suppressionText } from "../machine-roster-view.js";

const MID = "0190f1a2-0000-7000-8000-000000000001"; // a legacy (v7) id: unrooted
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

class FakeRelay {
  enr = new Map<string, HostEnrollment>();
  ret = new Map<string, HostRetirement>();
  rows: LivenessRow[] = [];
  live: LiveUnenrolled[] = [];
  chain: KeySuccessionRecord[] = [];
  current: string | null = null;
  getFails = false;
  successionFails = false;
  /** Ids the relay never serves, however often they are presented. */
  omit = new Set<string>();
  /** Ids refused `roster_full`. */
  full = new Set<string>();
  /** Ids refused with another reason. */
  refuse = new Map<string, string>();
  status413 = false;
  presentDown = false;
  posts: Array<{ enrollments: HostEnrollment[]; retirements: HostRetirement[] }> = [];
  auth: Array<Record<string, string>> = [];
  gets = 0;

  async roster(s: RosterSigner) {
    this.auth.push(await s.authorization());
    this.gets++;
    if (this.getFails) return { ok: false as const, reason: "relay down" };
    return {
      ok: true as const,
      body: {
        motebit_id: MID,
        enrollments: [...this.enr].filter(([id]) => !this.omit.has(id)).map(([, v]) => v),
        retirements: [...this.ret].filter(([id]) => !this.omit.has(id)).map(([, v]) => v),
        liveness: {
          observed_by: "relay-mid",
          retention_days: 90,
          observing_since: NOW - 90 * DAY,
          rows: this.rows,
          live_unenrolled: this.live,
        },
      },
    };
  }

  async present(
    s: RosterSigner,
    body: { enrollments: HostEnrollment[]; retirements: HostRetirement[] },
  ) {
    this.auth.push(await s.authorization());
    this.posts.push(body);
    if (this.presentDown) return { status: null, reason: "network" } as const;
    if (this.status413) return { status: 413, body: {} };
    const refused: Array<{ kind: string; index: number; reason: string }> = [];
    for (const [index, e] of body.enrollments.entries()) {
      const id = await hostEnrollmentId(e);
      if (this.full.has(id)) refused.push({ kind: "enrollment", index, reason: "roster_full" });
      else if (this.refuse.has(id))
        refused.push({ kind: "enrollment", index, reason: this.refuse.get(id)! });
      else this.enr.set(id, e);
    }
    for (const [index, r] of body.retirements.entries()) {
      const id = await hostRetirementId(r);
      if (this.full.has(id)) refused.push({ kind: "retirement", index, reason: "roster_full" });
      else this.ret.set(id, r);
    }
    return refused.length > 0
      ? { status: 422, body: { refused } }
      : { status: 200, body: { accepted: [] } };
  }

  /** Store directly (another surface presented it). */
  async hold(...items: Array<HostEnrollment | HostRetirement>) {
    for (const i of items) {
      if ("device_id" in i) this.enr.set(await hostEnrollmentId(i), i);
      else this.ret.set(await hostRetirementId(i), i);
    }
  }
}

class FakeCache {
  value: MachineRosterReplica | null = null;
  corrupt = false;
  saves = 0;
  async load() {
    if (this.corrupt) {
      this.corrupt = false; // the adapter kept it aside; the name is free
      return { kind: "corrupt" as const };
    }
    return this.value
      ? { kind: "value" as const, replica: this.value }
      : { kind: "absent" as const };
  }
  async save(r: MachineRosterReplica) {
    this.saves++;
    this.value = this.value ? mergeReplicas(this.value, r) : r;
  }
  /** Set false to take the lock away (the tamper the concurrency test must catch). */
  locking = true;
  private queue: Promise<unknown> = Promise.resolve();
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.locking) return fn();
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

const signerOf = (kp: KeyPair) =>
  createRosterSigner({
    privateKey: kp.privateKey,
    authorization: async () => ({ Authorization: `Bearer device-token-${hex(kp).slice(0, 8)}` }),
  });

interface Machine {
  roster: MachineRoster;
  ports: MachineRosterPorts;
  cache: FakeCache;
  setKey(kp: KeyPair | null): void;
}

function machine(
  relay: FakeRelay,
  key: KeyPair | null,
  opts: {
    deviceId?: string;
    motebitId?: string;
    local?: unknown[];
    guardian?: string | null;
    cache?: FakeCache;
    rotationInFlight?: boolean;
    stored?: string | null;
    knownDeviceKeys?: string[];
    /** Awaited before every enrolment signature (a race harness). */
    beforeSign?: () => Promise<void>;
    /** This process's clock (two processes never mint in the same millisecond here). */
    now?: number;
  } = {},
): Machine {
  let current = key;
  const cache = opts.cache ?? new FakeCache();
  const ports: MachineRosterPorts = {
    motebitId: opts.motebitId ?? MID,
    deviceId: opts.deviceId ?? "dev-self",
    signer: async () => {
      if (!current) return null;
      const s = await signerOf(current);
      const before = opts.beforeSign;
      if (!before) return s;
      return {
        ...s,
        signEnrollment: async (body) => {
          await before();
          return s.signEnrollment(body);
        },
      };
    },
    fetchSuccession: async () =>
      relay.successionFails
        ? { ok: false, reason: "down" }
        : {
            ok: true,
            body: {
              motebit_id: MID,
              chain: relay.chain,
              current_public_key: relay.current,
              held_public_key: relay.current,
            },
          },
    fetchRoster: (s) => relay.roster(s),
    presentRoster: (s, b) => relay.present(s, b),
    localSuccession: async () => opts.local ?? [],
    pinnedGuardian: async () => opts.guardian ?? null,
    cache,
    now: () => opts.now ?? NOW,
    ...(opts.rotationInFlight !== undefined
      ? { rotationInFlight: async () => opts.rotationInFlight! }
      : {}),
    ...(opts.stored !== undefined ? { storedPublicKeyHex: async () => opts.stored! } : {}),
    ...(opts.knownDeviceKeys ? { knownDeviceKeys: async () => opts.knownDeviceKeys! } : {}),
  };
  return {
    roster: new MachineRoster(ports),
    ports,
    cache,
    setKey: (kp) => {
      current = kp;
    },
  };
}

/**
 * A barrier for two racing processes: each waits until both have arrived,
 * or `ms` pass. Unserialized minters both arrive and both sign; serialized
 * ones never both arrive, so the first proceeds after the timeout.
 */
function raceGate(n = 2, ms = 60): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((r) => (open = r));
  return async () => {
    if (++arrived >= n) open();
    await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
  };
}

const enrol = (kp: KeyPair, deviceId: string, at = NOW, motebitId = MID) =>
  signHostEnrollment(
    { motebit_id: motebitId, device_id: deviceId, public_key: hex(kp), enrolled_at: at },
    kp.privateKey,
  );
const retireEntry = async (kp: KeyPair, e: HostEnrollment) =>
  signHostRetirement(
    {
      motebit_id: MID,
      enrollment_id: await hostEnrollmentId(e),
      public_key: hex(kp),
      retired_at: NOW,
    },
    kp.privateKey,
  );
const rotate = (from: KeyPair, to: KeyPair) =>
  signKeySuccession(from.privateKey, to.privateKey, to.publicKey, from.publicKey);

async function acquired(m: Machine): Promise<RosterAcquired> {
  const a = await m.roster.acquire();
  if (a.kind !== "acquired") throw new Error(`expected acquired, got ${a.kind}`);
  return a;
}

async function withFrozen(
  cache: FakeCache,
  deviceId: string,
  key: string,
  value: "active" | "not-active" | "absent",
) {
  await cache.save({
    ...emptyReplica(MID),
    frozen: [{ device_id: deviceId, pre_rotation_key: key, value, taken_at: NOW }],
  });
}

// ── C3: the status table ────────────────────────────────────────────

describe("C3 — minting on announce, decided by status", () => {
  it("no line → mints the first enrolment, caches it, presents it; the next start re-presents and mints nothing", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    const first = await m.roster.ensureEnrolled();
    expect(first.kind).toBe("minted");
    if (first.kind === "minted") expect(first.firstLine).toBe(true);
    expect(relay.enr.size).toBe(1);
    expect(m.cache.value!.enrollments).toHaveLength(1);
    expect(m.cache.value!.own_device_ids).toEqual(["dev-self"]);

    const second = await m.roster.ensureEnrolled();
    expect(second.kind).toBe("active");
    expect(relay.enr.size).toBe(1);
    expect(m.cache.value!.enrollments).toHaveLength(1);
  });

  it("active at the head → re-presents the stored bytes, mints nothing (even after the relay lost them)", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    relay.enr.clear(); // relay DB loss
    const again = await m.roster.ensureEnrolled();
    expect(again.kind).toBe("active");
    expect(relay.enr.size).toBe(1);
    expect(m.cache.value!.enrollments).toHaveLength(1);
  });

  it("retired at the head → mints nothing, and says retired (never auto-rejoins)", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    // The phone retires this machine, under the same (current) key.
    const e = m.cache.value!.enrollments[0]!;
    await relay.hold(await retireEntry(a, e));
    const out = await m.roster.ensureEnrolled();
    expect(out.kind).toBe("retired");
    expect(relay.enr.size).toBe(1);
    const view = buildRosterView(await m.roster.acquire(), NOW);
    expect(view.kind === "roster" && view.lines.find((l) => l.kind === "retired")?.text).toMatch(
      /retired under the current key/,
    );
  });

  it("retired at an OLD epoch, device now on the new key → still retired: mints nothing", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const e = await enrol(a, "dev-self");
    await relay.hold(e, await retireEntry(a, e));
    relay.chain = [await rotate(a, b)];
    relay.current = hex(b);
    const m = machine(relay, b);
    await withFrozen(m.cache, "dev-self", hex(a), "active");
    const out = await m.roster.ensureEnrolled();
    expect(out.kind).toBe("retired");
    expect(relay.enr.size).toBe(1);
  });

  it("superseded + frozen ACTIVE keyed by its H → mints under the head key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "dev-self"));
    relay.chain = [await rotate(a, b)];
    relay.current = hex(b);
    const m = machine(relay, b);
    await withFrozen(m.cache, "dev-self", hex(a), "active");
    const out = await m.roster.ensureEnrolled();
    expect(out.kind).toBe("minted");
    if (out.kind === "minted") expect(out.firstLine).toBe(false);
    expect([...relay.enr.values()].map((e) => e.public_key).sort()).toEqual(
      [hex(a), hex(b)].sort(),
    );
  });

  it.each(["not-active", "absent"] as const)(
    "superseded + frozen %s → mints nothing; not covered until `enroll`",
    async (value) => {
      const a = await generateKeypair();
      const b = await generateKeypair();
      const relay = new FakeRelay();
      await relay.hold(await enrol(a, "dev-self"));
      relay.chain = [await rotate(a, b)];
      const m = machine(relay, b);
      await withFrozen(m.cache, "dev-self", hex(a), value);
      const out = await m.roster.ensureEnrolled();
      expect(out).toMatchObject({ kind: "superseded", frozen: value });
      expect(relay.enr.size).toBe(1);
    },
  );

  it("superseded with NO frozen value → mints nothing", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "dev-self"));
    relay.chain = [await rotate(a, b)];
    const m = machine(relay, b);
    const out = await m.roster.ensureEnrolled();
    expect(out).toMatchObject({ kind: "superseded", frozen: null });
    expect(relay.enr.size).toBe(1);
  });

  it("R22 — a frozen value left over from an EARLIER transition is never read", async () => {
    // A→B: frozen active keyed A, minted under B. B→C elsewhere; this machine
    // (H = B) has no frozen value keyed B. The stale A value must not mint.
    const a = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "dev-self"), await enrol(b, "dev-self"));
    relay.chain = [await rotate(a, b), await rotate(b, c)];
    const m = machine(relay, c);
    await withFrozen(m.cache, "dev-self", hex(a), "active");
    const out = await m.roster.ensureEnrolled();
    expect(out).toMatchObject({ kind: "superseded", frozen: null });
    expect(relay.enr.size).toBe(2);
  });

  it("GET failed + no line → mints nothing (unknown: fetch-failed)", async () => {
    const relay = new FakeRelay();
    relay.getFails = true;
    const m = machine(relay, await generateKeypair());
    const out = await m.roster.ensureEnrolled();
    expect(out).toMatchObject({ kind: "unknown", why: "fetch-failed", status: "none" });
    expect(relay.posts).toHaveLength(0);
    expect(m.cache.value?.enrollments ?? []).toHaveLength(0);
  });

  it("GET failed + superseded with frozen active → mints nothing", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, b, { local: [await rotate(a, b)] });
    await m.cache.save({ ...emptyReplica(MID), enrollments: [await enrol(a, "dev-self")] });
    await withFrozen(m.cache, "dev-self", hex(a), "active");
    relay.getFails = true;
    const out = await m.roster.ensureEnrolled();
    expect(out).toMatchObject({ kind: "unknown", why: "fetch-failed", status: "superseded" });
  });

  it("a corrupt cache read → mints nothing this run", async () => {
    const relay = new FakeRelay();
    const cache = new FakeCache();
    cache.corrupt = true;
    const m = machine(relay, await generateKeypair(), { cache });
    const out = await m.roster.ensureEnrolled();
    expect(out).toMatchObject({ kind: "unknown", why: "cache-corrupt" });
    expect(relay.enr.size).toBe(0);
  });

  it("R27 — a relay that keeps omitting what this replica presents: the GET counts as failed, nothing minted", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    // Another device of this motebit, enrolled and cached here.
    const other = await enrol(a, "dev-other");
    await m.cache.save({ ...emptyReplica(MID), enrollments: [other] });
    relay.omit.add(await hostEnrollmentId(other));
    const out = await m.roster.ensureEnrolled();
    expect(out).toMatchObject({ kind: "unknown", why: "omission" });
    const acq = await acquired(m);
    expect(acq.suppressed).toContain("relay_omission");
    const view = buildRosterView(acq, NOW);
    expect(view.kind === "roster" && view.claim).toBeNull();
  });

  it("no key on this surface → no-key, nothing read or sent", async () => {
    const relay = new FakeRelay();
    const m = machine(relay, null);
    expect(await m.roster.ensureEnrolled()).toEqual({ kind: "no-key" });
    expect(relay.gets).toBe(0);
    expect(buildRosterView({ kind: "no-key" }, NOW).kind).toBe("no-key");
  });
});

// ── C1 refusals and R23 remedies ─────────────────────────────────────

describe("C1 refusals — R23 remedies, R26 evidence kept", () => {
  async function superseded(opts: Parameters<typeof machine>[2] = {}) {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b)];
    relay.current = hex(b);
    const m = machine(relay, a, opts);
    return { a, b, relay, m };
  }

  it("held_key_superseded: refused, no roster, nothing minted; remedy restore by default", async () => {
    const { m, relay } = await superseded();
    const out = await m.roster.ensureEnrolled();
    expect(out).toMatchObject({
      kind: "refused",
      reason: "held_key_superseded",
      remedy: "restore",
    });
    expect(relay.posts).toHaveLength(0);
    const view = buildRosterView(await m.roster.acquire(), NOW);
    expect(view.kind).toBe("no-roster");
  });

  it("R23.1 — a rotation write-ahead present → finish the rotation", async () => {
    const { m } = await superseded({ rotationInFlight: true });
    expect(await m.roster.ensureEnrolled()).toMatchObject({ remedy: "finish-rotation" });
  });

  it("R23.2 — the stored config key is held's verified successor → restart", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b)];
    const m = machine(relay, a, { stored: hex(b), rotationInFlight: false });
    expect(await m.roster.ensureEnrolled()).toMatchObject({ remedy: "restart" });
  });

  it("R23.2 — a stored key that does NOT descend from held → restore", async () => {
    const { m } = await superseded({ stored: hex(await generateKeypair()) });
    expect(await m.roster.ensureEnrolled()).toMatchObject({ remedy: "restore" });
  });

  it("R26 — the refusal's evidence survives a relay that loses it", async () => {
    const { m, relay } = await superseded();
    await m.roster.ensureEnrolled();
    expect(m.cache.value!.succession).toHaveLength(1);
    relay.chain = []; // relay switch / DB loss
    relay.current = null;
    expect(await m.roster.ensureEnrolled()).toMatchObject({ reason: "held_key_superseded" });
  });

  it("duplicate_key (a rotation back to the held key) → refused, remedy rotate", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b), await rotate(b, c), await rotate(c, b)];
    const m = machine(relay, b);
    expect(await m.roster.ensureEnrolled()).toMatchObject({
      kind: "refused",
      reason: "duplicate_key",
      remedy: "rotate",
    });
  });

  it("a malformed call (a non-hex guardian pin is ignored, not a refusal)", async () => {
    const relay = new FakeRelay();
    const m = machine(relay, await generateKeypair(), { guardian: "NOT-HEX" });
    expect((await m.roster.ensureEnrolled()).kind).toBe("minted");
  });

  it("malformed id → refused malformed_input, remedy report", async () => {
    const relay = new FakeRelay();
    const m = machine(relay, await generateKeypair(), { motebitId: "" });
    expect(await m.roster.ensureEnrolled()).toMatchObject({
      reason: "malformed_input",
      remedy: "report",
    });
  });

  it("the cache is an input: after relay loss the cached links still resolve the chain", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b)];
    const m = machine(relay, b);
    const first = await acquired(m);
    expect(first.chain.chain).toEqual([hex(a), hex(b)]);
    relay.chain = [];
    const second = await acquired(m);
    expect(second.chain.chain).toEqual([hex(a), hex(b)]);
    expect(second.succession.missingLinks).toBe(1);
    const view = buildRosterView(second, NOW);
    expect(view.kind === "roster" && view.notes.map((n) => n.kind)).toContain("missing-links");
  });
});

// ── R21: the rotation hook ───────────────────────────────────────────

describe("R21 — the rotation hook (option b: after commit, new key, pre-rotation chain)", () => {
  it("an active host rotates → frozen active, and it enrols under the new key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    const record = await rotate(a, b);
    relay.chain = [record];
    relay.current = hex(b);
    m.setKey(b);
    const out = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(out).toMatchObject({ kind: "frozen", value: "active", decided: { kind: "minted" } });
    expect([...relay.enr.values()].filter((e) => e.public_key === hex(b))).toHaveLength(1);
    // The link joined the replica (C1.4).
    expect(m.cache.value!.succession).toHaveLength(1);
    // Resume path: the hook again mints nothing new (one per (device, key)).
    const again = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(again).toMatchObject({ kind: "frozen", value: "active", decided: { kind: "active" } });
    expect([...relay.enr.values()].filter((e) => e.public_key === hex(b))).toHaveLength(1);
    expect((await m.roster.ensureEnrolled()).kind).toBe("active");
  });

  it("a surface that was never a host rotates → frozen not-active, and it does NOT become one (N8)", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const record = await rotate(a, b);
    relay.chain = [record];
    const m = machine(relay, b);
    const out = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(out).toEqual({ kind: "frozen", value: "not-active", decided: null });
    expect(relay.enr.size).toBe(0);
  });

  it("a host retired before the rotation → frozen not-active; never re-enrols on its own", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    await relay.hold(await retireEntry(a, m.cache.value!.enrollments[0]!));
    const record = await rotate(a, b);
    relay.chain = [record];
    m.setKey(b);
    const out = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(out).toEqual({ kind: "frozen", value: "not-active", decided: null });
    expect(relay.enr.size).toBe(1);
    expect((await m.roster.ensureEnrolled()).kind).toBe("retired");
  });

  it("a retirement under the NEW key that reached this device first: frozen active, current retired → no mint (R14)", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    const e = m.cache.value!.enrollments[0]!;
    const record = await rotate(a, b);
    relay.chain = [record];
    await relay.hold(await retireEntry(b, e)); // the phone, on the new key
    m.setKey(b);
    const out = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(out).toMatchObject({ kind: "frozen", value: "active", decided: { kind: "retired" } });
    expect(relay.enr.size).toBe(1);
  });

  it("the hook's GET fails → frozen absent; first write wins, so a later successful hook cannot flip it", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    const record = await rotate(a, b);
    relay.chain = [record];
    m.setKey(b);
    relay.getFails = true;
    const out = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(out).toMatchObject({ kind: "frozen", value: "absent" });
    relay.getFails = false;
    const again = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(again).toMatchObject({ kind: "frozen", value: "absent", decided: null });
    expect((await m.roster.ensureEnrolled()).kind).toBe("superseded");
    expect([...relay.enr.values()].some((e) => e.public_key === hex(b))).toBe(false);
  });

  it("a hook whose new key is itself already rotated away → no verdict, frozen absent", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    const relay = new FakeRelay();
    const record = await rotate(a, b);
    relay.chain = [record, await rotate(b, c)];
    const m = machine(relay, b);
    const out = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(out.kind).toBe("no-verdict");
    expect(m.cache.value!.frozen).toEqual([
      expect.objectContaining({ pre_rotation_key: hex(a), value: "absent" }),
    ]);
  });
});

// ── C4: retire and enroll ────────────────────────────────────────────

describe("C4 — retire, and undo by enroll", () => {
  it("retires every standing entry of an active machine under the signer", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "vps", NOW - 1), await enrol(a, "vps", NOW - 2));
    const m = machine(relay, a);
    const out = await m.roster.retire("vps");
    expect(out).toMatchObject({ kind: "retired", advisory: false });
    if (out.kind === "retired") expect(out.retirementIds).toHaveLength(2);
    expect(relay.ret.size).toBe(2);
    const acq = await acquired(m);
    expect(acq.verdict.retired.map((x) => x.device_id)).toEqual(["vps"]);
    expect(await m.roster.retire("vps")).toEqual({ kind: "already-retired", deviceId: "vps" });
  });

  it("retiring a superseded line is advisory (N9)", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "old-vps"));
    relay.chain = [await rotate(a, b)];
    const m = machine(relay, b);
    expect(await m.roster.retire("old-vps")).toMatchObject({ kind: "retired", advisory: true });
  });

  it("connected but never enrolled → nothing to retire; unknown id → says so", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.live = [{ device_id: "phone", bound_under: hex(a), sockets_open: 1 }];
    const m = machine(relay, a);
    expect(await m.roster.retire("phone")).toEqual({ kind: "not-enrolled", deviceId: "phone" });
    expect(await m.roster.retire("nope")).toEqual({ kind: "unknown-device", deviceId: "nope" });
    expect(relay.ret.size).toBe(0);
  });

  it("retire refuses to sign on an unread relay", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.getFails = true;
    const m = machine(relay, a);
    expect((await m.roster.retire("vps")).kind).toBe("unreadable");
    expect((await m.roster.enroll("vps")).kind).toBe("unreadable");
  });

  it("enroll undoes a retirement (an explicit act)", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "vps"));
    const m = machine(relay, a);
    await m.roster.retire("vps");
    const out = await m.roster.enroll("vps");
    expect(out.kind).toBe("enrolled");
    const acq = await acquired(m);
    expect(acq.verdict.active.map((x) => x.device_id)).toEqual(["vps"]);
    expect(await m.roster.enroll("vps")).toEqual({ kind: "already-active", deviceId: "vps" });
  });

  it("R17a — an id with no line that is not this device's own needs --force", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    expect(await m.roster.enroll("typo")).toMatchObject({
      kind: "needs-force",
      why: "no-such-line",
    });
    expect(relay.enr.size).toBe(0);
    expect((await m.roster.enroll("typo", { force: true })).kind).toBe("enrolled");
    // Its own id needs no force.
    expect((await m.roster.enroll("dev-self")).kind).toBe("enrolled");
  });

  it("R17b / R24 — every line superseded needs --force, except this device's own id", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "old-vps"), await enrol(a, "dev-self"));
    relay.chain = [await rotate(a, b)];
    const m = machine(relay, b);
    expect(await m.roster.enroll("old-vps")).toMatchObject({
      kind: "needs-force",
      why: "all-superseded",
    });
    expect((await m.roster.enroll("dev-self")).kind).toBe("enrolled");
  });

  it("R17c — liveness shows the id bound under a known device key → needs --force", async () => {
    const a = await generateKeypair();
    const dk = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await retireEntry(a, await enrol(a, "tablet")), await enrol(a, "tablet"));
    relay.live = [{ device_id: "tablet", bound_under: hex(dk), sockets_open: 1 }];
    const m = machine(relay, a, { knownDeviceKeys: [hex(dk)] });
    expect(await m.roster.enroll("tablet")).toMatchObject({
      kind: "needs-force",
      why: "linked-device",
    });
  });
});

// ── C5: presentation ─────────────────────────────────────────────────

describe("C5 — presentation, chunks, refusals, the support set", () => {
  it("chunks of at most 64", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    const many: HostEnrollment[] = [];
    for (let i = 0; i < 70; i++) many.push(await enrol(a, `vps-${String(i).padStart(2, "0")}`));
    await m.cache.save({ ...emptyReplica(MID), enrollments: many });
    relay.posts = [];
    const acq = await acquired(m);
    // The repair already presented all 70 (the relay held none of them).
    expect(relay.posts.map((p) => p.enrollments.length + p.retirements.length)).toEqual([64, 6]);
    expect(acq.omitted).toEqual([]);
    expect(acq.repair?.taken).toBe(70);
  });

  it("422 per-entry refusal is 'not taken' (retried next time); roster_full is reported once and never retried", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, b, { local: [await rotate(a, b)] });
    const sup = await enrol(a, "old-vps"); // foreign bucket
    const bad = await enrol(b, "flaky");
    await m.cache.save({ ...emptyReplica(MID), enrollments: [sup, bad] });
    relay.full.add(await hostEnrollmentId(sup));
    relay.refuse.set(await hostEnrollmentId(bad), "too_large");
    const acq = await acquired(m);
    expect(acq.repair?.rosterFull).toEqual([await hostEnrollmentId(sup)]);
    expect(acq.repair?.notTaken).toEqual([
      { id: await hostEnrollmentId(bad), reason: "too_large" },
    ]);
    // R20 — roster_full ids are excluded from the set difference; the other stays omitted.
    expect(acq.omitted).toEqual([await hostEnrollmentId(bad)]);
    // Never retried, never re-reported.
    relay.posts = [];
    relay.refuse.clear();
    const again = await acquired(m);
    expect(again.repair?.rosterFull).toEqual([]);
    expect(relay.posts.flatMap((p) => p.enrollments).some((e) => e.device_id === "old-vps")).toBe(
      false,
    );
    expect(again.omitted).toEqual([]);
  });

  it("413, or no response at all: the whole chunk is not taken", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.cache.save({ ...emptyReplica(MID), enrollments: [await enrol(a, "vps")] });
    relay.status413 = true;
    const acq = await acquired(m);
    expect(acq.repair?.notTaken[0]?.reason).toMatch(/413/);
    relay.status413 = false;
    relay.presentDown = true;
    const acq2 = await acquired(m);
    expect(acq2.repair?.notTaken[0]?.reason).toBe("network");
    expect(acq2.omitted).toHaveLength(1);
  });

  it("the minimal support set: no history below H, no old-epoch entries of an active machine; pending tombstones go", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const oldOfActive = await enrol(a, "moved");
    const newOfActive = await enrol(b, "moved");
    const superseded = await enrol(a, "left-behind");
    const tomb = await signHostRetirement(
      { motebit_id: MID, enrollment_id: "f".repeat(64), public_key: hex(b), retired_at: NOW },
      b.privateKey,
    );
    const m = machine(relay, b, { local: [await rotate(a, b)] });
    await m.cache.save({
      ...emptyReplica(MID),
      enrollments: [oldOfActive, newOfActive, superseded],
      retirements: [tomb],
    });
    const acq = await acquired(m);
    const presented = new Set(
      await Promise.all([
        ...relay.posts.flatMap((p) => p.enrollments).map((e) => hostEnrollmentId(e)),
        ...relay.posts.flatMap((p) => p.retirements).map((r) => hostRetirementId(r)),
      ]),
    );
    expect(presented.has(await hostEnrollmentId(newOfActive))).toBe(true);
    expect(presented.has(await hostEnrollmentId(superseded))).toBe(true);
    expect(presented.has(await hostRetirementId(tomb))).toBe(true);
    expect(presented.has(await hostEnrollmentId(oldOfActive))).toBe(false);
    expect(acq.omitted).toEqual([]);
  });

  it("verify-before-hold: a served copy under a junk signature is never held", async () => {
    const a = await generateKeypair();
    const stranger = await generateKeypair();
    const relay = new FakeRelay();
    const real = await enrol(a, "vps");
    const junk = { ...real, signature: `${"A".repeat(85)}A` };
    const foreign = await enrol(stranger, "evil");
    relay.enr.set("junk", junk as HostEnrollment);
    relay.enr.set("real", real);
    relay.enr.set("foreign", foreign);
    const m = machine(relay, a);
    await acquired(m);
    expect(m.cache.value!.enrollments).toEqual([real]);
  });
});

// ── C6: rendering ────────────────────────────────────────────────────

describe("C6 — the view", () => {
  it("a quantifier only over an ok verdict with nothing suppressed; it cites the head by fingerprint", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b)];
    relay.current = hex(b);
    await relay.hold(await enrol(b, "dev-self"), await enrol(b, "vps"), await enrol(a, "old"));
    const m = machine(relay, b);
    const view = buildRosterView(await acquired(m), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    expect(view.head.fingerprint).toBe(keyFingerprint(hex(b)));
    expect(view.claim?.text).toBe(
      `2 machines on the current key ${keyFingerprint(hex(b))}…; not covered: 1 line on superseded keys`,
    );
    expect(view.lines.find((l) => l.kind === "superseded")?.text).toMatch(/advisory, not covered/);
  });

  it.each([
    [
      "relay_newer_key",
      async (r: FakeRelay): Promise<void> => {
        r.current = hex(await generateKeypair());
      },
    ],
    [
      "relay_unread",
      async (r: FakeRelay): Promise<void> => {
        r.getFails = true;
      },
    ],
  ] as const)("suppressed (%s) → no quantifier anywhere", async (reason, arrange) => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "dev-self"));
    const m = machine(relay, a);
    await m.roster.acquire(); // cache it
    await arrange(relay);
    const view = buildRosterView(await acquired(m), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    expect(view.suppressed).toContain(reason);
    expect(view.claim).toBeNull();
    const all = [...view.lines.map((l) => l.text), ...view.notes.map((n) => n.text)].join("\n");
    expect(all).not.toMatch(/\b\d+ machines? on the current key|every machine|all machines/);
    expect(suppressionText(reason)).toBeTruthy();
  });

  it("C1.3 — a guardian-verified branch this device is not on suppresses; a normal branch only discloses (N11)", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    const g = await generateKeypair();
    const recovery = await signGuardianRecoverySuccession(
      g.privateKey,
      c.privateKey,
      a.publicKey,
      c.publicKey,
    );
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b), recovery];
    const m = machine(relay, b, { guardian: hex(g) });
    const view = buildRosterView(await acquired(m), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    expect(view.suppressed).toContain("guardian_branch");
    expect(view.claim).toBeNull();

    const d = await generateKeypair();
    const relay2 = new FakeRelay();
    relay2.chain = [await rotate(a, b), await rotate(a, d)];
    const view2 = buildRosterView(await acquired(machine(relay2, b)), NOW);
    if (view2.kind !== "roster") throw new Error("expected roster");
    expect(view2.claim).not.toBeNull();
    expect(view2.notes.find((n) => n.kind === "branch")?.text).toMatch(/signed two successors/);
  });

  it("precedence: superseded-key socket BEFORE the theft rule (#767); known device key; unplaceable key; not in roster", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const dk = await generateKeypair();
    const thief = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b)];
    await relay.hold(await enrol(b, "dev-self"), await enrol(b, "vps"));
    relay.rows = [
      { device_id: "dev-self", bound_under: hex(b), last_seen_at: NOW, sockets_open: 1 },
      // The rotating machine's own daemon, still on the old key.
      { device_id: "dev-self", bound_under: hex(a), last_seen_at: NOW, sockets_open: 1 },
      { device_id: "vps", bound_under: hex(thief), last_seen_at: NOW, sockets_open: 1 },
      { device_id: "gone", bound_under: hex(a), last_seen_at: NOW - DAY, sockets_open: 0 },
    ];
    relay.live = [
      { device_id: "tablet", bound_under: hex(dk), sockets_open: 1 },
      { device_id: "laptop", bound_under: hex(b), sockets_open: 1 },
    ];
    const m = machine(relay, b, { knownDeviceKeys: [hex(dk)] });
    const view = buildRosterView(await acquired(m), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    const by = (d: string, kind: string) =>
      view.lines.find((l) => l.device_id === d && l.kind === kind);
    expect(by("dev-self", "active")?.text).toMatch(/the relay believes a socket is open/);
    expect(by("dev-self", "superseded-key-socket")?.text).toMatch(
      /socket open under a superseded key .*: this machine's daemon before it restarted, or any holder of that key/,
    );
    expect(by("gone", "superseded-key-socket")?.text).toMatch(/last seen under a superseded key/);
    expect(by("vps", "unplaced-key-socket")?.text).toMatch(/cannot place in this motebit's chain/);
    expect(by("vps", "unplaced-key-socket")?.text).not.toMatch(/not this motebit/);
    expect(by("tablet", "linked-device")?.text).toMatch(/linked device without the identity key/);
    expect(by("laptop", "not-in-roster")?.text).toMatch(/connected, not in the roster/);
    expect(by("vps", "active")?.text).toMatch(/not observed in the last 90 days/);
  });

  it("R25 — an enrolment under a key this device cannot place is 'not covered'; a device key only relabels", async () => {
    const a = await generateKeypair();
    const k = await generateKeypair();
    const dk = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(
      await enrol(a, "dev-self"),
      await enrol(k, "mystery"),
      await enrol(dk, "tablet"),
    );
    const m = machine(relay, a, { knownDeviceKeys: [hex(dk)] });
    const view = buildRosterView(await acquired(m), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    expect(view.claim?.unplaced).toBe(2);
    expect(view.lines.find((l) => l.device_id === "mystery")?.text).toMatch(
      /cannot place in its chain \(older or newer\)/,
    );
    const tablet = view.lines.find((l) => l.device_id === "tablet");
    expect(tablet).toMatchObject({ kind: "unplaced-enrollment", linked_device: true });
    expect(view.claim?.text).toMatch(/2 under keys this device cannot place/);
  });

  it("retired, but connected", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const e = await enrol(a, "vps");
    await relay.hold(e, await retireEntry(a, e));
    relay.rows = [{ device_id: "vps", bound_under: hex(a), last_seen_at: NOW, sockets_open: 1 }];
    const view = buildRosterView(await acquired(machine(relay, a)), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    expect(view.lines.find((l) => l.device_id === "vps")?.text).toMatch(/retired, but connected/);
  });

  it("C6.8 — the ambiguity hint needs two successive reads, and says 'may'", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "vps"));
    relay.rows = [{ device_id: "vps", bound_under: hex(a), last_seen_at: NOW, sockets_open: 2 }];
    const m = machine(relay, a);
    const first = buildRosterView(await acquired(m), NOW);
    expect(first.kind === "roster" && first.notes.some((n) => n.kind === "ambiguous")).toBe(false);
    const second = buildRosterView(await acquired(m), NOW);
    const note = second.kind === "roster" ? second.notes.find((n) => n.kind === "ambiguous") : null;
    expect(note?.text).toMatch(/may share the id vps/);
  });

  it("N12 — after a restore with a fresh id, offer to retire the prior line", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const before = machine(relay, a, { deviceId: "old-id" });
    await before.roster.ensureEnrolled();
    const after = machine(relay, a, { deviceId: "new-id", cache: before.cache });
    const view = buildRosterView(await acquired(after), NOW);
    const note = view.kind === "roster" ? view.notes.find((n) => n.kind === "prior-line") : null;
    expect(note).toMatchObject({ device_id: "old-id" });
  });

  it("ancestry is cited: rooted for a sovereign id's genesis key", async () => {
    const a = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(a));
    const relay = new FakeRelay();
    const m = machine(relay, a, { motebitId: mid });
    const view = buildRosterView(await acquired(m), NOW);
    expect(view.kind === "roster" && view.notes[0]?.text).toMatch(/rooted/);
  });

  it("not observed since the relay began observing, when its window is not yet full", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "vps"));
    const m = machine(relay, a);
    const acq = await acquired(m);
    acq.served!.liveness.observing_since = NOW - 3 * DAY;
    const view = buildRosterView(acq, NOW);
    expect(view.kind === "roster" && view.lines[0]?.text).toMatch(
      /not observed since .* began observing/,
    );
    expect(view.kind === "roster" && view.lines[0]?.text).not.toMatch(/never/);
  });
});

// ── The replica and the served parse ─────────────────────────────────

describe("replica and parsing", () => {
  it("parseReplica is strict; mergeReplicas is a union with first-write-wins frozen values", async () => {
    expect(parseReplica(null)).toBeNull();
    expect(parseReplica({ ...emptyReplica(MID), enrollments: [{ nope: 1 }] })).toBeNull();
    expect(parseReplica({ ...emptyReplica(MID), frozen: [{ device_id: "x" }] })).toBeNull();
    const r = emptyReplica(MID);
    expect(parseReplica(JSON.parse(JSON.stringify(r)))).toEqual(r);
    const f1 = { device_id: "d", pre_rotation_key: "k", value: "absent" as const, taken_at: 1 };
    const f2 = { ...f1, value: "active" as const, taken_at: 2 };
    const merged = mergeReplicas({ ...r, frozen: [f1] }, { ...r, frozen: [f2] });
    expect(merged.frozen).toEqual([f1]);
    expect(() => mergeReplicas(r, emptyReplica("other"))).toThrow(/two different motebits/);
  });

  it("parseServedRoster refuses a body that is not the part-B shape", () => {
    expect(parseServedRoster(null)).toBeNull();
    expect(parseServedRoster({ enrollments: [], retirements: [] })).toBeNull();
    expect(
      parseServedRoster({
        enrollments: [],
        retirements: [],
        liveness: { rows: [{ device_id: 1 }], live_unenrolled: [] },
      }),
    ).toBeNull();
  });

  it("the signer's public key is derived from its private key", async () => {
    const a = await generateKeypair();
    expect((await signerOf(a)).publicKeyHex).toBe(hex(a));
  });
});

// ── The remaining branches, each a real case ─────────────────────────

describe("edge cases", () => {
  it("parseReplica accepts a full replica and refuses each malformed field", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const e = await enrol(a, "vps");
    const full: MachineRosterReplica = {
      version: 1,
      motebit_id: MID,
      succession: [await rotate(a, b)],
      enrollments: [e],
      retirements: [await retireEntry(a, e)],
      frozen: [{ device_id: "vps", pre_rotation_key: hex(a), value: "active", taken_at: 1 }],
      roster_full: ["x"],
      own_device_ids: ["vps"],
      ambiguous: { at: 5, pairs: ["p"] },
    };
    const round = JSON.parse(JSON.stringify(full)) as unknown;
    expect(parseReplica(round)).toEqual(full);
    for (const bad of [
      { version: 2 },
      { motebit_id: "" },
      { succession: [{ old_public_key: 1 }] },
      { succession: ["x"] },
      { retirements: [{ nope: true }] },
      { roster_full: [1] },
      { own_device_ids: "x" },
      { ambiguous: ["p"] },
      { ambiguous: { at: "x", pairs: [] } },
      { frozen: [null] },
    ]) {
      expect(parseReplica({ ...full, ...bad })).toBeNull();
    }
    expect(parseReplica([])).toBeNull();
    // A newer stored ambiguity read is kept over an older incoming one.
    expect(
      mergeReplicas({ ...full }, { ...full, ambiguous: { at: 1, pairs: [] } }).ambiguous,
    ).toEqual({
      at: 5,
      pairs: ["p"],
    });
  });

  it("parseServedRoster defaults absent liveness fields and refuses malformed rows", () => {
    const ok = parseServedRoster({
      enrollments: [],
      retirements: [],
      liveness: {
        rows: [{ device_id: "d", bound_under: "k" }],
        live_unenrolled: [{ device_id: "d", bound_under: "k" }],
      },
    });
    expect(ok?.liveness).toEqual({
      observed_by: "",
      retention_days: 0,
      observing_since: 0,
      rows: [{ device_id: "d", bound_under: "k", last_seen_at: null, sockets_open: 0 }],
      live_unenrolled: [{ device_id: "d", bound_under: "k", sockets_open: 0 }],
    });
    expect(
      parseServedRoster({
        enrollments: [],
        retirements: [],
        liveness: { rows: [], live_unenrolled: [{ device_id: 1 }] },
      }),
    ).toBeNull();
    expect(
      parseServedRoster({ enrollments: [], retirements: [], liveness: { rows: 1 } }),
    ).toBeNull();
    expect(parseServedRoster({ enrollments: [], retirements: 1 })).toBeNull();
  });

  it("a relay answer that is not a roster is a failed GET, never an empty set", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    const roster = new MachineRoster({
      ...m.ports,
      fetchRoster: async () => ({ ok: true, body: { nope: 1 } }),
    });
    const out = await roster.ensureEnrolled();
    expect(out).toMatchObject({ kind: "unknown", why: "fetch-failed" });
    expect(out.kind === "unknown" && out.detail).toMatch(/not a roster/);
  });

  it("no key: retire and enroll stop without reading; the hook uses its explicit signer", async () => {
    const relay = new FakeRelay();
    const m = machine(relay, null);
    expect(await m.roster.retire("x")).toEqual({ kind: "no-key" });
    expect(await m.roster.enroll("x")).toEqual({ kind: "no-key" });
    expect(relay.gets).toBe(0);
    const a = await generateKeypair();
    const b = await generateKeypair();
    const out = await m.roster.afterRotation({
      signer: await signerOf(b),
      record: await rotate(a, b),
    });
    expect(out.kind).toBe("frozen");
    expect(relay.gets).toBeGreaterThan(0);
  });

  it("refusals reach retire and enroll too", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b)];
    const m = machine(relay, a);
    expect(await m.roster.retire("x")).toMatchObject({
      kind: "refused",
      reason: "held_key_superseded",
    });
    expect(await m.roster.enroll("x")).toMatchObject({
      kind: "refused",
      reason: "held_key_superseded",
    });
  });

  it("retire says why nothing was signed: a corrupt cache, an omission", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const cache = new FakeCache();
    cache.corrupt = true;
    const m = machine(relay, a, { cache });
    expect(await m.roster.retire("vps")).toEqual({
      kind: "unreadable",
      detail: "the local roster replica could not be read; it was kept aside",
    });
    const other = await enrol(a, "vps");
    await cache.save({ ...emptyReplica(MID), enrollments: [other] });
    relay.omit.add(await hostEnrollmentId(other));
    expect(await m.roster.retire("vps")).toEqual({
      kind: "unreadable",
      detail: "the relay is missing 1 entry this device holds",
    });
  });

  it("a connected-only id is found in persisted rows too", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.rows = [{ device_id: "host", bound_under: hex(a), last_seen_at: NOW, sockets_open: 0 }];
    expect(await machine(relay, a).roster.retire("host")).toEqual({
      kind: "not-enrolled",
      deviceId: "host",
    });
  });

  it("a roster_full met on a later presentation is remembered", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    const other = await enrol(a, "vps");
    await relay.hold(other);
    await m.cache.save({ ...emptyReplica(MID), enrollments: [other] });
    relay.full.add(await hostEnrollmentId(other));
    const out = await m.roster.ensureEnrolled();
    expect(out.kind === "active" && out.presented.rosterFull).toEqual([
      await hostEnrollmentId(other),
    ]);
    expect(m.cache.value!.roster_full).toEqual([await hostEnrollmentId(other)]);
  });

  it("a 422 whose refusals are junk counts the chunk as taken; another status takes none", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.cache.save({ ...emptyReplica(MID), enrollments: [await enrol(a, "vps")] });
    const junk = new MachineRoster({
      ...m.ports,
      presentRoster: async () => ({
        status: 422,
        body: { refused: [null, { index: "x" }, { kind: "enrollment", index: 99 }] },
      }),
    });
    const acq = await junk.acquire();
    expect(acq.kind === "acquired" && acq.repair?.taken).toBe(1);
    const five = new MachineRoster({
      ...m.ports,
      presentRoster: async () => ({ status: 500, body: null }),
    });
    const again = await five.acquire();
    expect(again.kind === "acquired" && again.repair?.notTaken[0]?.reason).toBe("status 500");
  });

  it.each([
    [
      "forked_below",
      async (a: KeyPair, b: KeyPair): Promise<KeySuccessionRecord[]> => {
        const x = await generateKeypair();
        const y = await generateKeypair();
        return [await rotate(x, a), await rotate(y, a), await rotate(a, b)];
      },
      /signed two predecessors/,
    ],
    [
      "recovery_limited",
      async (a: KeyPair, b: KeyPair): Promise<KeySuccessionRecord[]> => {
        const g = await generateKeypair();
        const x = await generateKeypair();
        return [
          await signGuardianRecoverySuccession(
            g.privateKey,
            a.privateKey,
            x.publicKey,
            a.publicKey,
          ),
          await rotate(a, b),
        ];
      },
      /cannot be checked here/,
    ],
    [
      "cycle_below",
      async (a: KeyPair, b: KeyPair): Promise<KeySuccessionRecord[]> => {
        const x = await generateKeypair();
        return [await rotate(x, a), await rotate(a, x), await rotate(a, b)];
      },
      /repeats a key/,
    ],
  ] as const)("ancestry %s is disclosed, never refused", async (kind, records, text) => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = await records(a, b);
    const acq = await acquired(machine(relay, b));
    expect(acq.chain.ancestry.kind).toBe(kind);
    const view = buildRosterView(acq, NOW);
    expect(view.kind === "roster" && view.notes[0]?.text).toMatch(text);
    expect(view.kind === "roster" && view.claim).not.toBeNull();
  });

  it("liveness says last seen when no socket is open; an unplaceable enrolment of a device with a line is not double-counted", async () => {
    const a = await generateKeypair();
    const k = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "vps"), await enrol(k, "vps"));
    relay.rows = [
      { device_id: "vps", bound_under: hex(a), last_seen_at: NOW - DAY, sockets_open: 0 },
    ];
    const view = buildRosterView(await acquired(machine(relay, a)), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    expect(view.lines[0]?.text).toMatch(/last seen 20/);
    expect(view.claim?.unplaced).toBe(0);
  });

  it("the prior-line offer skips this device's own id and ids with no standing line", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const cache = new FakeCache();
    await cache.save({ ...emptyReplica(MID), own_device_ids: ["new-id", "gone-id"] });
    const view = buildRosterView(
      await acquired(machine(relay, a, { deviceId: "new-id", cache })),
      NOW,
    );
    expect(view.kind === "roster" && view.notes.some((n) => n.kind === "prior-line")).toBe(false);
  });
});

// ── Review round 1 ───────────────────────────────────────────────────

describe("round 1 — W2: the mint decision is atomic across processes", () => {
  it("a run and a serve starting together mint exactly one enrolment", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const cache = new FakeCache();
    const beforeSign = raceGate();
    const run = machine(relay, a, { cache, beforeSign });
    const serve = machine(relay, a, { cache, beforeSign, now: NOW + 1 });
    const outs = await Promise.all([run.roster.ensureEnrolled(), serve.roster.ensureEnrolled()]);
    expect(outs.map((o) => o.kind).sort()).toEqual(["active", "minted"]);
    expect(cache.value!.enrollments).toHaveLength(1);
    expect(relay.enr.size).toBe(1);
  });

  it("the reviewer's sequence: one POST lost, a fresh surface retires what it sees, the restart stays retired", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const cache = new FakeCache();
    const beforeSign = raceGate();
    await Promise.all([
      machine(relay, a, { cache, beforeSign }).roster.ensureEnrolled(),
      machine(relay, a, { cache, beforeSign, now: NOW + 1 }).roster.ensureEnrolled(),
    ]);
    // Any second enrolment's POST was lost: the relay keeps only the first.
    const [first] = [...relay.enr.keys()];
    for (const id of [...relay.enr.keys()]) if (id !== first) relay.enr.delete(id);
    // The phone, with an empty replica, retires what it sees.
    const phone = machine(relay, a, { deviceId: "phone" });
    expect(await phone.roster.retire("dev-self")).toMatchObject({ kind: "retired" });
    // The machine restarts: it stays retired, and nothing it held revives it.
    const restart = await machine(relay, a, { cache }).roster.ensureEnrolled();
    expect(restart.kind).toBe("retired");
    const acq = await acquired(machine(relay, a, { cache }));
    expect(acq.verdict.active.map((m) => m.device_id)).toEqual([]);
  });

  it("an explicit enroll racing an automatic start also yields one line", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const cache = new FakeCache();
    const beforeSign = raceGate();
    const outs = await Promise.all([
      machine(relay, a, { cache, beforeSign }).roster.ensureEnrolled(),
      machine(relay, a, { cache, beforeSign, now: NOW + 1 }).roster.enroll("dev-self"),
    ]);
    // Whichever wins the lock mints; the other sees its line.
    expect([
      ["minted", "already-active"],
      ["active", "enrolled"],
    ]).toContainEqual(outs.map((o) => o.kind));
    expect(cache.value!.enrollments).toHaveLength(1);
  });

  it("a mint whose locked re-read is corrupt mints nothing", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const cache = new FakeCache();
    const m = machine(relay, a, { cache });
    let loads = 0;
    const roster = new MachineRoster({
      ...m.ports,
      cache: {
        load: async () => (++loads === 2 ? { kind: "corrupt" } : cache.load()),
        save: (r) => cache.save(r),
        exclusive: (fn) => cache.exclusive(fn),
      },
    });
    expect(await roster.ensureEnrolled()).toMatchObject({ kind: "unknown", why: "cache-corrupt" });
    expect(relay.enr.size).toBe(0);
  });
});

describe("round 1 — P3: the rotation hook never mints after a corrupt read", () => {
  it("an active host whose replica was unreadable at the hook freezes absent and mints nothing", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const m = machine(relay, a);
    await m.roster.ensureEnrolled();
    const record = await rotate(a, b);
    relay.chain = [record];
    m.cache.corrupt = true;
    const out = await m.roster.afterRotation({ signer: await signerOf(b), record });
    expect(out).toEqual({ kind: "frozen", value: "absent", decided: null });
    expect([...relay.enr.values()].some((e) => e.public_key === hex(b))).toBe(false);
  });
});

describe("round 1 — P4: the ambiguity hint needs two reads that happened", () => {
  it("a failed second read never completes the pair", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "vps"));
    relay.rows = [{ device_id: "vps", bound_under: hex(a), last_seen_at: NOW, sockets_open: 2 }];
    const m = machine(relay, a);
    await acquired(m);
    relay.getFails = true;
    const view = buildRosterView(await acquired(m), NOW);
    expect(view.kind === "roster" && view.notes.some((n) => n.kind === "ambiguous")).toBe(false);
  });
});

describe("round 1 — W1: the view owns what an empty roster means", () => {
  it("no lines over an ok verdict: none enrolled", async () => {
    const view = buildRosterView(
      await acquired(machine(new FakeRelay(), await generateKeypair())),
      NOW,
    );
    expect(view.kind === "roster" && view.empty).toEqual({
      kind: "none-enrolled",
      text: "no machine has enrolled yet",
    });
  });

  it("no lines over a suppressed verdict (relay unreadable): nothing held here — never 'no machine has enrolled'", async () => {
    const relay = new FakeRelay();
    relay.getFails = true;
    const view = buildRosterView(await acquired(machine(relay, await generateKeypair())), NOW);
    if (view.kind !== "roster") throw new Error("expected roster");
    expect(view.claim).toBeNull();
    expect(view.empty?.kind).toBe("nothing-held");
    expect(view.empty?.text).not.toMatch(/enrolled/);
  });

  it("lines present: nothing to say about emptiness", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "vps"));
    const view = buildRosterView(await acquired(machine(relay, a)), NOW);
    expect(view.kind === "roster" && view.empty).toBeNull();
  });
});

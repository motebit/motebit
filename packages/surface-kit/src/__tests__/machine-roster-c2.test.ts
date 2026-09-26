/**
 * Machine roster C-2 kit additions — `docs/proposals/machine-roster-surfaces-v1.md`
 * §1A (F1, F2, F5b, F6, F7, F8, F9) and §1B (B1, R1, R2): the held-key
 * classification, the custody flag, the gate on every act, the non-host
 * enrol rules, omission repair only on the presenting surface, Retry-After,
 * and the shared Settings section state holder.
 */
import { describe, it, expect, vi } from "vitest";
import { deriveSovereignMotebitId, type KeyPair } from "@motebit/encryption";
import {
  FakeRelay,
  LEGACY_MID,
  NOW,
  acquiredOf,
  c2Machine,
  enrol,
  generateKeypair,
  hex,
  retireEntry,
  rotate,
} from "./roster-harness.js";
import {
  classifyHeldKey,
  classifyResolved,
  custodyAfterRotation,
  custodyFlagFor,
  heldKeyText,
  parseCustodyFlag,
  rotationLinkReplica,
  type CustodyFlag,
  type HeldKeyClass,
} from "../machine-roster-held-key.js";
import {
  createMachineRosterSection,
  enrollNotice,
  needsForceText,
  nextPresentationRecord,
  presentationDue,
  replicaDigest,
  retireNotice,
  rosterLineActions,
  type PresentationCadence,
} from "../machine-roster-section.js";
import { buildRosterView, suppressionText } from "../machine-roster-view.js";
import { emptyReplica } from "../machine-roster-replica.js";
import { MachineRoster, ROSTER_CHUNK_SIZE } from "../machine-roster.js";

const flagFor = (kp: KeyPair, motebitId = LEGACY_MID): CustodyFlag => ({
  motebit_id: motebitId,
  public_key: hex(kp),
  set_at: NOW,
  reason: "minted",
});

// ── §1A / §1B B1 — classifyHeldKey ──────────────────────────────────

describe("classifyHeldKey — identity only on the four routes; device-key only on positive evidence", () => {
  it("route 1: a sovereign id whose chain roots at its genesis key is identity (rooted), offline of any relay word", async () => {
    const g = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(g));
    const m = c2Machine(new FakeRelay(mid), g);
    const acq = await acquiredOf(m);
    expect(acq.heldKey).toEqual({ kind: "identity", basis: "rooted" });
    expect(classifyHeldKey(acq)).toEqual({ kind: "identity", basis: "rooted" });
    expect(acq.suppressed).not.toContain("held_key_unconfirmed");
  });

  it("route 1: a rotated sovereign identity roots through the served link", async () => {
    const g = await generateKeypair();
    const b = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(g));
    const relay = new FakeRelay(mid);
    relay.chain = [await rotate(g, b)];
    relay.current = hex(b);
    const acq = await acquiredOf(c2Machine(relay, b));
    expect(acq.heldKey).toEqual({ kind: "identity", basis: "rooted" });
  });

  it("route 2: a refusal whose evidence names the held key is identity (on-chain); malformed and no-key are unconfirmed", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(a, b)];
    const m = c2Machine(relay, a);
    const acq = await m.roster.acquire();
    expect(acq.kind).toBe("refused");
    expect(classifyHeldKey(acq)).toEqual({ kind: "identity", basis: "on-chain" });
    expect(classifyHeldKey({ kind: "no-key" })).toEqual({ kind: "unconfirmed", why: "no-key" });
    expect(
      classifyHeldKey({
        kind: "refused",
        reason: "malformed_input",
        held: hex(a),
        detail: "",
        remedy: "report",
        cache: "absent",
      }),
    ).toEqual({ kind: "unconfirmed", why: "malformed" });
  });

  it("route 3: a LEGACY id whose relay names the held key is identity (relay), and says so", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(a);
    const acq = await acquiredOf(c2Machine(relay, a));
    expect(acq.heldKey).toEqual({ kind: "identity", basis: "relay" });
    expect(heldKeyText(acq.heldKey!)).toBe("identity key per the relay");
  });

  it("route 4 (B1): a legacy id with no relay key is identity only when the custody flag names the HELD key", async () => {
    const a = await generateKeypair();
    const other = await generateKeypair();
    const cases: Array<[CustodyFlag | null, HeldKeyClass]> = [
      [null, { kind: "unconfirmed", why: "no-evidence" }],
      [flagFor(a), { kind: "identity", basis: "custody-record" }],
      [flagFor(other), { kind: "unconfirmed", why: "no-evidence" }],
      [
        flagFor(a, "0190f1a2-0000-7000-8000-00000000ffff"),
        { kind: "unconfirmed", why: "no-evidence" },
      ],
    ];
    for (const [flag, want] of cases) {
      const acq = await acquiredOf(c2Machine(new FakeRelay(), a, { flag }));
      expect(acq.heldKey).toEqual(want);
    }
    const custody = await acquiredOf(c2Machine(new FakeRelay(), a, { flag: flagFor(a) }));
    expect(heldKeyText(custody.heldKey!)).toBe("identity key per this device's custody record");
  });

  it("unconfirmed suppresses every count with `held_key_unconfirmed`, and never says 'linked without the identity key'", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "dev-host"));
    const acq = await acquiredOf(c2Machine(relay, a));
    expect(acq.suppressed).toContain("held_key_unconfirmed");
    const view = buildRosterView(acq, NOW);
    expect(view.kind === "roster" && view.claim).toBeNull();
    // The lines still render (B1's stated cost: lines shown, no count).
    expect(view.kind === "roster" && view.lines.map((l) => l.kind)).toEqual(["active"]);
    expect(heldKeyText(acq.heldKey!)).not.toMatch(/linked without/);
    expect(suppressionText("held_key_unconfirmed")).toMatch(/cannot confirm/);
  });

  it("device-key: the relay names ANOTHER key, nothing verified touches the held key — and the custody flag cannot override it", async () => {
    const identity = await generateKeypair();
    const device = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(identity);
    const acq = await acquiredOf(c2Machine(relay, device, { flag: flagFor(device) }));
    expect(acq.heldKey).toEqual({ kind: "device-key" });
    expect(heldKeyText(acq.heldKey!)).toMatch(/linked without the identity key/);
  });

  it("device-key on a sovereign id: a device key never binds, so the relay naming the genesis key is positive evidence", async () => {
    const g = await generateKeypair();
    const device = await generateKeypair();
    const relay = new FakeRelay(await deriveSovereignMotebitId(hex(g)));
    relay.current = hex(g);
    const acq = await acquiredOf(c2Machine(relay, device));
    expect(acq.heldKey).toEqual({ kind: "device-key" });
  });

  it("a verified record touching the held key is NOT device-key evidence: unconfirmed instead", async () => {
    // Legacy: x → held is verified, and the relay names a third key it has
    // no link to (a rotation this device has not seen). Held is on the
    // identity's chain, so never "linked without the identity key".
    const x = await generateKeypair();
    const held = await generateKeypair();
    const third = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(x, held)];
    relay.current = hex(third);
    const acq = await acquiredOf(c2Machine(relay, held));
    expect(acq.heldKey).toEqual({ kind: "unconfirmed", why: "no-evidence" });
  });

  it("routes 3 and 4 are LEGACY-only: an unrooted sovereign id stays unconfirmed whatever the relay or the flag says", async () => {
    const g = await generateKeypair();
    const b = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(g));
    const relay = new FakeRelay(mid); // the relay lost the g → b link
    relay.current = hex(b);
    const acq = await acquiredOf(c2Machine(relay, b, { flag: flagFor(b, mid) }));
    expect(acq.heldKey).toEqual({ kind: "unconfirmed", why: "no-evidence" });
  });

  it("property: the custody flag never produces identity for a sovereign id, nor against device-key evidence", async () => {
    const keys = await Promise.all([0, 1, 2].map(() => generateKeypair()));
    const [held, other, third] = keys as [KeyPair, KeyPair, KeyPair];
    const g = await generateKeypair();
    const sovereign = await deriveSovereignMotebitId(hex(g));
    const base = await acquiredOf(c2Machine(new FakeRelay(), held));
    for (const sovereign_id of [false, true]) {
      for (const hint of [null, hex(held), hex(other), hex(third)]) {
        for (const flag of [null, flagFor(held), flagFor(held, sovereign), flagFor(other)]) {
          const c = classifyResolved({
            motebitId: sovereign_id ? sovereign : LEGACY_MID,
            held: hex(held),
            chain: { ...base.chain, sovereign_id },
            hint,
            succession: [],
            custodyFlag: flag,
          });
          const deviceEvidence = hint != null && hint !== hex(held);
          if (deviceEvidence) expect(c).toEqual({ kind: "device-key" });
          if (sovereign_id) expect(c.kind).not.toBe("identity");
          if (c.kind === "identity" && c.basis === "custody-record") {
            expect(sovereign_id || deviceEvidence).toBe(false);
            expect(flag?.public_key).toBe(hex(held));
          }
        }
      }
    }
  });
});

// ── §1B R1 — nothing is signed or presented unless the class is identity ──

describe("R1 — a gated roster refuses retire, enroll, present, repair and the rotation hook unless the held key is the identity key", () => {
  async function unconfirmedHost() {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    const e = await enrol(a, "dev-host");
    await relay.hold(e);
    const m = c2Machine(relay, a);
    return { a, relay, e, m };
  }

  it("retire and enroll answer held-key-not-identity and sign nothing", async () => {
    const { relay, m } = await unconfirmedHost();
    const r = await m.roster.retire("dev-host");
    expect(r).toMatchObject({ kind: "held-key-not-identity", heldKey: { kind: "unconfirmed" } });
    const e = await m.roster.enroll("dev-other", { force: true });
    expect(e.kind).toBe("held-key-not-identity");
    expect(relay.ret.size).toBe(0);
    expect(relay.enr.size).toBe(1);
    expect(m.cache.value!.retirements).toHaveLength(0);
    expect(relay.posts).toHaveLength(0);
  });

  it("present answers refused and POSTs nothing; ensureEnrolled is refused too", async () => {
    const { relay, m } = await unconfirmedHost();
    const acq = await acquiredOf(m);
    expect(await m.roster.present(acq)).toMatchObject({ refused: "held-key-not-identity" });
    expect((await m.roster.ensureEnrolled()).kind).toBe("held-key-not-identity");
    expect(relay.posts).toHaveLength(0);
  });

  it("an omission is not repaired under an unconfirmed key (the repair is a presentation)", async () => {
    const { a, relay, e } = await unconfirmedHost();
    const m = c2Machine(relay, a, { flag: flagFor(a) });
    await m.roster.retire("dev-host"); // identity via the flag: held retirement
    const [rid] = [...relay.ret.keys()];
    relay.omit.add(rid!); // the relay now omits it
    relay.posts = [];
    m.flag.value = null; // same device, custody no longer confirmed
    const acq = await acquiredOf(m);
    expect(acq.omitted).toEqual([rid]);
    expect(acq.repair).toBeNull();
    expect(relay.posts).toHaveLength(0);
    void e;
  });

  it("the rotation hook mints nothing under an unconfirmed key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    const record = await rotate(a, b);
    relay.chain = [record];
    const m = c2Machine(relay, b);
    const signer = (await m.ports.signer())!;
    const out = await m.roster.afterRotation({ signer, record });
    expect(out).toEqual({
      kind: "no-verdict",
      detail: "the held key is not confirmed as the identity key",
    });
    expect(relay.enr.size).toBe(0);
  });

  it("with the identity key, the same roster retires and presents", async () => {
    const { a, relay, m } = await unconfirmedHost();
    m.flag.value = flagFor(a);
    const r = await m.roster.retire("dev-host");
    expect(r.kind).toBe("retired");
    expect(relay.ret.size).toBe(1);
  });

  it("an UNGATED roster (the CLI) carries no class and suppresses nothing new (R5)", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "dev-host"));
    const acq = await acquiredOf(c2Machine(relay, a, { gated: false }));
    expect(acq.heldKey).toBeUndefined();
    expect(acq.suppressed).toEqual([]);
  });
});

// ── F1 — knownDeviceKeys never includes the chain's keys ──────────────

describe("F1 — the chain's own keys are never relabelled 'a linked device'", () => {
  it("an unenrolled host bound under the identity key renders not-in-roster, and enroll does not ask for force as a linked device", async () => {
    const a = await generateKeypair();
    const linked = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(a);
    relay.rows = [
      { device_id: "dev-host", bound_under: hex(a), last_seen_at: NOW, sockets_open: 1 },
    ];
    // The bootstrap registered the local device under the genesis key.
    const m = c2Machine(relay, a, { knownDeviceKeys: [hex(a), hex(linked)] });
    const acq = await acquiredOf(m);
    expect(acq.knownDeviceKeys).toEqual([hex(linked)]);
    const view = buildRosterView(acq, NOW);
    expect(view.kind === "roster" && view.lines.map((l) => l.kind)).toEqual(["not-in-roster"]);
  });

  it("R17c never fires on the identity key: a retired host connected under it re-enrols without force", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(a);
    const e = await enrol(a, "dev-host");
    await relay.hold(e, await retireEntry(a, e));
    relay.rows = [
      { device_id: "dev-host", bound_under: hex(a), last_seen_at: NOW, sockets_open: 1 },
    ];
    const m = c2Machine(relay, a, { knownDeviceKeys: [hex(a)] });
    const out = await m.roster.enroll("dev-host");
    expect(out.kind).toBe("enrolled");
  });
});

// ── F5b — selfIsHost: false ──────────────────────────────────────────

describe("F5b — on a surface that is never a host, enroll(own) takes the R17 refusals and records no own mint", () => {
  it("no line: needs-force (no-such-line), then with force enrols but own_minted / own_device_ids stay empty", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(a);
    const m = c2Machine(relay, a, { options: { selfIsHost: false } });
    expect(await m.roster.enroll("dev-self")).toMatchObject({
      kind: "needs-force",
      why: "no-such-line",
    });
    const forced = await m.roster.enroll("dev-self", { force: true });
    expect(forced.kind).toBe("enrolled");
    expect(m.cache.value!.own_minted).toEqual([]);
    expect(m.cache.value!.own_device_ids).toEqual([]);
  });

  it("a superseded own line needs force (no R24 exemption)", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const relay = new FakeRelay();
    await relay.hold(await enrol(a, "dev-self"));
    relay.chain = [await rotate(a, b)];
    relay.current = hex(b);
    const m = c2Machine(relay, b, { options: { selfIsHost: false } });
    expect(await m.roster.enroll("dev-self")).toMatchObject({
      kind: "needs-force",
      why: "all-superseded",
    });
  });

  it("default (a host, the CLI): enroll(own) mints directly and records the own mint", async () => {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(a);
    const m = c2Machine(relay, a);
    expect((await m.roster.enroll("dev-self")).kind).toBe("enrolled");
    expect(m.cache.value!.own_device_ids).toEqual(["dev-self"]);
    expect(m.cache.value!.own_minted).toHaveLength(1);
  });
});

// ── R2 — omission repair only on the presenting surface ──────────────

describe("R2 — repairOmissions: false leaves an omission standing and presents nothing", () => {
  async function omitting(repairOmissions: boolean | (() => boolean)) {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(a);
    const m = c2Machine(relay, a, { options: { repairOmissions } });
    await m.roster.retire("nope"); // nothing
    const e = await enrol(a, "dev-host");
    await relay.hold(e);
    await acquiredOf(m); // held now
    const [id] = [...relay.enr.keys()];
    relay.omit.add(id!);
    relay.posts = [];
    return { m, relay, id: id! };
  }

  it("false: omitted, not re-presented, not re-checked", async () => {
    const { m, relay, id } = await omitting(false);
    const acq = await acquiredOf(m);
    expect(acq.omitted).toEqual([id]);
    expect(acq.repair).toBeNull();
    expect(acq.omissionRechecked).toBe(false);
    expect(relay.posts).toHaveLength(0);
    expect(acq.suppressed).toContain("relay_omission");
  });

  it("a function is asked on every acquisition (a tab that gains the presentation lock repairs)", async () => {
    let leader = false;
    const { m, relay } = await omitting(() => leader);
    await acquiredOf(m);
    expect(relay.posts).toHaveLength(0);
    leader = true;
    const acq = await acquiredOf(m);
    expect(relay.posts).toHaveLength(1);
    expect(acq.repair).not.toBeNull();
  });
});

// ── F8 — a 429's Retry-After stops the presentation ─────────────────

describe("F8 — Retry-After", () => {
  async function manyEntries(rateLimited: { retryAfterMs?: number }) {
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.current = hex(a);
    const m = c2Machine(relay, a);
    const n = ROSTER_CHUNK_SIZE + 3;
    const entries = await Promise.all(Array.from({ length: n }, (_, i) => enrol(a, `dev-${i}`)));
    await m.cache.save({ ...emptyReplica(LEGACY_MID), enrollments: entries });
    await relay.hold(...entries);
    const acq = await acquiredOf(m);
    relay.posts = [];
    relay.rateLimited = rateLimited;
    return { m, relay, acq, n };
  }

  it("with a Retry-After, the first 429 stops further chunks; every entry is not taken, the wait is reported", async () => {
    const { m, relay, acq, n } = await manyEntries({ retryAfterMs: 30_000 });
    const report = await m.roster.present(acq);
    expect(relay.posts).toHaveLength(1);
    expect(report.retryAfterMs).toBe(30_000);
    expect(report.notTaken).toHaveLength(n);
    expect(report.taken).toBe(0);
  });

  it("without one (the CLI's port), every chunk is still sent — C-1 behaviour unchanged", async () => {
    const { m, relay, acq } = await manyEntries({});
    const report = await m.roster.present(acq);
    expect(relay.posts).toHaveLength(2);
    expect(report.retryAfterMs).toBeUndefined();
  });
});

// ── B1 custody flag helpers, F7 ──────────────────────────────────────

describe("custody flag (B1) and the rotation link (F7)", () => {
  it("custodyFlagFor derives the public key from the private key", async () => {
    const a = await generateKeypair();
    const f = await custodyFlagFor({
      motebitId: LEGACY_MID,
      privateKey: a.privateKey,
      reason: "key-transfer",
      now: NOW,
    });
    expect(f).toEqual({
      motebit_id: LEGACY_MID,
      public_key: hex(a),
      set_at: NOW,
      reason: "key-transfer",
    });
    expect(parseCustodyFlag(f)).toEqual(f);
  });

  it("parseCustodyFlag refuses anything else", () => {
    const good = { motebit_id: "m", public_key: "a".repeat(64), set_at: 1, reason: "minted" };
    expect(parseCustodyFlag(good)).toEqual(good);
    for (const bad of [
      null,
      [],
      "x",
      { ...good, motebit_id: "" },
      { ...good, public_key: "zz" },
      { ...good, set_at: "1" },
      { ...good, reason: "rotation" },
    ]) {
      expect(parseCustodyFlag(bad)).toBeNull();
    }
  });

  it("a rotation MOVES a flag naming the old key, idempotently; it never creates or redirects one", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    const record = await rotate(a, b);
    const at = { motebitId: LEGACY_MID, record, newPublicKeyHex: hex(b), now: NOW + 1 };
    const moved = custodyAfterRotation(flagFor(a), at);
    expect(moved).toEqual({ ...flagFor(a), public_key: hex(b), set_at: NOW + 1 });
    expect(custodyAfterRotation(moved, at)).toBeNull(); // already moved
    expect(custodyAfterRotation(null, at)).toBeNull(); // never created
    expect(custodyAfterRotation(flagFor(c), at)).toBeNull(); // names neither key
    expect(custodyAfterRotation(flagFor(a, "other-motebit"), at)).toBeNull();
    expect(custodyAfterRotation(flagFor(a), { ...at, newPublicKeyHex: hex(c) })).toBeNull();
  });

  it("rotationLinkReplica is the link alone, for the surface's merge-save", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const record = await rotate(a, b);
    expect(rotationLinkReplica(LEGACY_MID, record)).toEqual({
      ...emptyReplica(LEGACY_MID),
      succession: [record],
    });
  });

  it("heldKeyText covers every class", () => {
    expect(heldKeyText({ kind: "identity", basis: "rooted" })).toBeNull();
    expect(heldKeyText({ kind: "identity", basis: "on-chain" })).toBeNull();
    expect(heldKeyText({ kind: "unconfirmed", why: "no-key" })).toBeNull();
    expect(heldKeyText({ kind: "unconfirmed", why: "malformed" })).toMatch(/malformed/);
    expect(heldKeyText({ kind: "unconfirmed", why: "no-evidence" })).toMatch(
      /re-pair it with a key transfer/,
    );
  });
});

// ── F8 cadence helpers ──────────────────────────────────────────────

describe("F8 — the presentation cadence", () => {
  it("due: never before Retry-After; on a changed replica; otherwise every N", () => {
    expect(presentationDue(null, "d", NOW, 60_000)).toBe(true);
    const rec = { digest: "d", taken_at: NOW, retry_until: 0 };
    expect(presentationDue(rec, "d", NOW + 1, 60_000)).toBe(false);
    expect(presentationDue(rec, "e", NOW + 1, 60_000)).toBe(true);
    expect(presentationDue(rec, "d", NOW + 60_000, 60_000)).toBe(true);
    expect(presentationDue({ ...rec, retry_until: NOW + 10 }, "e", NOW + 1, 60_000)).toBe(false);
  });

  it("record: Retry-After defers; a full take stamps the digest; a partial take or a refusal changes nothing", async () => {
    const a = await generateKeypair();
    const replica = { ...emptyReplica(LEGACY_MID), enrollments: [await enrol(a, "d")] };
    const empty = { taken: 0, notTaken: [], rosterFull: [] };
    expect(await nextPresentationRecord(null, { ...empty, retryAfterMs: 5 }, replica, NOW)).toEqual(
      {
        digest: null,
        taken_at: 0,
        retry_until: NOW + 5,
      },
    );
    expect(await nextPresentationRecord(null, { ...empty, taken: 1 }, replica, NOW)).toEqual({
      digest: await replicaDigest(replica),
      taken_at: NOW,
      retry_until: 0,
    });
    expect(
      await nextPresentationRecord(
        null,
        { ...empty, notTaken: [{ id: "x", reason: "status 500" }] },
        replica,
        NOW,
      ),
    ).toBeNull();
    expect(await nextPresentationRecord(null, empty, null, NOW)).toBeNull();
    expect(
      await nextPresentationRecord(
        null,
        { ...empty, refused: "held-key-not-identity" },
        replica,
        NOW,
      ),
    ).toBeNull();
  });

  it("the digest changes when an entry joins, and not with order", async () => {
    const a = await generateKeypair();
    const e1 = await enrol(a, "d1");
    const e2 = await enrol(a, "d2");
    const base = emptyReplica(LEGACY_MID);
    const d12 = await replicaDigest({ ...base, enrollments: [e1, e2] });
    expect(await replicaDigest({ ...base, enrollments: [e2, e1] })).toBe(d12);
    expect(await replicaDigest({ ...base, enrollments: [e1] })).not.toBe(d12);
    expect(
      await replicaDigest({
        ...base,
        enrollments: [e1, e2],
        retirements: [await retireEntry(a, e1)],
      }),
    ).not.toBe(d12);
  });
});

// ── S6 — the section state holder ────────────────────────────────────

describe("S6 — createMachineRosterSection", () => {
  /** An identity key (legacy, the relay names it) with one of every line shape. */
  async function world() {
    const old = await generateKeypair();
    const a = await generateKeypair();
    const relay = new FakeRelay();
    relay.chain = [await rotate(old, a)];
    relay.current = hex(a);
    const retiredE = await enrol(a, "dev-retired");
    await relay.hold(
      await enrol(a, "dev-active"),
      await enrol(old, "dev-superseded"),
      retiredE,
      await retireEntry(a, retiredE),
      await enrol(a, "dev-self"),
    );
    relay.rows = [
      { device_id: "dev-row", bound_under: hex(a), last_seen_at: NOW, sockets_open: 1 },
      { device_id: "dev-row", bound_under: hex(old), last_seen_at: NOW, sockets_open: 0 },
    ];
    relay.live = [{ device_id: "dev-phone", bound_under: hex(a), sockets_open: 1 }];
    const m = c2Machine(relay, a);
    return { a, old, relay, m };
  }

  const actionsOf = (s: ReturnType<ReturnType<typeof createMachineRosterSection>["getState"]>) => {
    if (s.view?.kind !== "roster") return {};
    const out: Record<string, string[]> = {};
    s.view.lines.forEach((l, i) => {
      const a = s.lineActions[i]!;
      const names = [a.retire ? "retire" : null, a.enroll ? "enroll" : null].filter(
        (x): x is string => x != null,
      );
      out[`${l.kind}:${l.device_id}`] = [...(out[`${l.kind}:${l.device_id}`] ?? []), ...names];
    });
    return out;
  };

  it("offers Retire on machine lines, Enroll on superseded / retired / liveness rows only (F6), never on this device", async () => {
    const { m } = await world();
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await section.refresh();
    const s = section.getState();
    expect(s.phase).toBe("ready");
    expect(s.heldKey).toEqual({ kind: "identity", basis: "relay" });
    expect(s.heldKeyText).toBe("identity key per the relay");
    expect(actionsOf(s)).toEqual({
      "active:dev-active": ["retire"],
      "active:dev-self": ["retire"],
      "not-in-roster:dev-row": ["enroll"],
      "superseded-key-socket:dev-row": [],
      "not-in-roster:dev-phone": [],
      "superseded:dev-superseded": ["retire", "enroll"],
      "retired:dev-retired": ["enroll"],
    });
  });

  it("refuseOwnEnroll: false offers Enroll on this device's retired line (the desktop's shape)", async () => {
    const { a, relay, m } = await world();
    const own = [...relay.enr.values()].find((e) => e.device_id === "dev-self")!;
    await relay.hold(await retireEntry(a, own));
    const acq = await acquiredOf(m);
    const view = buildRosterView(acq, NOW);
    const refuse = rosterLineActions(acq, view, { allowed: true, refuseOwnEnroll: true });
    const allow = rosterLineActions(acq, view, { allowed: true, refuseOwnEnroll: false });
    const i = view.kind === "roster" ? view.lines.findIndex((l) => l.device_id === "dev-self") : -1;
    expect(refuse[i]).toEqual({ retire: false, enroll: false });
    expect(allow[i]).toEqual({ retire: false, enroll: true });
    expect(
      rosterLineActions(
        acq,
        { kind: "no-key", text: "" },
        { allowed: true, refuseOwnEnroll: true },
      ),
    ).toEqual([]);
  });

  it("an unconfirmed key offers no action, says why, and never presents", async () => {
    const { relay, m } = await world();
    relay.current = null;
    const present = vi.spyOn(m.roster, "present");
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await section.refresh();
    const s = section.getState();
    expect(s.heldKey).toEqual({ kind: "unconfirmed", why: "no-evidence" });
    expect(s.rosterHidden).toBe(false); // B1's stated cost: lines shown, no count
    expect(s.lineActions.every((x) => !x.retire && !x.enroll)).toBe(true);
    expect(s.heldKeyText).toMatch(/cannot confirm/);
    expect(present).not.toHaveBeenCalled();
  });

  it("a device-only key hides the roster and says why", async () => {
    const { relay } = await world();
    const device = await generateKeypair();
    const m = c2Machine(relay, device); // relay names the identity key
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await section.refresh();
    const s = section.getState();
    expect(s.heldKey).toEqual({ kind: "device-key" });
    expect(s.rosterHidden).toBe(true);
    expect(s.heldKeyText).toMatch(/linked without the identity key/);
  });

  it("a surface that cannot write offers no action and refuses an act without calling the roster", async () => {
    const { relay, m } = await world();
    const retire = vi.spyOn(m.roster, "retire");
    const section = createMachineRosterSection(m.roster, {
      deviceId: "dev-self",
      writeBlocked: () => "this browser can't lock the roster across tabs",
    });
    await section.refresh();
    expect(section.getState().writeBlocked).toMatch(/can't lock/);
    expect(section.getState().lineActions.some((x) => x.retire || x.enroll)).toBe(false);
    await section.retire("dev-active");
    expect(retire).not.toHaveBeenCalled();
    expect(section.getState().notice).toEqual({
      deviceId: "dev-active",
      text: "this browser can't lock the roster across tabs",
      tone: "error",
    });
    expect(relay.ret.size).toBe(1);
  });

  it("retire: signs, re-reads, and states the undo with its cost (F9)", async () => {
    const { relay, m } = await world();
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    const seen: string[] = [];
    const off = section.subscribe((s) => seen.push(s.phase));
    await section.retire("dev-active");
    off();
    const s = section.getState();
    expect(s.notice?.tone).toBe("done");
    expect(s.notice?.text).toMatch(
      /^Retired dev-active\. Enroll undoes it — enrolled from this surface; the machine's own next rotation won't carry it\.$/,
    );
    expect(relay.ret.size).toBe(2);
    expect(s.busy).toBeNull();
    const line =
      s.view?.kind === "roster" ? s.view.lines.find((l) => l.device_id === "dev-active") : null;
    expect(line?.kind).toBe("retired");
    expect(seen).toContain("loading");
    const n = seen.length;
    await section.refresh();
    expect(seen.length).toBe(n); // unsubscribed
  });

  it("enroll of this device's own id is refused: this device is not a host", async () => {
    const { relay, m } = await world();
    const enroll = vi.spyOn(m.roster, "enroll");
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await section.enroll("dev-self", { force: true });
    expect(enroll).not.toHaveBeenCalled();
    expect(section.getState().notice?.text).toBe("This device is not a host.");
    expect(relay.enr.size).toBe(4);
  });

  it("needs-force becomes an explicit second tap; the forced enroll enrols; cancel dismisses", async () => {
    const { relay, m } = await world();
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await section.enroll("dev-typo");
    expect(section.getState().confirmForce).toEqual({
      deviceId: "dev-typo",
      why: "no-such-line",
      text: needsForceText("no-such-line", "dev-typo"),
    });
    expect(relay.enr.size).toBe(4);
    section.cancelForce();
    expect(section.getState().confirmForce).toBeNull();
    await section.enroll("dev-typo", { force: true });
    expect(section.getState().notice?.text).toBe("Enrolled dev-typo under the current key.");
    expect(relay.enr.size).toBe(5);
  });

  it("presentation cadence: only the presenter, only when due, and the report is recorded", async () => {
    const { m } = await world();
    const present = vi.spyOn(m.roster, "present");
    let presenter = false;
    let due = false;
    const recorded: unknown[] = [];
    const cadence: PresentationCadence = {
      isPresenter: () => presenter,
      due: async () => due,
      record: async (report, replica) => {
        recorded.push([report.taken, replica != null]);
      },
    };
    const section = createMachineRosterSection(m.roster, {
      deviceId: "dev-self",
      presentation: cadence,
    });
    await section.refresh();
    expect(present).not.toHaveBeenCalled();
    presenter = true;
    await section.refresh();
    expect(present).not.toHaveBeenCalled();
    due = true;
    await section.refresh();
    expect(present).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
    // An act's own presentation is recorded for its Retry-After only.
    await section.retire("dev-active");
    expect(recorded.some((r) => (r as [number, boolean])[1] === false)).toBe(true);
  });

  it("an omission repair inside the acquisition is recorded as a presentation (its Retry-After counts)", async () => {
    const { relay, m } = await world();
    await acquiredOf(m); // the replica now holds every entry
    const [id] = [...relay.enr.keys()];
    relay.omit.add(id!);
    const recorded: Array<[number, boolean]> = [];
    const section = createMachineRosterSection(m.roster, {
      deviceId: "dev-self",
      presentation: {
        isPresenter: () => true,
        due: async () => false,
        record: async (report, replica) => {
          recorded.push([report.taken, replica != null]);
        },
      },
    });
    await section.refresh();
    expect(recorded).toEqual([[1, false]]);
  });

  it("without a cadence, every refresh presents (S4: whenever it connects)", async () => {
    const { m } = await world();
    const present = vi.spyOn(m.roster, "present");
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await section.refresh();
    await section.refresh();
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("concurrent refreshes share one acquisition; a second act while busy is dropped", async () => {
    const { m } = await world();
    const acquire = vi.spyOn(m.roster, "acquire");
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await Promise.all([section.refresh(), section.refresh()]);
    expect(acquire).toHaveBeenCalledTimes(1);
    const retire = vi.spyOn(m.roster, "retire");
    await Promise.all([section.retire("dev-active"), section.retire("dev-self")]);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("a refresh that throws is shown inline; an act that throws is a notice", async () => {
    const { m } = await world();
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    vi.spyOn(m.roster, "acquire").mockRejectedValueOnce(new Error("idb gone"));
    await section.refresh();
    expect(section.getState().error).toBe("idb gone");
    vi.spyOn(m.roster, "retire").mockRejectedValueOnce("boom");
    await section.retire("dev-active");
    expect(section.getState().notice).toEqual({
      deviceId: "dev-active",
      text: "boom",
      tone: "error",
    });
  });

  it("no key and a refused chain render their views with no actions", async () => {
    const relay = new FakeRelay();
    const none = c2Machine(relay, null);
    const s1 = createMachineRosterSection(none.roster, { deviceId: "dev-self" });
    await s1.refresh();
    expect(s1.getState().view?.kind).toBe("no-key");
    expect(s1.getState().heldKey).toEqual({ kind: "unconfirmed", why: "no-key" });
    const a = await generateKeypair();
    const b = await generateKeypair();
    relay.chain = [await rotate(a, b)];
    const s2 = createMachineRosterSection(c2Machine(relay, a).roster, { deviceId: "dev-self" });
    await s2.refresh();
    expect(s2.getState().view?.kind).toBe("no-roster");
    expect(s2.getState().lineActions).toEqual([]);
  });

  it("an ungated roster handed to the section is treated as unconfirmed (fail-closed)", async () => {
    const { relay } = await world();
    const m = c2Machine(relay, (await generateKeypair()) as KeyPair, { gated: false });
    const section = createMachineRosterSection(m.roster, { deviceId: "dev-self" });
    await section.refresh();
    expect(section.getState().heldKey).toEqual({ kind: "unconfirmed", why: "no-evidence" });
    void MachineRoster;
  });
});

describe("notices — every outcome has words", () => {
  const presented = { taken: 1, notTaken: [], rosterFull: [] };
  it("retire", () => {
    expect(retireNotice({ kind: "no-key" }).text).toMatch(/no identity key/);
    expect(
      retireNotice({ kind: "refused", reason: "fork_at_held", detail: "", remedy: "rotate" }).text,
    ).toMatch(/no roster/);
    expect(retireNotice({ kind: "unreadable", detail: "relay down" }).text).toBe(
      "Nothing was signed: relay down.",
    );
    expect(
      retireNotice({ kind: "held-key-not-identity", heldKey: { kind: "device-key" } }).text,
    ).toMatch(/linked without the identity key/);
    expect(
      retireNotice({
        kind: "held-key-not-identity",
        heldKey: { kind: "unconfirmed", why: "no-key" },
      }).text,
    ).toMatch(/not confirmed as the identity key/);
    expect(
      retireNotice({
        kind: "retired",
        deviceId: "d",
        retirementIds: ["r"],
        advisory: true,
        presented: { ...presented, notTaken: [{ id: "r", reason: "x" }] },
      }).text,
    ).toMatch(/Advisory: .*Not yet taken/);
    expect(
      retireNotice({
        kind: "retired",
        deviceId: "d",
        retirementIds: ["r"],
        advisory: false,
        presented: { ...presented, retryAfterMs: 5 },
      }).text,
    ).toMatch(/asked to wait/);
    expect(
      retireNotice({
        kind: "retired",
        deviceId: "d",
        retirementIds: ["r"],
        advisory: false,
        presented: { ...presented, rosterFull: ["r"] },
      }).text,
    ).toMatch(/1 entry permanently/);
    expect(retireNotice({ kind: "already-retired", deviceId: "d" }).tone).toBe("done");
    expect(retireNotice({ kind: "not-enrolled", deviceId: "d", socketOpen: true }).text).toMatch(
      /socket is open/,
    );
    expect(retireNotice({ kind: "not-enrolled", deviceId: "d", socketOpen: false }).text).toMatch(
      /has seen it/,
    );
    expect(retireNotice({ kind: "unplaced-lines", deviceId: "d", count: 2 }).text).toMatch(
      /2 enrolments/,
    );
    expect(retireNotice({ kind: "unknown-device", deviceId: "d" }).text).toMatch(/No machine d/);
  });

  it("enroll", () => {
    expect(enrollNotice({ kind: "no-key" }).tone).toBe("error");
    expect(enrollNotice({ kind: "already-active", deviceId: "d" }).tone).toBe("done");
    expect(enrollNotice({ kind: "needs-force", deviceId: "d", why: "linked-device" }).text).toMatch(
      /linked device's key/,
    );
    expect(needsForceText("unplaced-lines", "d")).toMatch(/cannot place/);
    expect(needsForceText("all-superseded", "d", "ab".repeat(32))).toMatch(/abababab/);
    expect(needsForceText("all-superseded", "d")).not.toMatch(/\(/);
  });
});

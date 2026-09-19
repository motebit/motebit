/**
 * The machine roster's two artifacts and the one reduction over them.
 *
 * Each test is a sentence from `docs/doctrine/machine-roster.md`. The
 * roster is a SET of self-verifying entries, so what matters is what
 * survives union, reordering, replay and a key the consumer never
 * agreed to trust.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signHostEnrollment,
  verifyHostEnrollment,
  signHostRetirement,
  verifyHostRetirement,
  hostEnrollmentId,
  hostRetirementId,
  verifyHostRoster,
  canonicalJson,
  toBase64Url,
} from "../index.js";
import { signBySuite } from "../suite-dispatch.js";
import fc from "fast-check";
import { isHostEnrollment, isHostRetirement } from "@motebit/protocol";
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";

const MOTEBIT = "019d903f-13de-75a4-8341-58319e0a2f16";

async function setupWithKey() {
  return { kp: await generateKeypair() };
}

async function setup() {
  const kp = await generateKeypair();
  const pub = bytesToHex(kp.publicKey);
  const enrol = (deviceId: string, at = 1_000) =>
    signHostEnrollment(
      { motebit_id: MOTEBIT, device_id: deviceId, public_key: pub, enrolled_at: at },
      kp.privateKey,
    );
  const retire = async (e: HostEnrollment, at = 2_000) =>
    signHostRetirement(
      {
        motebit_id: MOTEBIT,
        enrollment_id: await hostEnrollmentId(e),
        public_key: pub,
        retired_at: at,
      },
      kp.privateKey,
    );
  return { kp, pub, enrol, retire };
}

describe("HostEnrollment", () => {
  it("verifies, and any changed field does not", async () => {
    const { enrol } = await setup();
    const e = await enrol("laptop");
    expect(await verifyHostEnrollment(e)).toBe(true);
    for (const tampered of [
      { ...e, device_id: "vps" },
      { ...e, motebit_id: "someone-else" },
      { ...e, enrolled_at: e.enrolled_at + 1 },
    ]) {
      expect(await verifyHostEnrollment(tampered)).toBe(false);
    }
  });

  it("is refused under a key that did not sign it — the artifact names its signer", async () => {
    const { enrol } = await setup();
    const other = await generateKeypair();
    const e = await enrol("laptop");
    expect(await verifyHostEnrollment({ ...e, public_key: bytesToHex(other.publicKey) })).toBe(
      false,
    );
  });

  it("fails closed on an unknown suite or a malformed key", async () => {
    const { enrol } = await setup();
    const e = await enrol("laptop");
    // Signed VALIDLY over a suite this verifier does not know. Editing
    // `suite` after signing proves nothing — the signature breaks first,
    // and the suite check is never what refused it. Agility means the
    // declared suite decides how to verify, so an unknown one must be
    // refused even when every byte is authentic.
    const { kp } = await setupWithKey();
    const body = {
      motebit_id: MOTEBIT,
      device_id: "laptop",
      public_key: bytesToHex(kp.publicKey),
      enrolled_at: 1_000,
      suite: "motebit-future-suite-v9",
    };
    const sig = await signBySuite(
      "motebit-jcs-ed25519-b64-v1",
      new TextEncoder().encode(canonicalJson(body)),
      kp.privateKey,
    );
    const authenticButUnknown = {
      ...body,
      signature: toBase64Url(sig),
    } as unknown as HostEnrollment;
    expect(await verifyHostEnrollment(authenticButUnknown)).toBe(false);
    expect(await verifyHostEnrollment({ ...e, public_key: "zz" })).toBe(false);
    expect(await verifyHostEnrollment({ ...e, signature: "!!!" })).toBe(false);
  });

  it("refuses a float or negative time, an unknown field, and a non-base64url signature", async () => {
    // Integrity verification is as strict as the wire schema. Every field
    // but `signature` is signed, so an extra one WOULD verify — and then
    // this verifier admits a machine a schema-validating store refuses.
    const { kp, pub } = await setup();
    const resign = (body: Record<string, unknown>) =>
      signBySuite(
        "motebit-jcs-ed25519-b64-v1",
        new TextEncoder().encode(canonicalJson(body)),
        kp.privateKey,
      ).then((sig) => ({ ...body, signature: toBase64Url(sig) }) as unknown as HostEnrollment);
    const base = {
      motebit_id: MOTEBIT,
      device_id: "laptop",
      public_key: pub,
      enrolled_at: 1_000,
      suite: "motebit-jcs-ed25519-b64-v1",
    };
    expect(await verifyHostEnrollment(await resign(base))).toBe(true);
    // Each of these is AUTHENTICALLY signed. It is the shape that is refused.
    expect(await verifyHostEnrollment(await resign({ ...base, enrolled_at: 1000.5 }))).toBe(false);
    expect(await verifyHostEnrollment(await resign({ ...base, enrolled_at: -1 }))).toBe(false);
    expect(await verifyHostEnrollment(await resign({ ...base, enrolled_at: 1.7e21 }))).toBe(false);
    expect(await verifyHostEnrollment(await resign({ ...base, hosts: ["run"] }))).toBe(false);
    expect(await verifyHostEnrollment(await resign({ ...base, device_name: "x" }))).toBe(false);
    const good = await resign(base);
    expect(await verifyHostEnrollment({ ...good, signature: `${good.signature}==` })).toBe(false);
  });

  it("has ONE id for the same bytes — re-presenting on every start adds nothing", async () => {
    // Auto-enrol presents the same stored artifact each time a daemon
    // starts. If the id moved, the set would grow with every reboot.
    const { enrol } = await setup();
    const a = await enrol("laptop");
    const again = await enrol("laptop");
    expect(await hostEnrollmentId(a)).toBe(await hostEnrollmentId(again));
    expect(await hostEnrollmentId(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hostEnrollmentId(a)).not.toBe(await hostEnrollmentId(await enrol("vps")));
  });
});

describe("HostRetirement", () => {
  it("verifies, names the entry it ends, and does not survive tampering", async () => {
    const { enrol, retire } = await setup();
    const e = await enrol("vps");
    const r = await retire(e);
    expect(r.enrollment_id).toBe(await hostEnrollmentId(e));
    expect(await verifyHostRetirement(r)).toBe(true);
    expect(await verifyHostRetirement({ ...r, enrollment_id: "0".repeat(64) })).toBe(false);
  });
});

describe("hostRetirementId", () => {
  it("is stable for the same retirement and distinct from the entry it ends", async () => {
    // A store keys retirements by this; presenting one twice must be a no-op.
    const { enrol, retire } = await setup();
    const e = await enrol("vps");
    const r = await retire(e);
    expect(await hostRetirementId(r)).toBe(await hostRetirementId(await retire(e)));
    expect(await hostRetirementId(r)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hostRetirementId(r)).not.toBe(r.enrollment_id);
    expect(await hostRetirementId(r)).not.toBe(await hostRetirementId(await retire(e, 9_999)));
  });
});

/** Every spelling `atob` would take for the same 64 signature bytes. */
function respellings(sig: string): string[] {
  const std = sig.replace(/-/g, "+").replace(/_/g, "/");
  return [`${sig}==`, `${sig} `, std, `${std}==`];
}

const devices = (ms: Array<{ device_id: string }>) => ms.map((m) => m.device_id);

describe("the entry id is over the SIGNED BODY", () => {
  it("does not move when the signature is re-spelled — so removal stays terminal", async () => {
    // The signature's spelling is the one part of an artifact nothing
    // signs. Hashing it let anyone holding a copy, with no key at all,
    // turn a RETIRED enrolment into a new id that still verified — and
    // the machine was back in "every machine".
    const { pub, enrol, retire } = await setup();
    const vps = await enrol("vps");
    const gone = await retire(vps);
    for (const spelling of respellings(vps.signature)) {
      const copy = { ...vps, signature: spelling };
      expect(await hostEnrollmentId(copy)).toBe(await hostEnrollmentId(vps));
      const verdict = await verifyHostRoster({
        motebitId: MOTEBIT,
        trustedKeys: [pub],
        enrollments: [copy],
        retirements: [gone],
      });
      expect(verdict.active).toEqual([]);
    }
  });

  it("two VALID spellings of one signature are one entry, with one representative", async () => {
    // The last base64url character of a 64-byte signature carries four
    // unused bits. Setting them is still unpadded base64url, still
    // decodes to the same bytes, still verifies. Which copy represents
    // the entry must not depend on which arrived first.
    const { pub, enrol } = await setup();
    const laptop = await enrol("laptop");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = laptop.signature.slice(-1);
    const twin = {
      ...laptop,
      signature: laptop.signature.slice(0, -1) + alphabet[alphabet.indexOf(last) | 1]!,
    };
    const flipped = twin.signature !== laptop.signature;
    expect(await verifyHostEnrollment(twin)).toBe(true);
    const run = (enrollments: HostEnrollment[]) =>
      verifyHostRoster({ motebitId: MOTEBIT, trustedKeys: [pub], enrollments, retirements: [] });
    const ab = await run([laptop, twin]);
    expect(await run([twin, laptop])).toEqual(ab);
    expect(ab.active).toHaveLength(1);
    expect(ab.active[0]?.entries).toHaveLength(1);
    // (If the low bit was already set the twin IS the original — still one entry.)
    expect(flipped || twin.signature === laptop.signature).toBe(true);
  });

  it("a garbage copy of an entry cannot evict the good one, whichever arrives first", async () => {
    const { pub, enrol } = await setup();
    const laptop = await enrol("laptop");
    const garbage = { ...laptop, signature: "AAAA" };
    for (const enrollments of [
      [laptop, garbage],
      [garbage, laptop],
    ]) {
      const verdict = await verifyHostRoster({
        motebitId: MOTEBIT,
        trustedKeys: [pub],
        enrollments,
        retirements: [],
      });
      expect(devices(verdict.active)).toEqual(["laptop"]);
      expect(verdict.active[0]?.entries[0]?.enrollment.signature).toBe(laptop.signature);
    }
  });
});

describe("verifyHostRoster — the set, reduced", () => {
  it("is every machine with an enrolment no retirement ends", async () => {
    const { pub, enrol, retire } = await setup();
    const laptop = await enrol("laptop");
    const vps = await enrol("vps");
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [laptop, vps],
      retirements: [await retire(vps)],
    });
    expect(devices(verdict.active)).toEqual(["laptop"]);
    expect(devices(verdict.retired)).toEqual(["vps"]);
    expect(verdict.rejected).toEqual([]);
  });

  it("remove wins, and a replayed enrolment cannot resurrect it", async () => {
    const { pub, enrol, retire } = await setup();
    const vps = await enrol("vps");
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [vps, vps, await enrol("vps")],
      retirements: [await retire(vps)],
    });
    expect(verdict.active).toEqual([]);
    expect(devices(verdict.retired)).toEqual(["vps"]);
  });

  it("a retirement may arrive BEFORE the enrolment it names — union has no order", async () => {
    const { pub, enrol, retire } = await setup();
    const vps = await enrol("vps");
    const tombstone = await retire(vps);
    const early = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [],
      retirements: [tombstone],
    });
    expect(early.tombstones).toEqual([{ enrollment_id: tombstone.enrollment_id, scope: "any" }]);
    const late = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [vps],
      retirements: [tombstone],
    });
    expect(late.active).toEqual([]);
  });

  it("counts MACHINES — two enrolments for one machine are one member", async () => {
    // A daemon that lost its cached artifact mints a new enrolment with
    // a fresh time: a new id, the same machine. Counting entries would
    // count it twice in every "N machines" — and retiring the one entry
    // a person can see would leave the machine in "every machine".
    const { pub, enrol, retire } = await setup();
    const first = await enrol("vps", 1_000);
    const second = await enrol("vps", 9_000);
    const both = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [first, second],
      retirements: [],
    });
    expect(devices(both.active)).toEqual(["vps"]);
    expect(both.active[0]?.entries).toHaveLength(2);

    const oneGone = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [first, second],
      retirements: [await retire(first)],
    });
    // Still a member — and the verdict says exactly which entry is
    // keeping it one, so a surface can finish the job.
    expect(devices(oneGone.active)).toEqual(["vps"]);
    expect(oneGone.active[0]?.entries.map((e) => e.enrollment_id)).toEqual([
      await hostEnrollmentId(second),
    ]);

    const allGone = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [first, second],
      retirements: [await retire(first), await retire(second)],
    });
    expect(allGone.active).toEqual([]);
    expect(devices(allGone.retired)).toEqual(["vps"]);
  });

  it("verifies against keys the CONSUMER trusts — never the key an entry brings with it", async () => {
    const { pub, enrol } = await setup();
    const stranger = await generateKeypair();
    const strangerPub = bytesToHex(stranger.publicKey);
    const forged = await signHostEnrollment(
      {
        motebit_id: MOTEBIT,
        device_id: "attacker-box",
        public_key: strangerPub,
        enrolled_at: 1_000,
      },
      stranger.privateKey,
    );
    expect(await verifyHostEnrollment(forged)).toBe(true); // internally valid
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [await enrol("laptop"), forged],
      retirements: [],
    });
    expect(devices(verdict.active)).toEqual(["laptop"]);
    // Traceable: WHICH entry, under WHICH key.
    expect(verdict.rejected).toEqual([
      {
        kind: "enrollment",
        id: await hostEnrollmentId(forged),
        public_key: strangerPub,
        reason: "untrusted_key",
      },
    ]);
  });

  it("a stranger cannot retire a machine either", async () => {
    const { pub, enrol } = await setup();
    const stranger = await generateKeypair();
    const laptop = await enrol("laptop");
    const forged = await signHostRetirement(
      {
        motebit_id: MOTEBIT,
        enrollment_id: await hostEnrollmentId(laptop),
        public_key: bytesToHex(stranger.publicKey),
        retired_at: 2_000,
      },
      stranger.privateKey,
    );
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [laptop],
      retirements: [forged],
    });
    expect(devices(verdict.active)).toEqual(["laptop"]);
    expect(verdict.rejected.map((r) => [r.kind, r.reason])).toEqual([
      ["retirement", "untrusted_key"],
    ]);
    expect(verdict.tombstones).toEqual([]);
  });

  it("refuses an entry for another motebit, and one that does not verify", async () => {
    const { pub, kp, enrol } = await setup();
    const elsewhere = await signHostEnrollment(
      { motebit_id: "another-motebit", device_id: "x", public_key: pub, enrolled_at: 1 },
      kp.privateKey,
    );
    const broken = { ...(await enrol("laptop")), device_id: "edited" };
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [elsewhere, broken],
      retirements: [],
    });
    expect(verdict.active).toEqual([]);
    expect(verdict.rejected.map((r) => r.reason).sort()).toEqual([
      "bad_signature",
      "wrong_motebit",
    ]);
  });

  it("reports each refusal ONCE, in one order, however the inputs arrive", async () => {
    // `rejected` was pushed in input order with no identifier: the same
    // set from two replicas deep-compared unequal, and "untrusted_key x3"
    // could not be traced to an entry.
    const { pub, enrol } = await setup();
    const stranger = await generateKeypair();
    const forged = await signHostEnrollment(
      {
        motebit_id: MOTEBIT,
        device_id: "x",
        public_key: bytesToHex(stranger.publicKey),
        enrolled_at: 1,
      },
      stranger.privateKey,
    );
    const broken = { ...(await enrol("laptop")), device_id: "edited" };
    const junk = { nonsense: true } as unknown as HostEnrollment;
    const run = (enrollments: HostEnrollment[]) =>
      verifyHostRoster({ motebitId: MOTEBIT, trustedKeys: [pub], enrollments, retirements: [] });
    const a = await run([forged, broken, junk]);
    const b = await run([junk, junk, broken, forged, forged, broken]);
    expect(b).toEqual(a);
    expect(a.rejected).toHaveLength(3);
  });

  it("with no trusted key, trusts nothing", async () => {
    const { enrol } = await setup();
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [],
      enrollments: [await enrol("laptop")],
      retirements: [],
    });
    expect(verdict.active).toEqual([]);
  });
});

describe("rotation is a membership epoch", () => {
  async function rotated() {
    const old = await setup();
    const fresh = await generateKeypair();
    const freshPub = bytesToHex(fresh.publicKey);
    const enrolNew = (deviceId: string) =>
      signHostEnrollment(
        { motebit_id: MOTEBIT, device_id: deviceId, public_key: freshPub, enrolled_at: 5_000 },
        fresh.privateKey,
      );
    const retireNew = async (e: HostEnrollment) =>
      signHostRetirement(
        {
          motebit_id: MOTEBIT,
          enrollment_id: await hostEnrollmentId(e),
          public_key: freshPub,
          retired_at: 6_000,
        },
        fresh.privateKey,
      );
    const reduce = (enrollments: HostEnrollment[], retirements: HostRetirement[]) =>
      verifyHostRoster({
        motebitId: MOTEBIT,
        trustedKeys: [freshPub],
        supersededKeys: [old.pub],
        enrollments,
        retirements,
      });
    return { old, enrolNew, retireNew, reduce };
  }

  it("the machine nobody re-enrolled is SHOWN as cut off; the one that moved epochs is not", async () => {
    const { old, enrolNew, reduce } = await rotated();
    const verdict = await reduce(
      [await old.enrol("lost-vps"), await old.enrol("laptop"), await enrolNew("laptop")],
      [],
    );
    expect(devices(verdict.active)).toEqual(["laptop"]);
    expect(devices(verdict.superseded)).toEqual(["lost-vps"]);
  });

  it("does NOT un-retire what was retired before it", async () => {
    // Retirements were honoured only under a current key, so rotating
    // turned every earlier retirement into `untrusted_key` and its
    // machine came back as "cut off but running".
    const { old, reduce } = await rotated();
    const vps = await old.enrol("vps");
    const verdict = await reduce([vps], [await old.retire(vps)]);
    expect(devices(verdict.retired)).toEqual(["vps"]);
    expect(verdict.superseded).toEqual([]);
    expect(verdict.rejected).toEqual([]);
    expect(verdict.tombstones).toEqual([
      { enrollment_id: await hostEnrollmentId(vps), scope: "superseded_only" },
    ]);
  });

  it("a SUPERSEDED key cannot retire a current machine", async () => {
    // After rotation the old key may be in the hands of whoever took the
    // machine. It must not be able to strike the sovereign's other
    // machines out of "every machine" before a halt.
    const { old, enrolNew, reduce } = await rotated();
    const laptop = await enrolNew("laptop");
    const strike = await signHostRetirement(
      {
        motebit_id: MOTEBIT,
        enrollment_id: await hostEnrollmentId(laptop),
        public_key: old.pub,
        retired_at: 7_000,
      },
      old.kp.privateKey,
    );
    const verdict = await reduce([laptop], [strike]);
    expect(devices(verdict.active)).toEqual(["laptop"]);
    expect(verdict.retired).toEqual([]);
  });

  it("a current-key retirement outranks an old-key one for the same entry, in either order", async () => {
    const { old, retireNew, reduce } = await rotated();
    const vps = await old.enrol("vps");
    const weak = await old.retire(vps);
    const strong = await retireNew(vps);
    for (const rs of [
      [weak, strong],
      [strong, weak],
    ]) {
      expect((await reduce([vps], rs)).tombstones).toEqual([
        { enrollment_id: await hostEnrollmentId(vps), scope: "any" },
      ]);
    }
  });

  it("a machine retired under the NEW key does not come back as cut off through its old line", async () => {
    // It received the new key and was explicitly let go. Its old-key
    // enrolment has no tombstone of its own, and used to resurface it as
    // "the machine that did not receive the new key".
    const { old, enrolNew, retireNew, reduce } = await rotated();
    const vpsNew = await enrolNew("vps");
    const verdict = await reduce([await old.enrol("vps"), vpsNew], [await retireNew(vpsNew)]);
    expect(devices(verdict.retired)).toEqual(["vps"]);
    expect(verdict.superseded).toEqual([]);
    expect(verdict.active).toEqual([]);
  });
});

describe("the guards in @motebit/protocol and here are one law, stated twice", () => {
  // `@motebit/crypto` keeps zero runtime monorepo deps, so its shape
  // checks are restated rather than imported. Two copies drift; this
  // pins them to one table.
  it("agree on every row — each one AUTHENTICALLY signed, so shape alone decides", async () => {
    // Rows that merely edit a signed artifact prove nothing here: the
    // signature breaks first, crypto says no for the wrong reason, and
    // the two "agree" by accident. Every row below is re-signed over
    // exactly the body it carries.
    const { kp, pub } = await setup();
    const sign = async (body: Record<string, unknown>) => {
      const sig = await signBySuite(
        "motebit-jcs-ed25519-b64-v1",
        new TextEncoder().encode(canonicalJson(body)),
        kp.privateKey,
      );
      return { ...body, signature: toBase64Url(sig) };
    };
    const e = {
      motebit_id: MOTEBIT,
      device_id: "laptop",
      public_key: pub,
      enrolled_at: 1_000,
      suite: "motebit-jcs-ed25519-b64-v1",
    };
    const r = {
      motebit_id: MOTEBIT,
      enrollment_id: "cd".repeat(32),
      public_key: pub,
      retired_at: 2_000,
      suite: "motebit-jcs-ed25519-b64-v1",
    };
    const rows: Array<[string, Record<string, unknown>]> = [
      ["a good enrolment", e],
      ["a good retirement", r],
      ["enrolment + extra field", { ...e, hosts: [] }],
      ["retirement + extra field", { ...r, reason: "lost" }],
      ["enrolment, float time", { ...e, enrolled_at: 1.5 }],
      ["retirement, negative time", { ...r, retired_at: -1 }],
      ["enrolment, unsafe integer", { ...e, enrolled_at: 2 ** 60 }],
      ["enrolment, empty device", { ...e, device_id: "" }],
      ["enrolment, empty motebit", { ...e, motebit_id: "" }],
      ["retirement, short enrollment_id", { ...r, enrollment_id: "abc" }],
      ["retirement, uppercase enrollment_id", { ...r, enrollment_id: "CD".repeat(32) }],
    ];
    let disagreements = 0;
    for (const [label, body] of rows) {
      const value = await sign(body);
      const protocolSays = isHostEnrollment(value) || isHostRetirement(value);
      const cryptoSays =
        (await verifyHostEnrollment(value as unknown as HostEnrollment)) ||
        (await verifyHostRetirement(value as unknown as HostRetirement));
      if (protocolSays !== cryptoSays) disagreements++;
      expect([label, cryptoSays]).toEqual([label, protocolSays]);
    }
    expect(disagreements).toBe(0);
    // And the table is not vacuous: it contains both verdicts.
    expect(await verifyHostEnrollment((await sign(e)) as unknown as HostEnrollment)).toBe(true);
    expect(isHostEnrollment(await sign({ ...e, hosts: [] }))).toBe(false);
  });
});

describe("properties — the claims that are universal, checked as such", () => {
  it("the WHOLE verdict is independent of input order and multiplicity", async () => {
    const old = await setup();
    const fresh = await generateKeypair();
    const freshPub = bytesToHex(fresh.publicKey);
    const stranger = await generateKeypair();
    const mk = (kp: typeof fresh, pub: string, d: string, at: number) =>
      signHostEnrollment(
        { motebit_id: MOTEBIT, device_id: d, public_key: pub, enrolled_at: at },
        kp.privateKey,
      );
    const es: HostEnrollment[] = [
      await old.enrol("a"),
      await old.enrol("b"),
      await mk(fresh, freshPub, "a", 5),
      await mk(fresh, freshPub, "c", 5),
      await mk(fresh, freshPub, "c", 6),
      await mk(stranger, bytesToHex(stranger.publicKey), "z", 1),
      { nonsense: 1 } as unknown as HostEnrollment,
    ];
    es.push({ ...es[2]!, signature: `${es[2]!.signature}` }, { ...es[3]!, signature: "AAAA" });
    const rs: HostRetirement[] = [
      await old.retire(es[1]!),
      await old.retire(es[3]!), // old key striking a current entry: no effect
      await signHostRetirement(
        {
          motebit_id: MOTEBIT,
          enrollment_id: await hostEnrollmentId(es[4]!),
          public_key: freshPub,
          retired_at: 9,
        },
        fresh.privateKey,
      ),
    ];
    const reduce = (enrollments: HostEnrollment[], retirements: HostRetirement[]) =>
      verifyHostRoster({
        motebitId: MOTEBIT,
        trustedKeys: [freshPub],
        supersededKeys: [old.pub],
        enrollments,
        retirements,
      });
    const canonical = await reduce(es, rs);

    await fc.assert(
      fc.asyncProperty(
        // Any reordering of the full set...
        fc.shuffledSubarray(es, { minLength: es.length }),
        fc.shuffledSubarray(rs, { minLength: rs.length }),
        // ...with any duplicates mixed in, anywhere.
        fc.shuffledSubarray([...es, ...es]),
        fc.shuffledSubarray([...rs, ...rs]),
        async (e, r, extraE, extraR) => {
          expect(await reduce([...extraE, ...e], [...r, ...extraR])).toEqual(canonical);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("every admissible machine lands in EXACTLY one bucket, for any subset of the set", async () => {
    const old = await setup();
    const fresh = await generateKeypair();
    const freshPub = bytesToHex(fresh.publicKey);
    const mk = (d: string, at: number) =>
      signHostEnrollment(
        { motebit_id: MOTEBIT, device_id: d, public_key: freshPub, enrolled_at: at },
        fresh.privateKey,
      );
    const es = [
      await old.enrol("a"),
      await old.enrol("b"),
      await mk("a", 1),
      await mk("b", 1),
      await mk("c", 1),
      await mk("c", 2),
    ];
    const rs: HostRetirement[] = [];
    for (const e of es) {
      rs.push(await old.retire(e));
      rs.push(
        await signHostRetirement(
          {
            motebit_id: MOTEBIT,
            enrollment_id: await hostEnrollmentId(e),
            public_key: freshPub,
            retired_at: 3,
          },
          fresh.privateKey,
        ),
      );
    }
    await fc.assert(
      fc.asyncProperty(fc.subarray(es), fc.subarray(rs), async (e, r) => {
        const v = await verifyHostRoster({
          motebitId: MOTEBIT,
          trustedKeys: [freshPub],
          supersededKeys: [old.pub],
          enrollments: e,
          retirements: r,
        });
        const placed = [...v.active, ...v.retired, ...v.superseded].map((m) => m.device_id);
        expect(placed.slice().sort()).toEqual([...new Set(e.map((x) => x.device_id))].sort());
        expect(new Set(placed).size).toBe(placed.length);
        // An active machine's listed entries are all standing, under the current key.
        for (const m of v.active) {
          for (const entry of m.entries) expect(entry.enrollment.public_key).toBe(freshPub);
        }
      }),
      { numRuns: 60 },
    );
  });
});

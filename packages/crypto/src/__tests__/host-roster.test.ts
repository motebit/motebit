/**
 * The machine roster's two artifacts, and named scenarios for the
 * reduction.
 *
 * The UNIVERSAL claims live in `host-roster-properties.test.ts`. This
 * file is the stories: each scenario below is a defect that was actually
 * found — by a code-review round on the first draft, or by the design
 * review of the second — written so that a regression reads as the story
 * it breaks.
 *
 * One rule governs every test that is not about signatures: to exercise
 * a validation rule, build the body you want and SIGN IT AUTHENTICALLY.
 * Editing a signed artifact proves nothing — the signature breaks first,
 * and the rule under test is never what said no. Three tests in the first
 * draft "covered" a rule that way and stayed green when it was deleted.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  canonicalJson,
  toBase64Url,
  signHostEnrollment,
  verifyHostEnrollment,
  signHostRetirement,
  verifyHostRetirement,
  hostEnrollmentId,
  hostRetirementId,
  verifyHostRoster,
} from "../index.js";
import type { HostRosterMachine, HostRosterResult, HostRosterVerdict } from "../index.js";
import { signBySuite } from "../suite-dispatch.js";
import { isHostEnrollment, isHostRetirement } from "@motebit/protocol";
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";

const MOTEBIT = "019d903f-13de-75a4-8341-58319e0a2f16";
const SUITE = "motebit-jcs-ed25519-b64-v1";

/** One identity key, able to enrol and retire. */
async function key() {
  const kp = await generateKeypair();
  const pub = bytesToHex(kp.publicKey);
  return {
    kp,
    pub,
    enrol: (device_id: string, enrolled_at = 1_000) =>
      signHostEnrollment(
        { motebit_id: MOTEBIT, device_id, public_key: pub, enrolled_at },
        kp.privateKey,
      ),
    retire: async (e: HostEnrollment, retired_at = 2_000) =>
      signHostRetirement(
        {
          motebit_id: MOTEBIT,
          enrollment_id: await hostEnrollmentId(e),
          public_key: pub,
          retired_at,
        },
        kp.privateKey,
      ),
    /** Sign ANY body authentically — the only honest way to test a shape rule. */
    signRaw: async (body: Record<string, unknown>) => {
      const sig = await signBySuite(
        SUITE,
        new TextEncoder().encode(canonicalJson(body)),
        kp.privateKey,
      );
      return { ...body, signature: toBase64Url(sig) };
    },
  };
}

function ok(result: HostRosterResult): HostRosterVerdict {
  if (!result.ok) throw new Error(`expected a roster, got ${result.reason}`);
  return result;
}

const reduce = async (
  keyChain: string[],
  enrollments: HostEnrollment[],
  retirements: HostRetirement[] = [],
) => ok(await verifyHostRoster({ motebitId: MOTEBIT, keyChain, enrollments, retirements }));

const devices = (ms: HostRosterMachine[]) => ms.map((m) => m.device_id);

describe("the artifacts", () => {
  it("carry a signed domain tag, and verify", async () => {
    const k = await key();
    const e = await k.enrol("laptop");
    const r = await k.retire(e);
    expect(e.type).toBe("motebit/host-enrollment@1");
    expect(r.type).toBe("motebit/host-retirement@1");
    expect(await verifyHostEnrollment(e)).toBe(true);
    expect(await verifyHostRetirement(r)).toBe(true);
    expect(r.enrollment_id).toBe(await hostEnrollmentId(e));
  });

  it("do not survive a changed field, or the wrong signer", async () => {
    const k = await key();
    const other = await key();
    const e = await k.enrol("laptop");
    for (const tampered of [
      { ...e, device_id: "vps" },
      { ...e, motebit_id: "someone-else" },
      { ...e, enrolled_at: e.enrolled_at + 1 },
      { ...e, public_key: other.pub },
    ]) {
      expect(await verifyHostEnrollment(tampered)).toBe(false);
    }
    const r = await k.retire(e);
    expect(await verifyHostRetirement({ ...r, enrollment_id: "0".repeat(64) })).toBe(false);
  });

  it("are not interchangeable with a device self-registration — the tag is what separates them", async () => {
    // Without `type`, a HostEnrollment and a device self-registration are
    // one suite over {motebit_id, device_id, public_key, <a time>, suite}:
    // separated by a single field NAME. An authentic registration-shaped
    // body must not verify as an enrolment, and an enrolment carrying the
    // retirement's tag must not verify as either.
    const k = await key();
    const base = { motebit_id: MOTEBIT, device_id: "laptop", public_key: k.pub, suite: SUITE };
    const registrationShaped = await k.signRaw({ ...base, timestamp: 1_000 });
    const untagged = await k.signRaw({ ...base, enrolled_at: 1_000 });
    const crossTagged = await k.signRaw({
      ...base,
      enrolled_at: 1_000,
      type: "motebit/host-retirement@1",
    });
    const nextMajor = await k.signRaw({
      ...base,
      enrolled_at: 1_000,
      type: "motebit/host-enrollment@2",
    });
    for (const v of [registrationShaped, untagged, crossTagged, nextMajor]) {
      expect(await verifyHostEnrollment(v as unknown as HostEnrollment)).toBe(false);
      expect(await verifyHostRetirement(v as unknown as HostRetirement)).toBe(false);
    }
  });

  it("are refused on SHAPE even when every byte is authentic", async () => {
    // As strict as the wire schema. Every field but `signature` is signed,
    // so an extra one WOULD verify — and then this verifier admits a
    // machine that a schema-validating store refuses.
    const k = await key();
    const good = {
      type: "motebit/host-enrollment@1",
      motebit_id: MOTEBIT,
      device_id: "laptop",
      public_key: k.pub,
      enrolled_at: 1_000,
      suite: SUITE,
    };
    const v = async (body: Record<string, unknown>) =>
      verifyHostEnrollment((await k.signRaw(body)) as unknown as HostEnrollment);
    expect(await v(good)).toBe(true);
    expect(await v({ ...good, enrolled_at: 1000.5 })).toBe(false);
    expect(await v({ ...good, enrolled_at: -1 })).toBe(false);
    expect(await v({ ...good, enrolled_at: 1.7e21 })).toBe(false);
    expect(await v({ ...good, hosts: ["run"] })).toBe(false);
    expect(await v({ ...good, device_name: "x" })).toBe(false);
    expect(await v({ ...good, device_id: "" })).toBe(false);
    // The declared suite decides HOW to verify, so an unknown one is
    // refused though the signature over it is genuine.
    expect(await v({ ...good, suite: "motebit-future-suite-v9" })).toBe(false);
    const signed = (await k.signRaw(good)) as unknown as HostEnrollment;
    expect(await verifyHostEnrollment({ ...signed, signature: `${signed.signature}==` })).toBe(
      false,
    );
    expect(await verifyHostEnrollment({ ...signed, signature: "AAAA" })).toBe(false);
  });

  it("have ONE id for one signed body — however the signature is spelled", async () => {
    // The spelling is the one part of an artifact nothing signs. Hashing
    // it let anyone, with no key, turn a RETIRED enrolment into a new id
    // that still verified.
    const k = await key();
    const e = await k.enrol("laptop");
    expect(await hostEnrollmentId(e)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hostEnrollmentId(e)).toBe(await hostEnrollmentId(await k.enrol("laptop")));
    expect(await hostEnrollmentId({ ...e, signature: "anything-at-all" })).toBe(
      await hostEnrollmentId(e),
    );
    expect(await hostEnrollmentId(e)).not.toBe(await hostEnrollmentId(await k.enrol("vps")));
    const r = await k.retire(e);
    expect(await hostRetirementId(r)).toBe(await hostRetirementId(await k.retire(e)));
    expect(await hostRetirementId(r)).not.toBe(r.enrollment_id);
  });
});

describe("the signers refuse to mint what no verifier will accept", () => {
  // A daemon caches its enrolment and re-presents the same bytes on every
  // start. An artifact that signs fine and verifies nowhere is therefore
  // a machine that is SILENTLY never in "every machine", forever.
  it("the rotation re-enrol spread: the OLD signature must not end up inside the signed body", async () => {
    // `{ ...oldEnrolment, public_key, enrolled_at }` is the natural way to
    // re-enrol under a new key, and TypeScript does not excess-check a
    // spread. The old `signature` (and `type`, `suite`) ride along.
    const [k1, k2] = [await key(), await key()];
    const old = await k1.enrol("laptop");
    const again = await signHostEnrollment(
      { ...old, public_key: k2.pub, enrolled_at: 5_000 } as Parameters<
        typeof signHostEnrollment
      >[0],
      k2.kp.privateKey,
    );
    expect(await verifyHostEnrollment(again)).toBe(true);
    expect(Object.keys(again).sort()).toEqual(
      ["device_id", "enrolled_at", "motebit_id", "public_key", "signature", "suite", "type"].sort(),
    );
    expect(again.signature).not.toBe(old.signature);
  });

  it("throws rather than sign a body that is not well-formed", async () => {
    const k = await key();
    const base = {
      motebit_id: MOTEBIT,
      device_id: "laptop",
      public_key: k.pub,
      enrolled_at: 1_000,
    };
    const sign = (over: Record<string, unknown>) =>
      signHostEnrollment({ ...base, ...over } as typeof base, k.kp.privateKey);
    await expect(sign({ enrolled_at: 1000.5 })).rejects.toThrow(/not a well-formed HostEnrollment/);
    await expect(sign({ enrolled_at: -0 })).rejects.toThrow(/not a well-formed/);
    await expect(sign({ device_id: "" })).rejects.toThrow(/not a well-formed/);
    await expect(sign({ public_key: k.pub.toUpperCase() })).rejects.toThrow(/not a well-formed/);
    const e = await k.enrol("laptop");
    await expect(
      signHostRetirement(
        { motebit_id: MOTEBIT, enrollment_id: "abc", public_key: k.pub, retired_at: 1 },
        k.kp.privateKey,
      ),
    ).rejects.toThrow(/not a well-formed HostRetirement/);
    expect(await hostEnrollmentId(e)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws when `public_key` is not the key doing the signing", async () => {
    // It would sign, and verify nowhere: the body names a key the
    // signature was not made with.
    const [k1, k2] = [await key(), await key()];
    await expect(
      signHostEnrollment(
        { motebit_id: MOTEBIT, device_id: "laptop", public_key: k1.pub, enrolled_at: 1 },
        k2.kp.privateKey,
      ),
    ).rejects.toThrow(/public_key does not match the signing key/);
    await expect(
      signHostRetirement(
        { motebit_id: MOTEBIT, enrollment_id: "cd".repeat(32), public_key: k1.pub, retired_at: 1 },
        k2.kp.privateKey,
      ),
    ).rejects.toThrow(/public_key does not match the signing key/);
  });
});

describe("@motebit/protocol's guards and the copies restated here are one law", () => {
  // `@motebit/crypto` keeps zero runtime monorepo deps, so its shape
  // checks are restated rather than imported. Two copies drift; this pins
  // them to one table of AUTHENTICALLY SIGNED rows, so shape alone decides.
  it("agree on every row", async () => {
    const k = await key();
    const e = {
      type: "motebit/host-enrollment@1",
      motebit_id: MOTEBIT,
      device_id: "laptop",
      public_key: k.pub,
      enrolled_at: 1_000,
      suite: SUITE,
    };
    const r = {
      type: "motebit/host-retirement@1",
      motebit_id: MOTEBIT,
      enrollment_id: "cd".repeat(32),
      public_key: k.pub,
      retired_at: 2_000,
      suite: SUITE,
    };
    const rows: Array<[string, Record<string, unknown>]> = [
      ["a good enrolment", e],
      ["a good retirement", r],
      ["enrolment + extra field", { ...e, hosts: [] }],
      ["retirement + extra field", { ...r, reason: "lost" }],
      ["enrolment, no tag", (({ type: _t, ...rest }) => rest)(e)],
      ["enrolment, retirement's tag", { ...e, type: r.type }],
      ["enrolment, next major's tag", { ...e, type: "motebit/host-enrollment@2" }],
      ["retirement, no tag", (({ type: _t, ...rest }) => rest)(r)],
      // The key set is right and only the VALUE is wrong — the row that
      // notices a guard which stopped reading the tag.
      ["retirement, enrolment's tag", { ...r, type: e.type }],
      ["retirement, next major's tag", { ...r, type: "motebit/host-retirement@2" }],
      ["enrolment, another registered suite", { ...e, suite: "motebit-jcs-ed25519-hex-v1" }],
      ["retirement, unknown suite", { ...r, suite: "rot13" }],
      ["enrolment, float time", { ...e, enrolled_at: 1.5 }],
      ["retirement, negative time", { ...r, retired_at: -1 }],
      ["enrolment, unsafe integer", { ...e, enrolled_at: 2 ** 60 }],
      ["enrolment, negative zero", { ...e, enrolled_at: -0 }],
      ["enrolment, empty device", { ...e, device_id: "" }],
      ["enrolment, empty motebit", { ...e, motebit_id: "" }],
      ["retirement, short enrollment_id", { ...r, enrollment_id: "abc" }],
      ["retirement, uppercase enrollment_id", { ...r, enrollment_id: "CD".repeat(32) }],
    ];
    const seen = new Set<boolean>();
    for (const [label, body] of rows) {
      const value = await k.signRaw(body);
      const protocolSays = isHostEnrollment(value) || isHostRetirement(value);
      const cryptoSays =
        (await verifyHostEnrollment(value as unknown as HostEnrollment)) ||
        (await verifyHostRetirement(value as unknown as HostRetirement));
      seen.add(protocolSays);
      expect([label, cryptoSays]).toEqual([label, protocolSays]);
    }
    expect(seen).toEqual(new Set([true, false])); // not a vacuous table
  });
});

describe("the reduction — one key", () => {
  it("is every MACHINE with an enrolment nothing ends", async () => {
    const k = await key();
    const laptop = await k.enrol("laptop");
    const vps = await k.enrol("vps");
    const v = await reduce([k.pub], [laptop, vps], [await k.retire(vps)]);
    expect(devices(v.active)).toEqual(["laptop"]);
    expect(devices(v.retired)).toEqual(["vps"]);
    expect(v.superseded).toEqual([]);
    expect(v.rejected).toEqual([]);
    expect(v.chain_head).toEqual({ epoch: 0, public_key: k.pub });
    expect(v.active[0]?.authenticated).toBe(true);
  });

  it("states what was SIGNED — an entry's body, never a spelling of its signature", async () => {
    const k = await key();
    const laptop = await k.enrol("laptop");
    const { signature: _s, ...body } = laptop;
    const v = await reduce([k.pub], [laptop]);
    expect(v.active[0]?.entries).toEqual([{ enrollment_id: await hostEnrollmentId(laptop), body }]);
  });

  it("remove wins; a replay, a re-spelling, or an early tombstone does not undo it", async () => {
    const k = await key();
    const vps = await k.enrol("vps");
    const gone = await k.retire(vps);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = vps.signature.slice(-1);
    const respelled = {
      ...vps,
      signature: vps.signature.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1]!,
    };
    expect(devices((await reduce([k.pub], [vps, vps, respelled], [gone])).retired)).toEqual([
      "vps",
    ]);
    // Union has no order: the tombstone is kept for an enrolment not yet seen.
    const early = await reduce([k.pub], [], [gone]);
    expect(early.tombstones).toEqual([{ enrollment_id: gone.enrollment_id, epoch: 0 }]);
  });

  it("counts a machine ONCE however many enrolments it holds, and says which keep it a member", async () => {
    // A daemon that lost its cached artifact mints a second enrolment.
    // Counted per entry it was two members — and retiring the one a
    // person could see left the machine in "every machine".
    const k = await key();
    const first = await k.enrol("vps", 1_000);
    const second = await k.enrol("vps", 9_000);
    const both = await reduce([k.pub], [first, second]);
    expect(devices(both.active)).toEqual(["vps"]);
    expect(both.active[0]?.entries).toHaveLength(2);

    const oneGone = await reduce([k.pub], [first, second], [await k.retire(first)]);
    expect(oneGone.active[0]?.entries.map((e) => e.enrollment_id)).toEqual([
      await hostEnrollmentId(second),
    ]);
    const allGone = await reduce(
      [k.pub],
      [first, second],
      [await k.retire(first), await k.retire(second)],
    );
    expect(devices(allGone.retired)).toEqual(["vps"]);
  });

  it("a re-join is a NEW entry; the byte-identical one stays retired", async () => {
    const k = await key();
    const vps = await k.enrol("vps", 1_000);
    const gone = await k.retire(vps);
    expect(
      devices((await reduce([k.pub], [vps, await k.enrol("vps", 1_000)], [gone])).retired),
    ).toEqual(["vps"]);
    expect(
      devices((await reduce([k.pub], [vps, await k.enrol("vps", 5_000)], [gone])).active),
    ).toEqual(["vps"]);
  });
});

describe("the reduction — what it refuses", () => {
  it("a key the CONSUMER's chain does not contain, however self-consistent the entry", async () => {
    const k = await key();
    const stranger = await key();
    const forged = await stranger.enrol("attacker-box");
    expect(await verifyHostEnrollment(forged)).toBe(true);
    const v = await reduce([k.pub], [await k.enrol("laptop"), forged]);
    expect(devices(v.active)).toEqual(["laptop"]);
    expect(v.rejected).toEqual([
      {
        kind: "enrollment",
        id: await hostEnrollmentId(forged),
        public_key: stranger.pub,
        reason: "untrusted_key",
      },
    ]);
    const strike = await stranger.retire(await k.enrol("laptop"));
    const v2 = await reduce([k.pub], [await k.enrol("laptop")], [strike]);
    expect(devices(v2.active)).toEqual(["laptop"]);
    expect(v2.tombstones).toEqual([]);
  });

  it("names EACH malformed entry — fifty bad entries are not one anonymous refusal", async () => {
    // Collapsed into `{id: null}` a consumer could not tell one bad entry
    // from fifty machines silently leaving "every machine".
    const k = await key();
    const bad = await Promise.all(
      [1, 2, 3].map(
        async (n) =>
          (await k.signRaw({
            type: "motebit/host-enrollment@1",
            motebit_id: MOTEBIT,
            device_id: `m-${n}`,
            public_key: k.pub,
            enrolled_at: 1_000,
            suite: SUITE,
            hosts: ["run"],
          })) as unknown as HostEnrollment,
      ),
    );
    const v = await reduce([k.pub], [...bad, "junk" as unknown as HostEnrollment]);
    expect(v.rejected).toHaveLength(4);
    expect(v.rejected.filter((r) => r.id != null)).toHaveLength(3);
    expect(v.rejected.every((r) => r.reason === "malformed")).toBe(true);
    expect(v.rejected.filter((r) => r.public_key === k.pub)).toHaveLength(3);
  });

  it("gives ONE reason per entry, by precedence, and none for an id with a good copy", async () => {
    const k = await key();
    const stranger = await key();
    const good = await k.enrol("laptop");
    // Wrong motebit AND an untrusted key: the first that applies.
    const both = await signHostEnrollment(
      { motebit_id: "another", device_id: "x", public_key: stranger.pub, enrolled_at: 1 },
      stranger.kp.privateKey,
    );
    const garbageCopy = { ...good, signature: "A".repeat(86) };
    const v = await reduce([k.pub], [garbageCopy, good, both]);
    expect(devices(v.active)).toEqual(["laptop"]);
    expect(v.rejected.map((r) => r.reason)).toEqual(["wrong_motebit"]);
    // With NO good copy, that id is a bad signature.
    expect((await reduce([k.pub], [garbageCopy])).rejected.map((r) => r.reason)).toEqual([
      "bad_signature",
    ]);
  });

  it("code review on the rebuild: NO number of garbage copies suppresses an authentic entry", async () => {
    // A cap of eight spellings, tried in sorted order, let anyone with no
    // key serve eight garbage copies that sort ahead of a real RETIREMENT.
    // A consumer unioning that store with an honest one never reached the
    // good copy — and the machine was active again. Withholding cannot do
    // that under union; flooding could.
    const k = await key();
    const vps = await k.enrol("vps");
    const gone = await k.retire(vps);
    const flood = Array.from({ length: 200 }, (_, i) => ({
      ...gone,
      signature: `${"-".repeat(83)}${String(i).padStart(3, "0")}`,
    }));
    for (const retirements of [
      [...flood, gone],
      [gone, ...flood],
    ]) {
      const v = await reduce([k.pub], [vps], retirements);
      expect(devices(v.retired)).toEqual(["vps"]);
      expect(v.rejected).toEqual([]);
    }
  });

  it("code review on the rebuild: a copy that is not well-formed never displaces one that is", async () => {
    // `{...e, device_name: undefined}` — what rebuilding an artifact from
    // a row with an optional column gives you. Canonical JSON skips the
    // undefined value, so it has the SAME id and the SAME signature, and
    // it is not well-formed. It overwrote the good copy in a map keyed by
    // signature, and the machine vanished — in one input order only.
    const k = await key();
    const laptop = await k.enrol("laptop");
    const ghostField = { ...laptop, device_name: undefined } as unknown as HostEnrollment;
    const a = await reduce([k.pub], [laptop, ghostField]);
    const b = await reduce([k.pub], [ghostField, laptop]);
    expect(devices(a.active)).toEqual(["laptop"]);
    expect(b).toEqual(a);
    expect(a.rejected).toEqual([]);
  });

  it("refuses -0 as a time: it canonicalizes to 0 and would make the verdict order-dependent", async () => {
    const k = await key();
    const zero = await k.signRaw({
      type: "motebit/host-enrollment@1",
      motebit_id: MOTEBIT,
      device_id: "laptop",
      public_key: k.pub,
      enrolled_at: 0,
      suite: SUITE,
    });
    expect(await verifyHostEnrollment(zero as unknown as HostEnrollment)).toBe(true);
    expect(
      await verifyHostEnrollment({ ...zero, enrolled_at: -0 } as unknown as HostEnrollment),
    ).toBe(false);
    expect(isHostEnrollment({ ...zero, enrolled_at: -0 })).toBe(false);
  });

  it("never spreads an attacker-sized list into a function call (structural)", async () => {
    // `Math.max(...all.map(...))` throws RangeError past the engine's
    // argument limit, and a holder of an old key may mint any number of
    // enrolments for one device — so a flood denied a consumer even the
    // `active` set an old key cannot otherwise touch. Reproducing it
    // needs ~125k AUTHENTIC entries (minutes of signing), so this reads
    // the source instead. It is a tripwire, not a proof, and says so.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../host-roster.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.(max|min)\(\s*\.\.\./);
    expect(code).not.toMatch(/\.push\(\s*\.\.\./);
  });

  it("input with no id is ONE refusal with no key, whatever order it arrives in", async () => {
    const k = await key();
    const unhashable = [
      { public_key: "aa".repeat(32), x: 1n },
      { public_key: "bb".repeat(32), x: 2n },
      "junk",
      null,
    ] as unknown as HostEnrollment[];
    const a = await reduce([k.pub], unhashable);
    expect(a.rejected).toEqual([
      { kind: "enrollment", id: null, public_key: null, reason: "malformed" },
    ]);
    expect(await reduce([k.pub], [...unhashable].reverse())).toEqual(a);
  });

  it("lists only PENDING tombstones — a retirement Rule A ignores is not a machine being retired", async () => {
    // A stolen epoch-0 key names the current enrolment. The machine stays
    // active, and the verdict must not hand a surface a "tombstone" for it
    // to misread as "I am retired, do not re-enrol".
    const [k1, k2] = [await key(), await key()];
    const laptop = await k2.enrol("laptop");
    const unseen = await k2.enrol("never-presented");
    const v = await reduce(
      [k1.pub, k2.pub],
      [laptop],
      [await k1.retire(laptop), await k2.retire(unseen)],
    );
    expect(devices(v.active)).toEqual(["laptop"]);
    expect(v.tombstones).toEqual([{ enrollment_id: await hostEnrollmentId(unseen), epoch: 1 }]);
  });

  it("an unusable chain is NOT an empty roster", async () => {
    const k = await key();
    const e = [await k.enrol("laptop")];
    const run = (keyChain: string[]) =>
      verifyHostRoster({ motebitId: MOTEBIT, keyChain, enrollments: e, retirements: [] });
    expect(await run([])).toEqual({ ok: false, reason: "empty_chain" });
    expect(await run([k.pub, k.pub])).toEqual({ ok: false, reason: "duplicate_key" });
    expect(await run([k.pub.toUpperCase()])).toEqual({ ok: false, reason: "malformed_key" });
  });
});

describe("the reduction — pending tombstones", () => {
  it("an enrolment that is present but REFUSED has not been seen: its retirement stays pending", async () => {
    // The spec first said "an id not present in the input", and the code
    // filtered on ADMITTED enrolments — two conformant reducers would
    // have disagreed. A consumer whose chain lags is the real case: the
    // K2 enrolment is in the input and refused as `untrusted_key`.
    const [k1, k2] = [await key(), await key()];
    const e = await k2.enrol("laptop");
    const r = await k1.retire(e);
    const stale = await reduce([k1.pub], [e], [r]);
    expect(stale.rejected.map((x) => x.reason)).toEqual(["untrusted_key"]);
    expect(stale.tombstones).toEqual([{ enrollment_id: await hostEnrollmentId(e), epoch: 0 }]);
    // Once the consumer learns K2 the enrolment is admitted, the K1
    // retirement does not apply (authority flows forward), and nothing is
    // pending — the machine is simply active.
    const caughtUp = await reduce([k1.pub, k2.pub], [e], [r]);
    expect(devices(caughtUp.active)).toEqual(["laptop"]);
    expect(caughtUp.tombstones).toEqual([]);
  });
});

describe("the reduction — rotation (every scenario here was a real defect)", () => {
  it("code review, round 1: a rotation must not un-retire what was retired before it", async () => {
    const k1 = await key();
    const k2 = await key();
    const vps = await k1.enrol("vps");
    const v = await reduce([k1.pub, k2.pub], [vps], [await k1.retire(vps)]);
    expect(devices(v.retired)).toEqual(["vps"]);
    expect(v.superseded).toEqual([]);
    expect(v.rejected).toEqual([]);
  });

  it("code review, round 2: nor may a SECOND rotation", async () => {
    // E1 under K1, never retired. E2 under K2, retired under K2. Against
    // "current vs old" sets, rotating to K3 emptied the machine's current
    // entries and its K1 line "stood" again: cut off, still running.
    const [k1, k2, k3] = [await key(), await key(), await key()];
    const e1 = await k1.enrol("vps");
    const e2 = await k2.enrol("vps");
    const gone = await k2.retire(e2);
    for (const chain of [
      [k1.pub, k2.pub],
      [k1.pub, k2.pub, k3.pub],
    ]) {
      const v = await reduce(chain, [e1, e2], [gone]);
      expect(devices(v.retired)).toEqual(["vps"]);
      expect(v.superseded).toEqual([]);
    }
  });

  it("the machine that never received the new key is SHOWN as cut off — and marked advisory", async () => {
    const [k1, k2] = [await key(), await key()];
    const v = await reduce(
      [k1.pub, k2.pub],
      [await k1.enrol("lost-vps"), await k1.enrol("laptop"), await k2.enrol("laptop")],
    );
    expect(devices(v.active)).toEqual(["laptop"]);
    expect(devices(v.superseded)).toEqual(["lost-vps"]);
    expect(v.superseded[0]).toMatchObject({ epoch: 0, authenticated: false });
    expect(v.active[0]).toMatchObject({ epoch: 1, authenticated: true });
  });

  it("a stolen OLD key cannot strike a current machine, nor add one", async () => {
    const [k1, k2] = [await key(), await key()];
    const laptop = await k2.enrol("laptop");
    const v = await reduce(
      [k1.pub, k2.pub],
      [laptop, await k1.enrol("ghost")],
      [await k1.retire(laptop)],
    );
    expect(devices(v.active)).toEqual(["laptop"]);
    // The ghost is visible, advisory, and NOT in the set a universal
    // claim is computed over.
    expect(devices(v.superseded)).toEqual(["ghost"]);
    expect(v.superseded[0]?.authenticated).toBe(false);
  });

  it("design review C2: 'retired forever' is FALSE at an old epoch — and the verdict says so", async () => {
    // The owner rotates because a machine was stolen, and retires it
    // under the new key. The thief, holding the old key, mints a fresh
    // enrolment at the old epoch: the machine is `superseded` again. With
    // no trusted clock the reduction cannot tell, so it does not pretend
    // to: every status below the current epoch is `authenticated: false`.
    const [k1, k2] = [await key(), await key()];
    const stolen = await k1.enrol("stolen", 1_000);
    const retiredByOwner = await k2.retire(stolen);
    expect(devices((await reduce([k1.pub, k2.pub], [stolen], [retiredByOwner])).retired)).toEqual([
      "stolen",
    ]);
    const again = await reduce(
      [k1.pub, k2.pub],
      [stolen, await k1.enrol("stolen", 7_777)],
      [retiredByOwner],
    );
    expect(devices(again.superseded)).toEqual(["stolen"]);
    expect(again.superseded[0]?.authenticated).toBe(false);
    // What the thief can NEVER do is reach the authenticated partition.
    expect(again.active).toEqual([]);
  });

  it("design review C1: a consumer catching up on a rotation lands where one that always knew does", async () => {
    // The store learns of K2-signed artifacts before this consumer learns
    // K2. Under [K1] they are refused; under [K1,K2] they take effect.
    const [k1, k2] = [await key(), await key()];
    const vOld = await k1.enrol("vps");
    const set = { e: [vOld, await k2.enrol("laptop")], r: [await k2.retire(vOld)] };
    const stale = await reduce([k1.pub], set.e, set.r);
    expect(devices(stale.active)).toEqual(["vps"]);
    expect(stale.rejected.map((r) => r.reason)).toEqual(["untrusted_key", "untrusted_key"]);
    // ...and it says which view that was, so the claim is attributable.
    expect(stale.chain_head).toEqual({ epoch: 0, public_key: k1.pub });

    const caughtUp = await reduce([k1.pub, k2.pub], set.e, set.r);
    expect(devices(caughtUp.active)).toEqual(["laptop"]);
    expect(devices(caughtUp.retired)).toEqual(["vps"]);
    expect(caughtUp.chain_head).toEqual({ epoch: 1, public_key: k2.pub });
  });

  it("a consumer that knows only the current key sees the same ACTIVE set, and loses the history", async () => {
    const [k1, k2] = [await key(), await key()];
    const set = [await k1.enrol("lost-vps"), await k2.enrol("laptop")];
    const full = await reduce([k1.pub, k2.pub], set);
    const onlyCurrent = await reduce([k2.pub], set);
    expect(devices(onlyCurrent.active)).toEqual(devices(full.active));
    expect(onlyCurrent.superseded).toEqual([]); // absence is no longer defended
    expect(devices(full.superseded)).toEqual(["lost-vps"]);
  });
});

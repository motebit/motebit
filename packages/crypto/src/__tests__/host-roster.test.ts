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

describe("verifyHostRoster — the set, reduced", () => {
  it("is every enrolment no retirement names", async () => {
    const { pub, enrol, retire } = await setup();
    const laptop = await enrol("laptop");
    const vps = await enrol("vps");
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [laptop, vps],
      retirements: [await retire(vps)],
    });
    expect(verdict.active.map((m) => m.enrollment.device_id)).toEqual(["laptop"]);
    expect(verdict.retired.map((m) => m.enrollment.device_id)).toEqual(["vps"]);
    expect(verdict.rejected).toEqual([]);
  });

  it("remove wins, and a replayed enrolment cannot resurrect it", async () => {
    const { pub, enrol, retire } = await setup();
    const vps = await enrol("vps");
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      // The same enrolment presented again, after — and before — its end.
      enrollments: [vps, vps, await enrol("vps")],
      retirements: [await retire(vps)],
    });
    expect(verdict.active).toEqual([]);
    expect(verdict.retired).toHaveLength(1);
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
    // Kept, not discarded: it must still bite when the enrolment shows up.
    expect(early.tombstones).toEqual([tombstone.enrollment_id]);
    const late = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [pub],
      enrollments: [vps],
      retirements: [tombstone],
    });
    expect(late.active).toEqual([]);
  });

  it("gives the same answer for any order and any duplication of its inputs", async () => {
    const { pub, enrol, retire } = await setup();
    const es = [await enrol("a"), await enrol("b"), await enrol("c"), await enrol("d")];
    const rs = [await retire(es[1]!), await retire(es[3]!)];
    const ids = async (enrollments: HostEnrollment[], retirements: HostRetirement[]) =>
      (
        await verifyHostRoster({ motebitId: MOTEBIT, trustedKeys: [pub], enrollments, retirements })
      ).active
        .map((m) => m.enrollment.device_id)
        .sort();
    const base = await ids(es, rs);
    expect(base).toEqual(["a", "c"]);
    expect(await ids([...es].reverse(), [...rs].reverse())).toEqual(base);
    expect(await ids([...es, ...es], [...rs, ...rs])).toEqual(base);
  });

  it("verifies against keys the CONSUMER trusts — never the key an entry brings with it", async () => {
    // A perfectly self-consistent enrolment under a stranger's key is
    // exactly what a hostile relay would serve. It is not a member.
    const { pub, enrol } = await setup();
    const stranger = await generateKeypair();
    const forged = await signHostEnrollment(
      {
        motebit_id: MOTEBIT,
        device_id: "attacker-box",
        public_key: bytesToHex(stranger.publicKey),
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
    expect(verdict.active.map((m) => m.enrollment.device_id)).toEqual(["laptop"]);
    expect(verdict.rejected).toEqual([{ kind: "enrollment", reason: "untrusted_key" }]);
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
    expect(verdict.active).toHaveLength(1);
    expect(verdict.rejected).toEqual([{ kind: "retirement", reason: "untrusted_key" }]);
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

  it("a new key after rotation admits re-enrolments; the old-key line stays visible as superseded", async () => {
    // Rotation is the remedy for a lost machine, and a membership epoch.
    // The machine that never re-enrols is the one that was cut off — it
    // is SHOWN, not dropped: rotating a key does not stop it running.
    const old = await setup();
    const fresh = await generateKeypair();
    const freshPub = bytesToHex(fresh.publicKey);
    const lost = await old.enrol("lost-vps");
    const laptopOld = await old.enrol("laptop");
    const laptopNew = await signHostEnrollment(
      { motebit_id: MOTEBIT, device_id: "laptop", public_key: freshPub, enrolled_at: 5_000 },
      fresh.privateKey,
    );
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [freshPub],
      supersededKeys: [old.pub],
      enrollments: [lost, laptopOld, laptopNew],
      retirements: [],
    });
    expect(verdict.active.map((m) => m.enrollment.device_id)).toEqual(["laptop"]);
    // Only the machine with no current-key line: the laptop moved epochs.
    expect(verdict.superseded.map((m) => m.enrollment.device_id)).toEqual(["lost-vps"]);
  });

  it("a SUPERSEDED key cannot retire a current machine", async () => {
    // After rotation the old key may be in the hands of whoever took the
    // machine. It can no longer add a member — and it must not be able
    // to remove one either, or a stolen laptop could quietly strike the
    // sovereign's other machines out of "every machine" before a halt.
    const old = await setup();
    const fresh = await generateKeypair();
    const freshPub = bytesToHex(fresh.publicKey);
    const laptop = await signHostEnrollment(
      { motebit_id: MOTEBIT, device_id: "laptop", public_key: freshPub, enrolled_at: 5_000 },
      fresh.privateKey,
    );
    const strike = await signHostRetirement(
      {
        motebit_id: MOTEBIT,
        enrollment_id: await hostEnrollmentId(laptop),
        public_key: old.pub,
        retired_at: 6_000,
      },
      old.kp.privateKey,
    );
    const verdict = await verifyHostRoster({
      motebitId: MOTEBIT,
      trustedKeys: [freshPub],
      supersededKeys: [old.pub],
      enrollments: [laptop],
      retirements: [strike],
    });
    expect(verdict.active.map((m) => m.enrollment.device_id)).toEqual(["laptop"]);
    expect(verdict.rejected).toEqual([{ kind: "retirement", reason: "untrusted_key" }]);
  });
});

/**
 * R28 (docs/proposals/machine-roster-clients-v1.md §2A): the machine
 * roster's primitives reach surface-kit through this package. One
 * round trip through the re-exports — mint, id, resolve the chain,
 * reduce — so dropping any of them fails here, not in a consumer.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signKeySuccession,
  signHostEnrollment,
  signHostRetirement,
  hostEnrollmentId,
  hostRetirementId,
  verifyHostRoster,
  resolveRosterKeyChain,
} from "../index";

const MOTEBIT = "019d903f-13de-75a4-8341-58319e0a2f16";

describe("machine-roster re-exports", () => {
  it("mint → resolve the key chain → reduce, through @motebit/encryption", async () => {
    const k0 = await generateKeypair();
    const k1 = await generateKeypair();
    const link = await signKeySuccession(k0.privateKey, k1.privateKey, k1.publicKey, k0.publicKey);

    const resolved = await resolveRosterKeyChain({
      motebitId: MOTEBIT,
      held: bytesToHex(k1.publicKey),
      records: [link],
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.chain).toEqual([bytesToHex(k0.publicKey), bytesToHex(k1.publicKey)]);

    const kept = await signHostEnrollment(
      {
        motebit_id: MOTEBIT,
        device_id: "vps",
        public_key: bytesToHex(k1.publicKey),
        enrolled_at: 1,
      },
      k1.privateKey,
    );
    const gone = await signHostEnrollment(
      {
        motebit_id: MOTEBIT,
        device_id: "laptop",
        public_key: bytesToHex(k1.publicKey),
        enrolled_at: 1,
      },
      k1.privateKey,
    );
    const retirement = await signHostRetirement(
      {
        motebit_id: MOTEBIT,
        enrollment_id: await hostEnrollmentId(gone),
        public_key: bytesToHex(k1.publicKey),
        retired_at: 2,
      },
      k1.privateKey,
    );
    expect(await hostRetirementId(retirement)).toMatch(/^[0-9a-f]{64}$/);

    const roster = await verifyHostRoster({
      motebitId: MOTEBIT,
      keyChain: resolved.chain,
      enrollments: [kept, gone],
      retirements: [retirement],
    });
    if (!roster.ok) throw new Error(roster.reason);
    expect(roster.chain_head.public_key).toBe(resolved.head);
    expect(roster.active.map((m) => m.device_id)).toEqual(["vps"]);
    expect(roster.retired.map((m) => m.device_id)).toEqual(["laptop"]);
  });
});

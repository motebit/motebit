/**
 * The recovery arc's decision surfaces (#428). `planRestore` decides what a
 * restore DOES — and the difference between "passphrase reset" and "REPLACE
 * IDENTITY" is the difference between a relieved founder and a destroyed
 * identity, so the classification is locked as data.
 */
import { describe, it, expect } from "vitest";
import { planRestore, isSovereignId, classifyWriteAhead } from "../subcommands/restore.js";
import { seedBackupStatus } from "../subcommands/seed.js";
import { deriveSovereignMotebitId } from "@motebit/crypto";

const PUB = "8b13f81eb531972b57b3068074631d8a23eba3ccb99db596c40c7050e30365a4";
const OTHER_PUB = "854caa5de4068766ae58b0b424752ac8883b65949def7c99d9281c9c8350a972";

describe("planRestore", () => {
  it("same key on disk → passphrase reset, never a replace (the founder's exact case)", () => {
    const plan = planRestore(PUB, "new-id", {
      motebit_id: "existing-id",
      device_public_key: PUB,
    });
    expect(plan).toEqual({ kind: "passphrase_reset", motebitId: "existing-id" });
  });

  it("key comparison is case-insensitive (hex casing must not force a REPLACE)", () => {
    const plan = planRestore(PUB.toUpperCase(), "new-id", {
      motebit_id: "existing-id",
      device_public_key: PUB,
    });
    expect(plan.kind).toBe("passphrase_reset");
  });

  it("no identity on the machine → fresh install, no confirmation theater", () => {
    const plan = planRestore(PUB, "restored-id", {});
    expect(plan).toEqual({ kind: "fresh_install", motebitId: "restored-id" });
  });

  it("a DIFFERENT identity on disk → replace, which the flow gates on typed confirmation", () => {
    const plan = planRestore(PUB, "restored-id", {
      motebit_id: "resident-id",
      device_public_key: OTHER_PUB,
    });
    expect(plan).toEqual({
      kind: "replace",
      oldMotebitId: "resident-id",
      newMotebitId: "restored-id",
    });
  });
});

describe("isSovereignId", () => {
  it("true when the id is the sovereign commitment to the key", async () => {
    const sovereignId = await deriveSovereignMotebitId(PUB);
    expect(
      await isSovereignId({
        motebitId: sovereignId,
        publicKey: PUB,
        ownerId: "t",
        bornAt: new Date().toISOString(),
        devices: [],
        governance: {
          trust_mode: "guarded",
          max_risk_auto: "R1_DRAFT",
          require_approval_above: "R1_DRAFT",
          deny_above: "R4_MONEY",
          operator_mode: false,
        },
        memory: { half_life_days: 7, confidence_threshold: 0.3, per_turn_limit: 5 },
      }),
    ).toBe(true);
  });

  it("false for a legacy (independently-minted) id — its seed cannot resurrect it", async () => {
    expect(
      await isSovereignId({
        motebitId: "019df0f4-084e-7910-90a8-3492ced8fb8f",
        publicKey: PUB,
        ownerId: "t",
        bornAt: new Date().toISOString(),
        devices: [],
        governance: {
          trust_mode: "guarded",
          max_risk_auto: "R1_DRAFT",
          require_approval_above: "R1_DRAFT",
          deny_above: "R4_MONEY",
          operator_mode: false,
        },
        memory: { half_life_days: 7, confidence_threshold: 0.3, per_turn_limit: 5 },
      }),
    ).toBe(false);
  });
});

describe("seedBackupStatus", () => {
  it("no encrypted key → no_identity (nothing to back up)", () => {
    expect(seedBackupStatus({})).toBe("no_identity");
  });

  it("key present, no ack → not_backed_up (the nudge fires)", () => {
    expect(seedBackupStatus({ cli_encrypted_key: { ciphertext: "x" } })).toBe("not_backed_up");
  });

  it("ack recorded → backed_up (the nudge is gone forever)", () => {
    expect(
      seedBackupStatus({ cli_encrypted_key: { ciphertext: "x" }, seed_backed_up_at: 123 }),
    ).toBe("backed_up");
  });
});

describe("classifyWriteAhead — restore deletes a write-ahead only on positive foreign attribution", () => {
  const ctx = { seedMotebitIds: ["seed-id"], seedPublicKeyHex: PUB, configWasReadable: true };
  const held = (motebit_id: string, old_public_key: string, new_public_key = "ee".repeat(32)) => ({
    motebit_id,
    old_public_key,
    new_public_key,
  });

  it("from the seed's own key → in flight here (left in place), whatever else it says", () => {
    expect(classifyWriteAhead(held("seed-id", PUB), ctx)).toBe("in-flight-here");
    expect(classifyWriteAhead(held("other", PUB.toUpperCase()), ctx)).toBe("in-flight-here");
    expect(classifyWriteAhead(held("seed-id", PUB), { ...ctx, configWasReadable: false })).toBe(
      "in-flight-here",
    );
  });

  it("naming the seed's id or key → kept aside, never cleared", () => {
    expect(classifyWriteAhead(held("seed-id", OTHER_PUB), ctx)).toBe("keep-aside");
    expect(classifyWriteAhead(held("other", OTHER_PUB, PUB), ctx)).toBe("keep-aside");
  });

  it("foreign but the config was unreadable → kept aside (attribution uncertain)", () => {
    expect(classifyWriteAhead(held("other", OTHER_PUB), { ...ctx, configWasReadable: false })).toBe(
      "keep-aside",
    );
  });

  it("positively foreign against a readable config → the only case that clears", () => {
    expect(classifyWriteAhead(held("other", OTHER_PUB), ctx)).toBe("clear-foreign");
  });
});

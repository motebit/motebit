import { describe, it, expect } from "vitest";
import { isBondCommitment, BOND_COMMITMENT_SPEC_ID, type BondCommitment } from "../index.js";

const valid: BondCommitment = {
  bond_id: "01900000-0000-7000-8000-000000000000",
  motebit_id: "mb_agent",
  bonded_public_key: "ab".repeat(32),
  bonded_address: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  bond_amount_micro: 5_000_000,
  asset: "USDC",
  chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  issued_at: 1_700_000_000_000,
  expires_at: 1_700_086_400_000,
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig",
};

describe("BOND_COMMITMENT_SPEC_ID", () => {
  it("pins the artifact family identifier", () => {
    expect(BOND_COMMITMENT_SPEC_ID).toBe("motebit/bond@1.0");
  });
});

describe("isBondCommitment — structural guard (shape only, not validity)", () => {
  it("accepts a well-formed commitment", () => {
    expect(isBondCommitment(valid)).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isBondCommitment(null)).toBe(false);
    expect(isBondCommitment("x")).toBe(false);
    expect(isBondCommitment(undefined)).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { bonded_address: _omit, ...rest } = valid;
    expect(isBondCommitment(rest)).toBe(false);
  });

  it("rejects a non-integer or negative amount", () => {
    expect(isBondCommitment({ ...valid, bond_amount_micro: 1.5 })).toBe(false);
    expect(isBondCommitment({ ...valid, bond_amount_micro: -1 })).toBe(false);
  });

  it("rejects an unknown suite", () => {
    expect(isBondCommitment({ ...valid, suite: "other" })).toBe(false);
  });
});

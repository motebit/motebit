import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  signBondCommitment,
  verifyBondCommitment,
  base58btcEncode,
  bytesToHex,
  BOND_COMMITMENT_SUITE,
  type BondCommitment,
} from "../index.js";

/**
 * Build a well-formed UNSIGNED commitment whose `bonded_address` is correctly
 * derived from `bonded_public_key` — the verifiable shape. Adversarial tests
 * perturb one field of the SIGNED result.
 */
async function freshBond() {
  const kp = await generateKeypair();
  const unsigned: Omit<BondCommitment, "signature" | "suite"> = {
    bond_id: "01900000-0000-7000-8000-000000000000",
    motebit_id: "mb_test_agent",
    bonded_public_key: bytesToHex(kp.publicKey),
    bonded_address: base58btcEncode(kp.publicKey),
    bond_amount_micro: 5_000_000,
    asset: "USDC",
    chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    issued_at: 1_700_000_000_000,
    expires_at: 1_700_086_400_000,
  };
  return { kp, unsigned };
}

describe("base58btcEncode — Solana address parity (external anchor)", () => {
  it("encodes 32 zero bytes as the System Program ID (32 ones)", () => {
    // The Solana System Program address is 32 zero bytes; its base58btc
    // encoding is 32 '1' characters. This is a published, chain-external
    // vector: it proves crypto's base58btcEncode matches the REAL Solana
    // address derivation (`deriveSolanaAddress` = base58Encode), so the bond
    // address binding agrees with what a sovereign agent actually derives —
    // without crypto importing the Layer-1 wallet package.
    expect(base58btcEncode(new Uint8Array(32))).toBe("1".repeat(32));
  });
});

describe("signBondCommitment / verifyBondCommitment", () => {
  it("verifies a self-signed bond whose address is its own sovereign address", async () => {
    const { kp, unsigned } = await freshBond();
    const bond = await signBondCommitment(unsigned, kp.privateKey);
    expect(bond.suite).toBe(BOND_COMMITMENT_SUITE);
    expect(await verifyBondCommitment(bond)).toBe(true);
  });

  // === The anti-sybil binding (the whole justification) ===

  it("rejects a bond whose bonded_address is another key's address (cross-identity reuse)", async () => {
    const { kp, unsigned } = await freshBond();
    const bond = await signBondCommitment(unsigned, kp.privateKey);
    const other = await generateKeypair();
    // The signature still validates against the EMBEDDED key, but the address
    // no longer equals base58(embedded key) → binding broken → reject.
    const reused: BondCommitment = { ...bond, bonded_address: base58btcEncode(other.publicKey) };
    expect(await verifyBondCommitment(reused)).toBe(false);
  });

  it("rejects a bond whose bonded_address is an arbitrary non-derived string", async () => {
    const { kp, unsigned } = await freshBond();
    const bond = await signBondCommitment(
      { ...unsigned, bonded_address: "NotASovereignAddress11111111111111111111111" },
      kp.privateKey,
    );
    expect(await verifyBondCommitment(bond)).toBe(false);
  });

  it("rejects a bond signed by a key other than bonded_public_key", async () => {
    const { unsigned } = await freshBond();
    const impostor = await generateKeypair();
    // bonded_public_key / bonded_address are self-consistent, but the SIGNER is
    // a different key → the embedded-key signature check fails.
    const bond = await signBondCommitment(unsigned, impostor.privateKey);
    expect(await verifyBondCommitment(bond)).toBe(false);
  });

  // === Standard fail-closed surface ===

  it("rejects a tampered amount", async () => {
    const { kp, unsigned } = await freshBond();
    const bond = await signBondCommitment(unsigned, kp.privateKey);
    expect(await verifyBondCommitment({ ...bond, bond_amount_micro: 9_999_999 })).toBe(false);
  });

  it("rejects an unknown suite", async () => {
    const { kp, unsigned } = await freshBond();
    const bond = await signBondCommitment(unsigned, kp.privateKey);
    expect(
      await verifyBondCommitment({ ...bond, suite: "bogus-suite" as typeof BOND_COMMITMENT_SUITE }),
    ).toBe(false);
  });

  it("rejects a malformed hex public key", async () => {
    const { kp, unsigned } = await freshBond();
    const bond = await signBondCommitment(unsigned, kp.privateKey);
    expect(await verifyBondCommitment({ ...bond, bonded_public_key: "zzzz" })).toBe(false);
  });

  it("rejects a wrong-length public key", async () => {
    const { kp, unsigned } = await freshBond();
    const bond = await signBondCommitment(unsigned, kp.privateKey);
    // 31 bytes — cannot be an Ed25519/Solana key.
    expect(await verifyBondCommitment({ ...bond, bonded_public_key: "ab".repeat(31) })).toBe(false);
  });
});

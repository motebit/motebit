import { describe, it, expect } from "vitest";
import type { WithdrawalReceiptPayload } from "@motebit/protocol";
import { generateKeypair } from "../signing.js";
import { signWithdrawalReceipt, verifyWithdrawalReceipt } from "../artifacts.js";

const PAYLOAD: WithdrawalReceiptPayload = {
  withdrawal_id: "w1",
  motebit_id: "alice",
  amount: 5.0,
  currency: "USD",
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
  payout_reference: "5Ub...solanaTxSig",
  completed_at: 1_700_000_000_000,
  relay_id: "relay_a",
};

describe("withdrawal receipt sign/verify", () => {
  it("round-trips: a signed receipt verifies with the signer's public key", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const sig = await signWithdrawalReceipt(PAYLOAD, privateKey);
    expect(await verifyWithdrawalReceipt(PAYLOAD, sig, publicKey)).toBe(true);
  });

  it("rejects a tampered amount (byte-identity commitment)", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const sig = await signWithdrawalReceipt(PAYLOAD, privateKey);
    const tampered = { ...PAYLOAD, amount: 500.0 };
    expect(await verifyWithdrawalReceipt(tampered, sig, publicKey)).toBe(false);
  });

  it("rejects any tampered field — destination redirect", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const sig = await signWithdrawalReceipt(PAYLOAD, privateKey);
    const redirected = { ...PAYLOAD, destination: "attacker-wallet" };
    expect(await verifyWithdrawalReceipt(redirected, sig, publicKey)).toBe(false);
  });

  it("rejects a different signer's public key", async () => {
    const signer = await generateKeypair();
    const other = await generateKeypair();
    const sig = await signWithdrawalReceipt(PAYLOAD, signer.privateKey);
    expect(await verifyWithdrawalReceipt(PAYLOAD, sig, other.publicKey)).toBe(false);
  });

  it("fails closed on a malformed signature string", async () => {
    const { publicKey } = await generateKeypair();
    expect(await verifyWithdrawalReceipt(PAYLOAD, "not-base64url-!!!", publicKey)).toBe(false);
  });

  it("is field-order independent (canonical JSON)", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const sig = await signWithdrawalReceipt(PAYLOAD, privateKey);
    // Same fields, different insertion order — canonicalization sorts keys.
    const reordered: WithdrawalReceiptPayload = {
      relay_id: PAYLOAD.relay_id,
      completed_at: PAYLOAD.completed_at,
      payout_reference: PAYLOAD.payout_reference,
      destination: PAYLOAD.destination,
      currency: PAYLOAD.currency,
      amount: PAYLOAD.amount,
      motebit_id: PAYLOAD.motebit_id,
      withdrawal_id: PAYLOAD.withdrawal_id,
    };
    expect(await verifyWithdrawalReceipt(reordered, sig, publicKey)).toBe(true);
  });
});

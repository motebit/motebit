import { describe, it, expect } from "vitest";
import { ed25519Verify, fromBase64Url, generateKeypair, canonicalJson } from "@motebit/crypto";
import { signWithdrawalReceipt, type WithdrawalReceiptPayload } from "../signing.js";

describe("signWithdrawalReceipt", () => {
  it("signs a canonical-JSON payload and verifies with the public key", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const payload: WithdrawalReceiptPayload = {
      withdrawal_id: "w1",
      motebit_id: "alice",
      amount: 1_000_000,
      currency: "USD",
      destination: "0xdead",
      payout_reference: "tx_0x123",
      completed_at: 1_700_000_000_000,
      relay_id: "relay_a",
    };

    const sigB64 = await signWithdrawalReceipt(payload, privateKey);
    const sigBytes = fromBase64Url(sigB64);
    const message = new TextEncoder().encode(canonicalJson(payload));

    const valid = await ed25519Verify(sigBytes, message, publicKey);
    expect(valid).toBe(true);
  });

  it("signature fails verification when payload is tampered (byte-identity)", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const payload: WithdrawalReceiptPayload = {
      withdrawal_id: "w1",
      motebit_id: "alice",
      amount: 1_000_000,
      currency: "USD",
      destination: "0xdead",
      payout_reference: "tx_0x123",
      completed_at: 1_700_000_000_000,
      relay_id: "relay_a",
    };
    const sigB64 = await signWithdrawalReceipt(payload, privateKey);
    const sigBytes = fromBase64Url(sigB64);

    // Attacker bumps the amount by 1 micro-unit — re-canonicalize fails to verify.
    const tampered = { ...payload, amount: payload.amount + 1 };
    const tamperedMessage = new TextEncoder().encode(canonicalJson(tampered));
    const valid = await ed25519Verify(sigBytes, tamperedMessage, publicKey);
    expect(valid).toBe(false);
  });
});

/**
 * RoutingDecisionTranscript envelope law (Inc 2 —
 * docs/doctrine/routing-decision-transcript.md): sign → verify round-trip,
 * and every fail-closed integrity rejection. Faithfulness (decision
 * recomputation) is deliberately NOT here — it lives with the ranking
 * implementation in @motebit/semiring.
 */
import { describe, it, expect } from "vitest";
import type { RoutingDecisionTranscript } from "@motebit/protocol";
import { generateKeypair, bytesToHex } from "../signing.js";
import {
  signRoutingTranscript,
  verifyRoutingTranscript,
  ROUTING_TRANSCRIPT_SUITE,
} from "../routing-transcript.js";

async function mint(): Promise<{ transcript: RoutingDecisionTranscript }> {
  const kp = await generateKeypair();
  const transcript = await signRoutingTranscript(
    {
      spec: "motebit/routing-transcript@1.0",
      capability: "web_search",
      delegator_motebit_id: "alice",
      delegator_public_key: bytesToHex(kp.publicKey),
      candidates: [
        {
          motebit_id: "carol",
          unit_cost: 0.03,
          bonded: true,
          trust_axis: 0.71,
          reliability_axis: 0.71,
          alpha: 1,
          beta: 1,
          theta: 0.82,
        },
        { motebit_id: "bob", unit_cost: 0.05, trust_axis: 0.66, reliability_axis: 0.66 },
      ],
      seed: "tick-token-signature",
      strength: 1,
      weights: { trust: 0.5, reliability: 0.3, cost: 0.2, latency: 0 },
      count_cap: 100,
      bond_explore_boost: 2,
      default_latency_ms: 5000,
      algorithm_version: "motebit-worker-selection@1",
      winner_motebit_id: "carol",
      explored: true,
      issued_at: 1753000000000,
    },
    kp.privateKey,
  );
  return { transcript };
}

describe("routing-transcript envelope law", () => {
  it("sign → verify round-trips valid", async () => {
    const { transcript } = await mint();
    expect(transcript.suite).toBe(ROUTING_TRANSCRIPT_SUITE);
    expect(await verifyRoutingTranscript(transcript)).toEqual({ valid: true });
  });

  it("any field tamper invalidates the signature", async () => {
    const { transcript } = await mint();
    const tampered = { ...transcript, winner_motebit_id: "bob" };
    expect(await verifyRoutingTranscript(tampered)).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
  });

  it("a winner outside the frozen candidate set is structurally rejected before crypto", async () => {
    const { transcript } = await mint();
    const outside = { ...transcript, winner_motebit_id: "mallory" };
    expect(await verifyRoutingTranscript(outside)).toEqual({
      valid: false,
      reason: "winner_not_in_candidates",
    });
  });

  it("empty candidate set is rejected (a decision among nobody is not a decision)", async () => {
    const { transcript } = await mint();
    expect(await verifyRoutingTranscript({ ...transcript, candidates: [] })).toEqual({
      valid: false,
      reason: "empty_candidates",
    });
  });

  it("unknown suite and unknown spec reject fail-closed", async () => {
    const { transcript } = await mint();
    expect(
      await verifyRoutingTranscript({
        ...transcript,
        suite: "motebit-mldsa44-v1",
      } as unknown as RoutingDecisionTranscript),
    ).toEqual({ valid: false, reason: "unsupported_suite" });
    expect(
      await verifyRoutingTranscript({
        ...transcript,
        spec: "motebit/routing-transcript@2.0",
      } as unknown as RoutingDecisionTranscript),
    ).toEqual({ valid: false, reason: "unsupported_spec" });
  });

  it("malformed key / signature reject with typed reasons", async () => {
    const { transcript } = await mint();
    expect(
      await verifyRoutingTranscript({ ...transcript, delegator_public_key: "not-hex" }),
    ).toEqual({ valid: false, reason: "malformed_public_key" });
    expect(await verifyRoutingTranscript({ ...transcript, signature: "!!!" })).toEqual({
      valid: false,
      reason: "malformed_signature",
    });
  });
});

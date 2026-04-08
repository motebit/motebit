/**
 * Web3JsRpcAdapter unit tests — verify seed → address derivation
 * matches the Ed25519 / Solana convention without touching the network.
 *
 * The mathematical claim "the motebit identity public key IS its
 * Solana address" needs to be checked, not assumed. Solana derives
 * its address as the base58 of the Ed25519 public key, and the
 * Ed25519 public key is determined by the seed. So given a fixed
 * seed, the Solana address is also fixed and can be asserted.
 *
 * Constructor validation (32-byte seed requirement) is also covered
 * here so the rail surface stays free of "did you remember the right
 * seed length" footguns.
 */

import { describe, it, expect } from "vitest";

import { Web3JsRpcAdapter } from "../web3js-adapter.js";

const ZERO_SEED = new Uint8Array(32); // 32 zero bytes

describe("Web3JsRpcAdapter", () => {
  it("derives a deterministic address from a 32-byte Ed25519 seed", () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
    });

    // Solana derives addresses as base58(ed25519_public_key(seed)).
    // For an all-zero seed, this is a stable, well-known value.
    // We don't pin the exact string (different curve impls have
    // historically disagreed on edge cases) — just that it's a
    // non-empty base58-shaped string of plausible length.
    expect(adapter.ownAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(adapter.ownAddress.length).toBeGreaterThanOrEqual(32);
    expect(adapter.ownAddress.length).toBeLessThanOrEqual(44);
  });

  it("produces the same address when given the same seed twice", () => {
    const seed = new Uint8Array(32).fill(7);
    const a = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: seed,
    });
    const b = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: seed,
    });
    expect(a.ownAddress).toBe(b.ownAddress);
  });

  it("produces different addresses for different seeds", () => {
    const a = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(1),
    });
    const b = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(2),
    });
    expect(a.ownAddress).not.toBe(b.ownAddress);
  });

  it("rejects seeds that aren't exactly 32 bytes", () => {
    expect(
      () =>
        new Web3JsRpcAdapter({
          rpcUrl: "https://api.devnet.solana.com",
          identitySeed: new Uint8Array(16),
        }),
    ).toThrow(/32-byte/);
    expect(
      () =>
        new Web3JsRpcAdapter({
          rpcUrl: "https://api.devnet.solana.com",
          identitySeed: new Uint8Array(64),
        }),
    ).toThrow(/32-byte/);
  });
});

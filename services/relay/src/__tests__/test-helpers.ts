/**
 * Shared test helpers for relay integration tests.
 *
 * Centralizes the common setup patterns (auth headers, relay factory, agent factory)
 * so that a single change to createSyncRelay's API propagates once, not 25+ times.
 */
import { createSyncRelay } from "../index.js";
import type { SyncRelay, SyncRelayConfig } from "../index.js";
import { deriveSolanaAddress, SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";

// === Auth constants ===

export const API_TOKEN = "test-token";
export const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
export const JSON_AUTH = { "Content-Type": "application/json", ...AUTH_HEADER };

/** JSON_AUTH with a fresh Idempotency-Key — use for financial endpoints (deposit, withdraw, task, ledger). */
export function jsonAuthWithIdempotency(): Record<string, string> {
  return { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() };
}

// === x402 test config ===

export const X402_TEST_CONFIG = {
  payToAddress: "0x0000000000000000000000000000000000000000",
  network: "eip155:84532",
  testnet: true,
} as const;

// === Relay factory ===

/**
 * Create a test relay with in-memory SQLite.
 * All SyncRelayConfig fields can be overridden; the base provides
 * apiToken and x402 so callers don't repeat them.
 */
export async function createTestRelay(overrides?: Partial<SyncRelayConfig>): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    x402: X402_TEST_CONFIG,
    // Tests use mock WebSocket connections that never disconnect, so the
    // production 5s drain grace would be paid in full on every `close()`
    // (afterEach) — ~5s/test, making the suite slow and timer-bound (the
    // contention-flake amplifier under parallel `turbo run test`). 10ms keeps
    // the drain code path exercised without the wall-clock + flake cost.
    drainGraceMs: 10,
    ...overrides,
  });
}

// === Agent factory ===

/**
 * Register an identity + device on the relay, returning IDs.
 * Used by money-loop, trust-flywheel, settlement-safety, and similar tests.
 */
export async function createAgent(
  relay: SyncRelay,
  pubKeyHex: string,
): Promise<{ motebitId: string; deviceId: string }> {
  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await identityRes.json()) as { motebit_id: string };

  const deviceRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id, device_name: "Test", public_key: pubKeyHex }),
  });
  const { device_id } = (await deviceRes.json()) as { device_id: string };

  return { motebitId: motebit_id, deviceId: device_id };
}

// === P2P payment-proof harness ===
//
// Paid direct delegation settles P2P: the delegator broadcasts an atomic
// multi-output Solana tx (worker leg + treasury fee leg) and submits a
// `payment_proof` with the task. These helpers construct a proof whose
// fields pass the submission validation in `tasks.ts` — the single place
// the net/fee math lives, so the ~32 E2E sites don't each re-derive it.
// The relay treasury address IS the relay's identity-derived Solana wallet
// (`deriveSolanaAddress(relayIdentity.publicKey)` — the same address the
// fee leg must target, validated at `tasks.ts:1720`).

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A fresh, format-valid (88-char base58) fake Solana tx signature. */
export function fakeSolanaTxHash(): string {
  let s = "";
  for (let i = 0; i < 88; i++) {
    s += BASE58_ALPHABET[Math.floor(Math.random() * BASE58_ALPHABET.length)];
  }
  return s;
}

/** The relay's treasury Solana address — the required `fee_to_address`. */
export function p2pTreasuryAddress(relay: SyncRelay): string {
  return deriveSolanaAddress(Uint8Array.from(Buffer.from(relay.relayIdentity.publicKeyHex, "hex")));
}

export interface BuildP2pProofArgs {
  /** Worker's declared settlement address (must match the worker registration). */
  workerAddress: string;
  /** Net the worker earns, in micro-units (== the listing unit_cost). */
  unitCostMicro: number;
  /** Platform fee rate; defaults to the canonical `PLATFORM_FEE_RATE` (0.05). */
  feeRate?: number;
  /** Override the tx signature; defaults to a fresh `fakeSolanaTxHash()`. */
  txHash?: string;
}

export interface P2pPaymentProof {
  tx_hash: string;
  chain: string;
  network: string;
  to_address: string;
  amount_micro: number;
  fee_to_address: string;
  fee_amount_micro: number;
}

/**
 * Build a `payment_proof` for a paid direct delegation. The fee leg is
 * computed exactly as the submission validator expects: the worker earns
 * `net = unitCostMicro`, the fee is `gross - net` where
 * `gross = round(net / (1 - feeRate))`. Mirrors `tasks.ts:1745`.
 */
export function buildP2pPaymentProof(relay: SyncRelay, args: BuildP2pProofArgs): P2pPaymentProof {
  const feeRate = args.feeRate ?? PLATFORM_FEE_RATE;
  const net = args.unitCostMicro;
  const gross = Math.round(net / (1 - feeRate));
  return {
    tx_hash: args.txHash ?? fakeSolanaTxHash(),
    chain: "solana",
    network: SOLANA_MAINNET_CAIP2,
    to_address: args.workerAddress,
    amount_micro: net,
    fee_to_address: p2pTreasuryAddress(relay),
    fee_amount_micro: gross - net,
  };
}

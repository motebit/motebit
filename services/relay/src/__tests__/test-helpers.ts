/**
 * Shared test helpers for relay integration tests.
 *
 * Centralizes the common setup patterns (auth headers, relay factory, agent factory)
 * so that a single change to createSyncRelay's API propagates once, not 25+ times.
 */
import { createSyncRelay } from "../index.js";
import type { SyncRelay, SyncRelayConfig } from "../index.js";

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

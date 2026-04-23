/**
 * Operator Mode — PIN-protected elevated privilege mode.
 *
 * Extracted from MotebitRuntime. Handles PIN hashing (PBKDF2 + SHA-256),
 * rate-limited authentication with exponential lockout, setup, and reset.
 */

import type { KeyringAdapter } from "@motebit/sdk";
import type { PolicyGate } from "@motebit/policy";

// === Types ===

export interface OperatorModeResult {
  success: boolean;
  needsSetup?: boolean;
  error?: string;
  /** If locked out, the timestamp (ms) when the lockout expires. */
  lockedUntil?: number;
}

// === Constants ===

const OPERATOR_PIN_KEY = "operator_pin_hash";
const OPERATOR_PIN_ATTEMPTS_KEY = "operator_pin_attempts";
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_BASE_MS = 30_000; // 30 seconds

// === PIN Utilities ===

interface PinAttemptState {
  /** Number of consecutive failed attempts. */
  count: number;
  /** Timestamp (ms) of the last failed attempt. */
  lastFailedAt: number;
}

function pinLockoutMs(attempts: number): number {
  if (attempts < MAX_PIN_ATTEMPTS) return 0;
  // Exponential backoff: 30s, 5m, 30m, capped at 30m
  const exponent = attempts - MAX_PIN_ATTEMPTS;
  return Math.min(PIN_LOCKOUT_BASE_MS * Math.pow(10, exponent), 30 * 60_000);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPin(pin: string, existingSalt?: string): Promise<string> {
  const salt = existingSalt
    ? new Uint8Array(existingSalt.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `${toHex(salt.buffer)}:${toHex(derived)}`;
}

// === Keyring Helpers ===

async function getPinAttemptState(keyring: KeyringAdapter | null): Promise<PinAttemptState> {
  if (!keyring) return { count: 0, lastFailedAt: 0 };
  const raw = await keyring.get(OPERATOR_PIN_ATTEMPTS_KEY);
  if (raw == null || raw === "") return { count: 0, lastFailedAt: 0 };
  try {
    return JSON.parse(raw) as PinAttemptState;
  } catch {
    return { count: 0, lastFailedAt: 0 };
  }
}

async function recordPinFailure(
  keyring: KeyringAdapter | null,
  prev: PinAttemptState,
): Promise<void> {
  if (!keyring) return;
  const state: PinAttemptState = { count: prev.count + 1, lastFailedAt: Date.now() };
  await keyring.set(OPERATOR_PIN_ATTEMPTS_KEY, JSON.stringify(state));
}

async function clearPinAttempts(keyring: KeyringAdapter | null): Promise<void> {
  if (!keyring) return;
  await keyring.delete(OPERATOR_PIN_ATTEMPTS_KEY);
}

// === Operator Mode Operations ===

export interface OperatorDeps {
  keyring: KeyringAdapter | null;
  policy: PolicyGate;
  onPolicyChanged: () => void;
}

/**
 * Enable/disable operator mode with PIN authentication.
 * Disabling never requires a PIN (safe direction).
 * Rate-limited: after 5 failed attempts, exponential lockout (30s → 5m → 30m).
 */
export async function setOperatorMode(
  deps: OperatorDeps,
  enabled: boolean,
  pin?: string,
): Promise<OperatorModeResult> {
  const { keyring, policy, onPolicyChanged } = deps;

  // Disabling is always allowed (safe direction)
  if (!enabled) {
    policy.setOperatorMode(false);
    onPolicyChanged();
    return { success: true };
  }

  // No keyring → fall through (non-Tauri dev mode)
  if (!keyring) {
    policy.setOperatorMode(true);
    onPolicyChanged();
    return { success: true };
  }

  // Check if PIN is set up
  const storedHash = await keyring.get(OPERATOR_PIN_KEY);
  if (storedHash == null || storedHash === "") {
    return { success: false, needsSetup: true };
  }

  // PIN is required
  if (pin == null || pin === "") {
    return { success: false, error: "PIN required" };
  }

  // Check rate limiting
  const attemptState = await getPinAttemptState(keyring);
  const lockoutMs = pinLockoutMs(attemptState.count);
  if (lockoutMs > 0) {
    const lockedUntil = attemptState.lastFailedAt + lockoutMs;
    if (Date.now() < lockedUntil) {
      return { success: false, error: "Too many failed attempts", lockedUntil };
    }
  }

  // Stored hash is always `${salt_hex}:${derived_hex}` — the output of
  // hashPin() on setup. Any other shape is malformed (or legacy pre-salt
  // from before 2026 when the salted format shipped; reset the PIN to
  // recover).
  const parts = storedHash.split(":");
  if (parts.length !== 2) {
    await recordPinFailure(keyring, attemptState);
    return { success: false, error: "Stored PIN hash is malformed — reset your PIN" };
  }
  const inputHash = await hashPin(pin, parts[0]);
  if (inputHash !== storedHash) {
    await recordPinFailure(keyring, attemptState);
    return { success: false, error: "Incorrect PIN" };
  }

  // Success — reset attempt counter
  await clearPinAttempts(keyring);
  policy.setOperatorMode(true);
  onPolicyChanged();
  return { success: true };
}

/**
 * Set up the operator mode PIN (first-time only, or reset).
 * PIN must be 4-6 digits.
 */
export async function setupOperatorPin(keyring: KeyringAdapter | null, pin: string): Promise<void> {
  if (!keyring) throw new Error("Keyring not available");
  if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN must be 4-6 digits");
  const hashed = await hashPin(pin);
  await keyring.set(OPERATOR_PIN_KEY, hashed);
}

/**
 * Reset the operator PIN — clears the keyring hash and disables operator mode.
 */
export async function resetOperatorPin(deps: OperatorDeps): Promise<void> {
  const { keyring, policy, onPolicyChanged } = deps;
  if (!keyring) throw new Error("Keyring not available");
  await keyring.delete(OPERATOR_PIN_KEY);
  await clearPinAttempts(keyring);
  policy.setOperatorMode(false);
  onPolicyChanged();
}

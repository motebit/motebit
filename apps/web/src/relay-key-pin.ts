/**
 * Relay-key trust-on-first-use (TOFU) pin — web surface.
 *
 * The fee leg of a paid P2P delegation is an IRREVERSIBLE onchain payment to a
 * treasury derived from the relay's Ed25519 public key. If that key came from a
 * fresh `/.well-known` fetch on every delegation, a MITM on relay reads could
 * redirect the fee to an attacker. So the runtime's `InvokeCapabilityConfig`
 * takes a PINNED relay key (`docs/doctrine/off-ramp-as-user-action.md` § Arc 3.5,
 * pinned-key trust decision); this helper produces it.
 *
 * Minimal-safe TOFU (rotation/succession handling deferred — see below):
 *   - First connect to a relay URL: fetch `/.well-known/motebit.json`, persist
 *     its `public_key` keyed by URL (the trust-on-first-use moment), return it.
 *   - Later connects: re-fetch and COMPARE to the pin. Match → return the pin.
 *     Mismatch → FAIL CLOSED (return undefined) so paid P2P is disabled and the
 *     runtime falls back to relay-mediated settlement. A changed relay key is
 *     either a legitimate rotation (which needs the relay's key-transparency /
 *     succession chain to re-pin safely — `identity-binding-verification.md`,
 *     deferred) or an attack; we cannot tell here, so we refuse to pay rather
 *     than pay a possibly-wrong address. Relay-mode still serves the task.
 *   - Fetch failure with an existing pin → return the pin (it is the trusted
 *     value; `/.well-known` being unreachable must not disable a known relay).
 *   - Fetch failure with no pin → return undefined (cannot establish trust).
 *
 * The pin is per-URL, not bundled into the device pairing record, because the
 * relay relationship is established at connect time, not at device-link time.
 */

const PIN_KEY_PREFIX = "motebit:relay_pin:";

export interface RelayKeyPinDeps {
  /** Fetch implementation — defaults to `globalThis.fetch`. Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Key-value store — defaults to `localStorage`. Injected for tests. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /** Structured logger for the fail-closed (mismatch) security event. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * Resolve the pinned relay Ed25519 public key (hex) for `relayUrl`, or
 * `undefined` when paid P2P must be disabled (no trust establishable, or a
 * fail-closed key mismatch). The result feeds `InvokeCapabilityConfig.relayPublicKey`.
 */
export async function getOrPinRelayKey(
  relayUrl: string,
  deps: RelayKeyPinDeps = {},
): Promise<string | undefined> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const storage = deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (storage == null) return undefined;

  const pinKey = `${PIN_KEY_PREFIX}${relayUrl}`;
  const existingPin = storage.getItem(pinKey) ?? undefined;

  let fetchedKey: string | undefined;
  try {
    const resp = await fetchImpl(`${relayUrl}/.well-known/motebit.json`, {
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      const body = (await resp.json()) as { public_key?: unknown };
      if (typeof body.public_key === "string" && body.public_key.length > 0) {
        fetchedKey = body.public_key;
      }
    }
  } catch {
    // Network/parse failure — handled below by falling back to the pin.
  }

  // Fetch failed (or returned no key): trust the existing pin if we have one;
  // otherwise we cannot establish trust → disable P2P.
  if (fetchedKey == null) return existingPin;

  // No pin yet → trust-on-first-use: persist and adopt.
  if (existingPin == null) {
    storage.setItem(pinKey, fetchedKey);
    return fetchedKey;
  }

  // Pin matches the live key → use the trusted pin.
  if (existingPin === fetchedKey) return existingPin;

  // Mismatch → fail closed. Do NOT silently re-pin (that would defeat the pin).
  // Rotation handling (verify the relay's succession chain, then re-pin) is the
  // deferred follow-up; until then a key change disables paid P2P, not the relay.
  deps.logger?.warn("relay_key_pin.mismatch", {
    relayUrl,
    pinnedKeyPrefix: existingPin.slice(0, 12),
    fetchedKeyPrefix: fetchedKey.slice(0, 12),
  });
  return undefined;
}

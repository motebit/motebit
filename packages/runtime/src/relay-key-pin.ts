/**
 * Relay-key trust-on-first-use (TOFU) pin — cross-surface.
 *
 * The fee leg of a paid P2P delegation is an IRREVERSIBLE onchain payment to a
 * treasury derived from the relay's Ed25519 public key. If that key came from a
 * fresh `/.well-known` fetch on every delegation, a MITM on relay reads could
 * redirect the fee to an attacker. So `InvokeCapabilityConfig.relayPublicKey` /
 * `InteractiveDelegationConfig.relayPublicKey` take a PINNED relay key
 * (`docs/doctrine/off-ramp-as-user-action.md` § Arc 3.5); this helper produces it.
 *
 * Surface-agnostic: `fetchImpl` and `storage` are injected, so the same logic
 * serves web/desktop (synchronous `localStorage`) and mobile (asynchronous
 * `AsyncStorage`) — `getItem`/`setItem` may return a value or a Promise and are
 * awaited either way. The runtime is DOM-free, so there is no `localStorage`
 * default; each surface passes its own store.
 *
 * Minimal-safe TOFU (rotation/succession handling deferred):
 *   - First connect to a relay URL: fetch `/.well-known/motebit.json`, persist
 *     its `public_key` keyed by URL (the trust-on-first-use moment), return it.
 *   - Later: re-fetch and COMPARE to the pin. Match → return the pin. Mismatch →
 *     FAIL CLOSED (return undefined) so paid P2P is disabled and delegation
 *     falls back to relay-mediated settlement. A changed relay key is either a
 *     legitimate rotation (needs the relay's key-transparency / succession chain
 *     to re-pin safely — `identity-binding-verification.md`, deferred) or an
 *     attack; we cannot tell here, so we refuse to pay rather than pay a
 *     possibly-wrong address. Relay-mode still serves the task.
 *   - Fetch failure with an existing pin → return the pin (the trusted value;
 *     `/.well-known` being unreachable must not disable a known relay).
 *   - Fetch failure with no pin → return undefined (cannot establish trust).
 */

const PIN_KEY_PREFIX = "motebit:relay_pin:";

/** Async-or-sync key-value store. Web/desktop pass `localStorage`; mobile passes an AsyncStorage shim. */
export interface RelayKeyPinStorage {
  getItem(key: string): (string | null) | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export interface RelayKeyPinDeps {
  /** Fetch implementation — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Required key-value store (the runtime has no DOM `localStorage`). */
  storage: RelayKeyPinStorage;
  /** Structured logger for the fail-closed (mismatch) security event. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * Resolve the pinned relay Ed25519 public key (hex) for `relayUrl`, or
 * `undefined` when paid P2P must be disabled (no trust establishable, or a
 * fail-closed key mismatch). Feeds `…Config.relayPublicKey`.
 */
export async function getOrPinRelayKey(
  relayUrl: string,
  deps: RelayKeyPinDeps,
): Promise<string | undefined> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const pinKey = `${PIN_KEY_PREFIX}${relayUrl}`;
  const existingPin = (await deps.storage.getItem(pinKey)) ?? undefined;

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
    await deps.storage.setItem(pinKey, fetchedKey);
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

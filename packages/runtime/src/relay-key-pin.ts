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
 * TOFU pin with rotation-aware re-pin:
 *   - First connect to a relay URL: fetch `/.well-known/motebit.json`, persist
 *     its `public_key` keyed by URL (the trust-on-first-use moment), return it.
 *   - Later: re-fetch and COMPARE to the pin. Match → return the pin.
 *   - Mismatch → the relay's key changed. Verify the relay's SIGNED succession
 *     chain (`/api/v1/agents/:relay_id/succession`): if it proves the pinned key
 *     → … → the fetched key (each rotation signed by its predecessor, the chain
 *     rooted at our pinned key), the rotation is LEGITIMATE → re-pin and adopt
 *     the new key. Otherwise FAIL CLOSED (return undefined) — a missing,
 *     invalid, or not-rooted-at-our-pin chain is equivocation / attack, so paid
 *     P2P disables rather than trusting an unproven key. The pinned key is the
 *     anchor; the relay cannot equivocate without a chain signed from it
 *     (`identity-binding-verification.md` — operator non-equivocable anchor).
 *   - Fetch failure with an existing pin → return the pin (the trusted value;
 *     `/.well-known` being unreachable must not disable a known relay).
 *   - Fetch failure with no pin → return undefined (cannot establish trust).
 *
 * Guardian-recovery succession records are not honored here (no guardian key on
 * the client) → a recovery rotation fails closed until manually re-pinned; a
 * normal predecessor-signed rotation re-pins automatically.
 */

import {
  verifySuccessionChain,
  KEY_SUCCESSION_SUITE,
  type KeySuccessionRecord,
} from "@motebit/crypto";

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
  let fetchedRelayId: string | undefined;
  try {
    const resp = await fetchImpl(`${relayUrl}/.well-known/motebit.json`, {
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      const body = (await resp.json()) as { public_key?: unknown; relay_id?: unknown };
      if (typeof body.public_key === "string" && body.public_key.length > 0) {
        fetchedKey = body.public_key;
      }
      if (typeof body.relay_id === "string" && body.relay_id.length > 0) {
        fetchedRelayId = body.relay_id;
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

  // Mismatch → the relay's key changed. Re-pin ONLY if a signed succession
  // chain proves the pinned key is an ancestor of the fetched key (a legitimate
  // rotation). Otherwise fail closed.
  const rotationProven = await verifyRotation({
    relayUrl,
    relayId: fetchedRelayId,
    pinnedKey: existingPin,
    fetchedKey,
    fetchImpl,
  });
  if (rotationProven) {
    await deps.storage.setItem(pinKey, fetchedKey);
    deps.logger?.warn("relay_key_pin.rotated", {
      relayUrl,
      fromKeyPrefix: existingPin.slice(0, 12),
      toKeyPrefix: fetchedKey.slice(0, 12),
    });
    return fetchedKey;
  }

  deps.logger?.warn("relay_key_pin.mismatch", {
    relayUrl,
    pinnedKeyPrefix: existingPin.slice(0, 12),
    fetchedKeyPrefix: fetchedKey.slice(0, 12),
  });
  return undefined;
}

/**
 * Verify that the relay's signed succession chain proves `pinnedKey` → … →
 * `fetchedKey` — i.e., the fetched key is a legitimate, predecessor-signed
 * rotation descendant of the key we pinned. Returns false (fail closed) on any
 * doubt: no relay_id, unreachable/empty chain, an invalid signature or broken
 * link, a chain that does not END at the fetched key, or one not ROOTED at our
 * pinned key (the relay presenting a valid-but-unrelated chain — equivocation).
 */
async function verifyRotation(args: {
  relayUrl: string;
  relayId: string | undefined;
  pinnedKey: string;
  fetchedKey: string;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  if (args.relayId == null) return false;

  let chain: KeySuccessionRecord[];
  try {
    const resp = await args.fetchImpl(
      `${args.relayUrl}/api/v1/agents/${encodeURIComponent(args.relayId)}/succession`,
      { headers: { Accept: "application/json" } },
    );
    if (!resp.ok) return false;
    const body = (await resp.json()) as { chain?: unknown };
    if (!Array.isArray(body.chain) || body.chain.length === 0) return false;
    // The endpoint omits the (constant) succession suite per record; inject it
    // so each record verifies. Any record missing the required fields fails the
    // signature check below — fail closed, not crash.
    chain = body.chain.map((r) => ({
      ...(r as Record<string, unknown>),
      suite: KEY_SUCCESSION_SUITE,
    })) as KeySuccessionRecord[];
  } catch {
    return false;
  }

  const result = await verifySuccessionChain(chain);
  return (
    result.valid &&
    result.current_public_key === args.fetchedKey &&
    // The chain must be ANCHORED at our pinned key — it appears as some link's
    // predecessor (genesis or an intermediate). A valid chain not rooted at the
    // pin is the relay equivocating to an unrelated lineage.
    chain.some((r) => r.old_public_key === args.pinnedKey)
  );
}

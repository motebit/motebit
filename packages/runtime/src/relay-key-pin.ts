/**
 * Relay-key trust-on-first-use (TOFU) pin — cross-surface.
 *
 * The fee leg of a paid P2P delegation is an IRREVERSIBLE onchain payment to a
 * treasury derived from the relay's Ed25519 public key. If that key came from a
 * fresh `/.well-known` fetch on every delegation, a MITM on relay reads could
 * redirect the fee to an attacker. So the runtime's relay binding
 * (`RelayBinding.relayPublicKey`, `MotebitRuntime.bindRelay`) takes a PINNED relay key
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
  hexToBytes,
  verifyRelayMetadata,
  verifySuccessionChain,
  KEY_SUCCESSION_SUITE,
  type KeySuccessionRecord,
} from "@motebit/crypto";
import type { RelayMetadata } from "@motebit/protocol";

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
      // Only a well-formed Ed25519 public key may become (or replace) a pin.
      // Pinning a malformed value would fail closed against the REAL key on
      // every later fetch until someone hand-edits the store — a garbage
      // response must be a no-op, not a poisoned trust root.
      if (typeof body.public_key === "string" && /^[0-9a-fA-F]{64}$/.test(body.public_key)) {
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

// === Per-relay key establishment (the URL a key signs) ======================
//
// `getOrPinRelayKey` above trusts whatever key a URL serves first. The two
// functions below are stricter and store nothing: they answer "which key
// PROVES it is the relay at this URL", by requiring the relay's signed
// discovery metadata to name the URL it was asked at. A server holding only
// copies of relay A's documents cannot pass for A under another URL, because
// A's key signed A's URL.

/**
 * The comparable form of a relay URL, or null when the URL cannot carry a
 * relay key. Two spellings share a pin key exactly when the URL parser
 * unifies them (host case, default port, IDN, dot segments, trailing
 * slashes); the path is kept, so two relays on one host stay distinct.
 *
 * Null (fail toward "no pin") for a backslash, `?`, `#`, `@`, whitespace or
 * a control character anywhere in the raw input, for anything `new URL`
 * rejects, and for a scheme other than `http:` / `https:`.
 */
export function relayPinKey(url: string): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\\?#@\s\u0000-\u001f\u007f]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href.replace(/\/+$/, "");
}

/** Why `verifyRelayMetadataForUrl` established no key. */
export type RelayMetadataForUrlFailure =
  | {
      ok: false;
      reason:
        | "unpinnable_url"
        | "unreachable"
        | "redirect_refused"
        | "metadata_unavailable"
        | "malformed_key"
        | "bad_signature"
        | "endpoint_empty";
    }
  | {
      ok: false;
      reason: "endpoint_mismatch";
      /** The pin key of the URL the relay DID sign, or null when it has none. */
      signedPinKey: string | null;
    };

/** The outcome of `verifyRelayMetadataForUrl`. */
export type RelayMetadataForUrlResult =
  | {
      ok: true;
      /** The relay's Ed25519 public key: 64 hex characters, lowercase. */
      publicKey: string;
      relayId: string;
    }
  | RelayMetadataForUrlFailure;

export interface VerifyRelayMetadataForUrlOptions {
  /** Fetch implementation — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
}

/**
 * Establish the key that signs the relay at `url`, from its signed discovery
 * metadata (`<pin key>/.well-known/motebit.json`). Redirects are not followed
 * (`redirect: "manual"`, so a redirect is distinguishable from no answer) and
 * the request, body included, times out after five seconds unless `timeoutMs`
 * says otherwise. Checks, in order:
 *
 *  1. `relayPinKey(url)` is null → `unpinnable_url`;
 *  2. no answer (or a timeout) → `unreachable`; a redirect →
 *     `redirect_refused`; non-2xx, not JSON, or missing fields →
 *     `metadata_unavailable`;
 *  3. `public_key` is not 64 hex characters → `malformed_key`; the document
 *     does not verify under exactly that key → `bad_signature`;
 *  4. the signed `endpoint_url` is empty → `endpoint_empty`; its pin key
 *     differs from `url`'s → `endpoint_mismatch`.
 *
 * Stores nothing and never throws.
 */
export async function verifyRelayMetadataForUrl(
  url: string,
  options: VerifyRelayMetadataForUrlOptions = {},
): Promise<RelayMetadataForUrlResult> {
  const pinKey = relayPinKey(url);
  if (pinKey == null) return { ok: false, reason: "unpinnable_url" };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  let doc: Record<string, unknown>;
  try {
    let resp: Response;
    try {
      resp = await fetchImpl(`${pinKey}/.well-known/motebit.json`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    // Node reports a manual redirect as the 3xx itself; a browser as an
    // opaque redirect.
    if (resp.type === "opaqueredirect" || (resp.status >= 300 && resp.status < 400)) {
      return { ok: false, reason: "redirect_refused" };
    }
    if (!resp.ok) return { ok: false, reason: "metadata_unavailable" };
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      // The timeout firing mid-body is no answer; anything else is not JSON.
      return {
        ok: false,
        reason: controller.signal.aborted ? "unreachable" : "metadata_unavailable",
      };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, reason: "metadata_unavailable" };
    }
    doc = body as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }

  if (
    typeof doc.public_key !== "string" ||
    typeof doc.relay_id !== "string" ||
    doc.relay_id === "" ||
    typeof doc.signature !== "string" ||
    typeof doc.suite !== "string"
  ) {
    return { ok: false, reason: "metadata_unavailable" };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(doc.public_key)) return { ok: false, reason: "malformed_key" };
  const publicKey = doc.public_key.toLowerCase();
  let verified = false;
  try {
    verified = await verifyRelayMetadata(doc as unknown as RelayMetadata, hexToBytes(publicKey));
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "bad_signature" };

  const signedEndpoint = doc.endpoint_url;
  if (typeof signedEndpoint !== "string" || signedEndpoint === "") {
    return { ok: false, reason: "endpoint_empty" };
  }
  const signedPinKey = relayPinKey(signedEndpoint);
  if (signedPinKey !== pinKey) return { ok: false, reason: "endpoint_mismatch", signedPinKey };

  return { ok: true, publicKey, relayId: doc.relay_id };
}

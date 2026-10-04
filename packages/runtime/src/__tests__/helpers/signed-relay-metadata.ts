/**
 * A pinned relay key that can SIGN, plus its signed discovery metadata.
 *
 * The P2P client reads the relay's fee rate from `/.well-known/motebit.json`
 * signed by the PINNED key (spec/discovery-v1.md §3), so a test that drives a
 * P2P hire through the listing-priced path needs a relay that can produce that
 * document. The seed is fixed, so the key is stable across runs. No `fee_rate`
 * ⇒ the reference default (0.05), matching what these tests always assumed.
 */
import { vi } from "vitest";
import { bytesToHex, canonicalJson, getPublicKeyBySuite, signBySuite } from "@motebit/crypto";

const SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const PRIVATE_KEY = new Uint8Array(32).fill(7);

/** Hex Ed25519 public key to pin (replaces the old unsignable `"07".repeat(32)`). */
export const SIGNING_PINNED_HEX = bytesToHex(await getPublicKeyBySuite(PRIVATE_KEY, SUITE));

const body = {
  protocol_version: "1.0",
  relay_id: "test-relay",
  public_key: SIGNING_PINNED_HEX,
  endpoint_url: "https://relay.test",
  suite: SUITE,
};
const signature = bytesToHex(
  await signBySuite(SUITE, new TextEncoder().encode(canonicalJson(body)), PRIVATE_KEY),
);

/** The pinned relay's signed metadata document. */
export const SIGNED_RELAY_METADATA = { ...body, signature };

/** True for a relay metadata read. */
export function isRelayMetadataUrl(url: string): boolean {
  return url.endsWith("/.well-known/motebit.json");
}

/** A fresh 200 response carrying the signed metadata. */
export function relayMetadataResponse(): Response {
  return new Response(JSON.stringify(SIGNED_RELAY_METADATA), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const realSetTimeout = globalThis.setTimeout;

/**
 * Fake-timer drive for a P2P hire. Verifying the signed metadata awaits real
 * WebCrypto work that a fake clock cannot advance, so first give in-flight
 * hires REAL event-loop turns — a fixed minimum (a hire started while another
 * already holds fake timers must still finish its verification), then more
 * until some fake timer is scheduled (bounded) — and only then advance the
 * fake clock exactly as before.
 */
export async function advanceAfterRealAsync(ms: number): Promise<void> {
  for (let i = 0; i < 1000 && (i < 25 || vi.getTimerCount() === 0); i++) {
    await new Promise((r) => realSetTimeout(r, 2));
  }
  await vi.advanceTimersByTimeAsync(ms);
}

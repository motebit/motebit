/**
 * A pinned relay key that has SIGNED discovery metadata.
 *
 * A paid P2P hire reads the relay's fee rate from `/.well-known/motebit.json`
 * signed by the PINNED relay key (spec/discovery-v1.md §3), so a fake relay
 * must serve that document. Ed25519 is deterministic: the key and signature
 * below come from the fixed seed `new Uint8Array(32).fill(7)` (the same
 * fixture as packages/runtime/src/__tests__/helpers/signed-relay-metadata.ts),
 * so they are literals here and usable inside hoisted `vi.mock` factories. No
 * `fee_rate` ⇒ the 0.05 reference default these tests always assumed.
 */

import { vi } from "vitest";

/** Hex Ed25519 public key of the fixed-seed test relay. */
export const SIGNING_PINNED_HEX =
  "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";

const SIGNED_RELAY_METADATA = {
  protocol_version: "1.0",
  relay_id: "test-relay",
  public_key: SIGNING_PINNED_HEX,
  endpoint_url: "https://relay.test",
  suite: "motebit-jcs-ed25519-hex-v1",
  signature:
    "caee9335accca4025e16e85777179db08dc77034b8de0ef024763a7d4905aaecd371829876064a228b9ad2c040fdbffaf648c373cec948fecef981b83591570e",
};

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
 * hires REAL event-loop turns (a fixed minimum, then more until some fake
 * timer is scheduled, bounded), and only then advance the fake clock.
 */
export async function advanceAfterRealAsync(ms: number): Promise<void> {
  for (let i = 0; i < 1000 && (i < 25 || vi.getTimerCount() === 0); i++) {
    await new Promise((r) => realSetTimeout(r, 2));
  }
  await vi.advanceTimersByTimeAsync(ms);
}

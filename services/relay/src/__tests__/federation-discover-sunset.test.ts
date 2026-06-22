import { describe, it, expect } from "vitest";
import { DEFAULT_REQUIRE_DISCOVER_SIGNATURE } from "../federation.js";

/**
 * Sunset forcing function for issue #188 — the `requireDiscoverSignature` default.
 *
 * Per-hop signed discover (relay-federation@1.3 §4.1.1, cold-audit finding P0-3b)
 * shipped with a tolerant default (`?? false`) so the mesh kept discovering during
 * the two-sided rollout. Every motebit relay now runs strict; the tolerant DEFAULT
 * is the last live remnant of the P0 fail-open, kept only to spare an unknown,
 * un-upgraded self-hosted peer a hard 403 during the announced window.
 *
 * This makes the flip self-enforcing instead of recap-dependent — the exact drift
 * shape #188 exists to close ("a fail-open security flag whose flip condition lives
 * only in a chat recap"). On or after the announced sunset this FAILS in CI until
 * the default flips to strict. Honest closes: (a) flip the default — change the one
 * line in federation.ts (the issue's intent), or (b) move the sunset with a
 * rationale here AND in spec §4.1.1 + docs/operator/self-host.md. Same deadline
 * discipline as `check-coverage-graduation` (#111).
 */
describe("requireDiscoverSignature default — #188 sunset", () => {
  // 2026-07-21 — the announced tolerant-reader sunset (spec §4.1.1 + self-host.md).
  // Date.UTC month is 0-indexed: 6 = July.
  const SUNSET_MS = Date.UTC(2026, 6, 21);

  it("is strict (true) on or after the 2026-07-21 sunset", () => {
    if (Date.now() >= SUNSET_MS) {
      expect(DEFAULT_REQUIRE_DISCOVER_SIGNATURE).toBe(true);
    }
    // Before the sunset, either value is acceptable: the flip may land early once
    // the `federation.discover.unsigned` telemetry is confirmed silent across peers.
  });
});

/**
 * Source-level wiring of the per-relay key (design test 8).
 *
 * The REPL's relay wiring in `index.ts` cannot be run in a test (precedent:
 * `launch-preflight.test.ts`, "every launch path runs the pre-flight"), so
 * this reads the source: `index.ts` resolves the session's relay key ONCE,
 * for the same URL it gives the relay wiring, hands that one result to both
 * the relay wiring and `preflightGrant`, and never mentions the legacy
 * `relay_public_key`. The other two money-path readers are held to the same.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const read = (rel: string): string => strip(fs.readFileSync(path.join(SRC, rel), "utf-8"));

const index = read("index.ts");
const preflight = read("grant-preflight.ts");
const delegate = read("subcommands/delegate.ts");

/** The argument object of the first `name({ … })` call in `src`. */
function callObject(src: string, name: string): string {
  const start = src.indexOf(`${name}({`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start + name.length + 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}({`);
}

describe("test 8 — index.ts: one resolveRelayKey result for the session", () => {
  it("resolves the key exactly once, for the URL it gives the relay wiring, and only when a relay is named", () => {
    expect(index.match(/resolveRelayKey\(/g)?.length).toBe(1);
    expect(index).toMatch(
      /const sessionRelayKey: SessionRelayKey =\s+syncUrl != null \? await resolveRelayKey\(syncUrl\) : \{ status: "no_relay" \};/,
    );
    // …and `syncUrl` is the very value the relay wiring is given.
    expect(callObject(index, "startReplRelay")).toMatch(/\n\s+syncUrl,\n/);
    expect(index.match(/const syncUrl = /g)?.length).toBe(1);
  });

  it("hands that one result to the relay wiring", () => {
    expect(callObject(index, "startReplRelay")).toMatch(
      /relayPublicKey: sessionRelayKey\.status === "key" \? sessionRelayKey\.key : undefined,/,
    );
  });

  it("hands that same result to preflightGrant", () => {
    expect(callObject(index, "preflightGrant")).toMatch(/\n\s+relayKey: sessionRelayKey,\n/);
    expect(index.match(/sessionRelayKey\b/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("never mentions the legacy relay_public_key, and never reads the record itself", () => {
    expect(index).not.toContain("relay_public_key");
    expect(index).not.toMatch(/readRelayPins|relayPinsPath|addRelayPin|bindRelayPin/);
  });
});

describe("test 8 — the other two money-path readers", () => {
  it("grant-preflight uses the result it is given: no file read, no request, no legacy field", () => {
    expect(preflight).toMatch(/const relayKey = deps\.relayKey;/);
    expect(preflight).not.toContain("relay_public_key");
    expect(preflight).not.toMatch(/readRelayPins|relayPinsPath|resolveRelayKey|bindRelayPin/);
    expect(preflight).not.toMatch(/\bfetch\(|node:fs|readFileSync/);
  });

  it("delegate --sovereign resolves the key for the relay it submits to, and never reads the legacy field", () => {
    expect(delegate).not.toContain("relay_public_key");
    expect(delegate.match(/resolveRelayKey\(/g)?.length).toBe(1);
    expect(delegate).toMatch(/const relayKey = await resolveRelayKey\(relayUrl, deps\.relayKey\);/);
    const submit = callObject(delegate, "resolveAndSubmitP2pDelegation");
    expect(submit).toMatch(/\n\s+syncUrl: relayUrl,\n/);
    expect(submit).toMatch(/\n\s+relayPublicKeyHex: relayKey\.key,\n/);
  });
});

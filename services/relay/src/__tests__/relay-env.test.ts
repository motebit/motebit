/**
 * relayEnv() completeness — the injected-env seam's source is an explicit
 * set of literal-key `process.env.NAME` reads (check-service-truth denies
 * `process.env` as a value). A key read through an `EnvSource` (`env.NAME`,
 * `env["NAME"]`, `parse*Env("NAME", …)`) or an `X402_RPC_URL_<chain>`
 * override that relayEnv() does not supply would silently read as unset, so
 * this test scans every non-test relay source and fails on the first miss.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { relayEnv } from "../env.js";
import { CONFIRMATIONS_BY_CHAIN } from "../deposit-detector.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read through an `env` seam with its OWN literal fallback, not relayEnv():
 * x402-facilitator.ts `env ? env["CDP_…"] : process.env.CDP_…`.
 */
const OWN_FALLBACK = new Set(["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]);

/** Source text with comments removed (a doc comment may spell `env.NAME`). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "__tests__") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

describe("relayEnv", () => {
  const saved = process.env.X402_NETWORK;
  afterEach(() => {
    if (saved === undefined) delete process.env.X402_NETWORK;
    else process.env.X402_NETWORK = saved;
  });

  it("supplies every key the relay reads through the injected env seam", () => {
    const supplied = new Set(Object.keys(relayEnv()));
    const read = new Set<string>();
    for (const f of sources(SRC)) {
      const src = code(readFileSync(f, "utf8"));
      for (const m of src.matchAll(
        /(?<![.\w])env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g,
      ))
        read.add(m[1] ?? m[2]!);
      for (const m of src.matchAll(/\bparse(?:Bool|Int|Float)Env\(\s*["']([A-Z][A-Z0-9_]*)["']/g))
        read.add(m[1]!);
    }
    for (const chain of Object.keys(CONFIRMATIONS_BY_CHAIN))
      read.add("X402_RPC_URL_" + chain.toUpperCase().replace(/[^A-Z0-9]/g, "_"));
    expect(read.size).toBeGreaterThan(30);
    const missing = [...read].filter((k) => !supplied.has(k) && !OWN_FALLBACK.has(k)).sort();
    expect(missing, "add each as `NAME: process.env.NAME` in relayEnv() (env.ts)").toEqual([]);
  });

  it("reads the live environment on every call", () => {
    process.env.X402_NETWORK = "eip155:8453";
    expect(relayEnv().X402_NETWORK).toBe("eip155:8453");
    delete process.env.X402_NETWORK;
    expect(relayEnv().X402_NETWORK).toBeUndefined();
  });
});

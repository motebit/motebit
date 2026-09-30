/**
 * probe-turbo-remote-cache-signing (#997) — the behavioural proof, run as a
 * gate self-test: real turbo, a local fake Vercel remote cache, no token and
 * no network. Two directions:
 *
 *   - the repo's own turbo.json signs every PUT and refuses an unsigned or
 *     foreign-key entry (and a key-less run neither fails nor writes);
 *   - the probe BITES: a turbo.json without `remoteCache.signature` is caught
 *     uploading unsigned and replaying the planted POISON artifact — so a
 *     green first test is a statement about the config, not a blind probe.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runSigningProbe } from "../probe-turbo-remote-cache-signing.js";

const TIMEOUT = 240_000;

describe("turbo remote-cache signing (fake cache)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it(
    "the repo's turbo.json: signed PUTs, unsigned / wrong-key / key-less GETs are misses",
    async () => {
      const r = await runSigningProbe();
      const failed = r.expectations.filter((x) => !x.ok).map((x) => `${x.scenario}: ${x.claim}`);
      expect(failed).toEqual([]);
      const byName = Object.fromEntries(r.runs.map((x) => [x.scenario, x]));
      expect(byName["attacker-signed-put"]!.unsignedPuts).toBe(0);
      expect(byName["wrong-key-miss"]!.dist).toBe("clean");
      expect(byName["unsigned-miss"]!.dist).toBe("clean");
      expect(byName["right-key-hit"]!.outcome).toBe("hit");
      expect(byName["no-key-write"]!.exitCode).toBe(0);
      expect(byName["no-key-write"]!.puts).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "bites: without remoteCache.signature the planted artifact is replayed",
    async () => {
      const d = mkdtempSync(join(tmpdir(), "turbo-unsigned-"));
      dirs.push(d);
      const p = join(d, "turbo.json");
      writeFileSync(p, JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }));
      const r = await runSigningProbe(p);
      expect(r.ok).toBe(false);
      const byName = Object.fromEntries(r.runs.map((x) => [x.scenario, x]));
      expect(byName["attacker-signed-put"]!.unsignedPuts).toBeGreaterThan(0);
      expect(byName["wrong-key-miss"]!.outcome).toBe("hit");
      expect(byName["wrong-key-miss"]!.dist).toBe("POISON");
      expect(byName["unsigned-miss"]!.dist).toBe("POISON");
    },
    TIMEOUT,
  );
});

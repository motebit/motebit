/**
 * check-gates-effective — concurrent-modification detection.
 *
 * The meta-gate mutates real files in place to inject probes, so its verdict is
 * only meaningful if the injected bytes are still on disk when the gate reads
 * them. If a concurrent build / typecheck / formatter / second invocation
 * rewrites a probe target mid-run, a gate "passing" is an artifact of the race,
 * not a dead gate. Before this guard that surfaced as the misleading "one or
 * more gates failed to catch a known violation" (a real false-fail observed
 * 2026-06-07 when a `pnpm typecheck` ran alongside a push's pre-push hook).
 *
 * `findClobberedPerturbations()` is what lets the runner tell the two apart.
 * Imported directly — `main()` is guarded behind a direct-invocation check, so
 * importing the module does not execute the 120-probe run.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  writeFixture,
  findClobberedPerturbations,
  PROBES,
  probeKeys,
  partitionProbes,
  partitionProblems,
  shardOfScript,
  parseShard,
  parseCli,
  probeSetDigest,
  verifyShardManifests,
  budgetWarnings,
  SHARD_PROBE_BUDGET_SECONDS,
  SLOW_PROBE_SECONDS,
  type ShardManifest,
} from "../check-gates-effective.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const REL = "scripts/__tests__/__gate_probe__clobber_unit.txt";
const ABS = resolve(ROOT, REL);

let cleanup: (() => void) | null = null;
afterEach(() => {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* best-effort deregister */
    }
    cleanup = null;
  }
  if (existsSync(ABS)) unlinkSync(ABS);
});

describe("check-gates-effective — concurrent-modification detection", () => {
  it("reports no clobber when the perturbation is intact on disk", () => {
    cleanup = writeFixture(REL, "probe-bytes\n");
    expect(findClobberedPerturbations()).toEqual([]);
  });

  it("reports a clobber when the probe target is rewritten underneath the run", () => {
    cleanup = writeFixture(REL, "probe-bytes\n");
    // Simulate a concurrent writer clobbering the injected bytes.
    writeFileSync(ABS, "rewritten by a concurrent process\n");
    expect(findClobberedPerturbations()).toContain(REL);
  });

  it("reports a clobber when the probe target is deleted underneath the run", () => {
    cleanup = writeFixture(REL, "probe-bytes\n");
    unlinkSync(ABS); // deleted out from under us also counts as clobbered
    expect(findClobberedPerturbations()).toContain(REL);
  });

  it("deregisters on cleanup — a restored perturbation is no longer tracked", () => {
    const c = writeFixture(REL, "probe-bytes\n");
    c(); // probe cleaned up
    cleanup = null;
    // Even though the file is gone, it was deregistered, so it is not reported.
    expect(findClobberedPerturbations()).toEqual([]);
  });
});

describe("check-gates-effective — sharding is a partition of the full probe set", () => {
  const all = probeKeys(PROBES);

  it("probe keys are unique and cover every probe (duplicate gates get #n)", () => {
    expect(new Set(all).size).toBe(PROBES.length);
    expect(all.length).toBe(PROBES.length);
  });

  it.each([1, 2, 3, 4, 5, 8])("N=%i: union of shards = every probe, pairwise disjoint", (n) => {
    const shards = partitionProbes(PROBES, n);
    expect(shards).toHaveLength(n);
    expect(partitionProblems(all, shards)).toEqual([]);
    expect(shards.flat().sort()).toEqual([...all].sort());
  });

  it("the CI shard count (4) leaves no shard empty", () => {
    for (const s of partitionProbes(PROBES, 4)) expect(s.length).toBeGreaterThan(0);
  });

  it("every probe of one gate lands in one shard (assignment by gate name)", () => {
    const shards = partitionProbes(PROBES, 4);
    const shardOf = new Map<string, number>();
    shards.forEach((keys, i) => {
      for (const k of keys) {
        const script = k.slice(0, k.lastIndexOf("#"));
        expect(shardOf.get(script) ?? i).toBe(i);
        shardOf.set(script, i);
      }
    });
  });

  it("is deterministic (stable hash, not order- or run-dependent)", () => {
    expect(partitionProbes(PROBES, 4)).toEqual(partitionProbes(PROBES, 4));
    expect(shardOfScript("check-deps", 4)).toBe(shardOfScript("check-deps", 4));
    const reversed = partitionProbes([...PROBES].reverse(), 4).map((s) => new Set(s));
    // Same gate → same shard regardless of registry order.
    for (const p of PROBES) {
      const i = shardOfScript(p.script, 4) - 1;
      expect([...reversed[i]!].some((k) => k.startsWith(`${p.script}#`))).toBe(true);
    }
  });

  it("FAILS when a probe is assigned to no shard", () => {
    const shards = partitionProbes(PROBES, 4);
    const dropped = shards[2]!.pop()!;
    expect(partitionProblems(all, shards)).toContain(`${dropped} is assigned to no shard`);
  });

  it("FAILS when a probe is assigned to two shards", () => {
    const shards = partitionProbes(PROBES, 4);
    shards[0]!.push(shards[1]![0]!);
    expect(partitionProblems(all, shards).join("\n")).toMatch(/is in shard 1 AND shard 2/);
  });

  it("parseShard rejects anything but 1 <= i <= N", () => {
    expect(parseShard("2/4")).toEqual({ index: 2, of: 4 });
    for (const bad of ["0/4", "5/4", "4", "a/b", "1/0", "-1/4", "1.5/4", ""]) {
      expect(() => parseShard(bad)).toThrow(/--shard expects/);
    }
    expect(() => parseCli(["--shard"])).toThrow(/needs a value/);
    expect(() => parseCli(["--bogus"])).toThrow(/unknown argument/);
  });

  const manifests = (n: number): ShardManifest[] =>
    partitionProbes(PROBES, n).map((ran, i) => ({
      shard: i + 1,
      of: n,
      total: PROBES.length,
      probeSetDigest: probeSetDigest(all),
      ran,
      skipped: [],
      passed: true,
      probeSeconds: 1,
    }));

  it("--verify-shards accepts the full set of passing manifests", () => {
    expect(verifyShardManifests(all, manifests(4))).toEqual([]);
  });

  it("--verify-shards FAILS on a missing shard (cancelled / never uploaded)", () => {
    const m = manifests(4).filter((x) => x.shard !== 3);
    const problems = verifyShardManifests(all, m).join("\n");
    expect(problems).toMatch(/shard 3\/4 reported 0 manifest/);
    expect(problems).toMatch(/is assigned to no shard/);
  });

  it("--verify-shards FAILS on no manifests, a failed shard, a duplicate or a stale probe set", () => {
    expect(verifyShardManifests(all, [])).toEqual([
      "no shard manifests found — no shard reported a run",
    ]);
    const failed = manifests(4);
    failed[1]!.passed = false;
    expect(verifyShardManifests(all, failed).join("\n")).toMatch(/shard 2\/4 did not pass/);
    const dup = [...manifests(4), manifests(4)[0]!];
    expect(verifyShardManifests(all, dup).join("\n")).toMatch(/shard 1\/4 reported 2 manifest/);
    const stale = manifests(4);
    stale[0]!.probeSetDigest = "0000000000000000";
    expect(verifyShardManifests(all, stale).join("\n")).toMatch(/different probe set/);
  });

  it("budget: a shard past 75% of its budget, or a probe over the slow line, warns", () => {
    expect(budgetWarnings(0.5 * SHARD_PROBE_BUDGET_SECONDS, [])).toEqual([]);
    expect(budgetWarnings(0.8 * SHARD_PROBE_BUDGET_SECONDS, [])[0]).toMatch(
      /^::warning .*over 75% of the/,
    );
    expect(budgetWarnings(1, [{ key: "check-x#1", seconds: SLOW_PROBE_SECONDS + 1 }])[0]).toMatch(
      /check-x#1 took/,
    );
  });
});

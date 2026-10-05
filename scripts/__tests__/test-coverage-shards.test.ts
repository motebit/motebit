/**
 * test-coverage-shards — CI's sharded `turbo run test:coverage` must run every
 * suite exactly once. Over the real repo the computed assignment is a
 * partition with relay alone in shard 1; a planted package with no weight, a
 * stale weight, a dropped or duplicated package, and a missing / duplicated /
 * mislabelled shard manifest are each RED.
 */
import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHARD_WEIGHTS,
  SOLO,
  assignShards,
  coveragePackages,
  readPackageScripts,
  turboArgs,
  verifyManifests,
  verifyPartition,
} from "../test-coverage-shards.js";
import { CI_JOBS } from "../check-prepush-subset.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKGS = coveragePackages(readPackageScripts(ROOT));
const N = (CI_JOBS["test-coverage"]!.strategy as { matrix: { shard: string[] } }).matrix.shard
  .length;

describe("the real repo's assignment", () => {
  const a = assignShards(PKGS, N);

  it("has a weight for every package with test:coverage, and no stale weight", () => {
    expect(a.violations).toEqual([]);
  });

  it("partitions every package into exactly one shard", () => {
    expect(PKGS.length).toBeGreaterThan(10);
    expect(verifyPartition(PKGS, a.shards)).toEqual([]);
    expect(a.shards.flat().sort()).toEqual(PKGS);
  });

  it("puts relay alone in shard 1", () => {
    expect(a.shards[0]).toEqual([SOLO]);
    expect(a.shards.slice(1).flat()).not.toContain(SOLO);
  });

  it("is deterministic and turns each shard into one filter per package", () => {
    expect(assignShards(PKGS, N)).toEqual(a);
    for (const s of a.shards)
      expect(turboArgs(s)).toEqual([
        "run",
        "test:coverage",
        "--concurrency=4",
        ...s.map((d) => `--filter=./${d}`),
      ]);
  });

  it("is a partition for any shard count", () => {
    for (let n = 2; n <= 6; n++) {
      const b = assignShards(PKGS, n);
      expect(b.violations).toEqual([]);
      expect(verifyPartition(PKGS, b.shards)).toEqual([]);
    }
  });
});

describe("planted defects are RED", () => {
  it("a package with test:coverage and no weight (unassigned)", () => {
    const v = assignShards([...PKGS, "packages/zz-planted"], N).violations;
    expect(v.join("\n")).toMatch(/packages\/zz-planted .*no weight/);
  });

  it("a weight for a package that no longer has test:coverage (stale)", () => {
    const v = assignShards(PKGS, N, { ...SHARD_WEIGHTS, "packages/zz-gone": 1 }).violations;
    expect(v.join("\n")).toMatch(/packages\/zz-gone.*stale/);
  });

  it("relay without a test:coverage script", () => {
    const v = assignShards(
      PKGS.filter((p) => p !== SOLO),
      N,
    ).violations;
    expect(v.join("\n")).toMatch(/solo shard would run nothing/);
  });

  it("fewer than two shards", () => {
    expect(assignShards(PKGS, 1).violations).not.toEqual([]);
  });

  it("a package dropped from, or duplicated across, the shards", () => {
    const { shards } = assignShards(PKGS, N);
    const dropped = shards.map((s, i) => (i === 1 ? s.slice(1) : s));
    expect(verifyPartition(PKGS, dropped).join("\n")).toMatch(/in no shard/);
    const dup = shards.map((s, i) => (i === 2 ? [...s, shards[1]![0]!] : s));
    expect(verifyPartition(PKGS, dup).join("\n")).toMatch(/runs twice/);
  });
});

describe("the verdict job's manifest proof", () => {
  const { shards } = assignShards(PKGS, N);
  const manifests = shards.map((packages, i) => ({ shard: `${i + 1}/${N}`, packages }));

  it("accepts every shard's manifest", () => {
    expect(verifyManifests(PKGS, manifests)).toEqual([]);
  });

  it("rejects a missing shard manifest", () => {
    expect(verifyManifests(PKGS, manifests.slice(1))).not.toEqual([]);
  });

  it("rejects no manifests at all", () => {
    expect(verifyManifests(PKGS, [])).not.toEqual([]);
  });

  it("rejects a shard reported twice", () => {
    const twice = [...manifests.slice(0, -1), { ...manifests[0]! }];
    expect(verifyManifests(PKGS, twice).join("\n")).toMatch(/reported twice/);
  });

  it("rejects a shard that ran fewer packages than assigned", () => {
    const short = manifests.map((m, i) => (i === 1 ? { ...m, packages: m.packages.slice(1) } : m));
    expect(verifyManifests(PKGS, short).join("\n")).toMatch(/in no shard/);
  });
});

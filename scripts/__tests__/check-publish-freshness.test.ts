/**
 * check-publish-freshness (#161) — the pure half against fixtures, and the
 * runner against a registry the test controls, so every verdict is proven to
 * BITE: behind, unpublished, ahead, unreachable-with-require, pending inside
 * the grace window, and the empty aperture. The external gates carry no
 * `check-gates-effective` probe (they are excluded from the static pass), so
 * this file is where their firing is proven.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classify,
  compareVersions,
  parseWorkspaceGlobs,
  publishablePackages,
  readRegistryDocument,
  runPublishFreshness,
} from "../lib/publish-freshness.js";

describe("parseWorkspaceGlobs", () => {
  it("reads this repo's shape and ignores comments and other keys", () => {
    expect(
      parseWorkspaceGlobs(
        `# comment\npackages:\n  - "packages/*"\n  - 'apps/*'\n  - services/* # trailing\ncatalog:\n  - not-a-glob\n`,
      ),
    ).toEqual(["packages/*", "apps/*", "services/*"]);
  });
  it("returns nothing when there is no packages key", () => {
    expect(parseWorkspaceGlobs("catalog:\n  - x\n")).toEqual([]);
  });
});

describe("publishablePackages", () => {
  it("keeps public manifests, drops private ones, missing ones and unparseable ones", () => {
    const root = mkdtempSync(join(tmpdir(), "pf-ws-"));
    const put = (dir: string, body: string) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), body);
    };
    put("packages/pub", JSON.stringify({ name: "@x/pub", version: "1.2.3" }));
    put("packages/priv", JSON.stringify({ name: "@x/priv", version: "9.9.9", private: true }));
    put("packages/broken", "{not json");
    mkdirSync(join(root, "packages/no-manifest"));
    put("apps/cli", JSON.stringify({ name: "cli", version: "0.1.0" }));
    expect(publishablePackages(root, ["packages/*", "apps/*", "services/*"])).toEqual([
      { name: "@x/pub", version: "1.2.3", dir: "packages/pub" },
      { name: "cli", version: "0.1.0", dir: "apps/cli" },
    ]);
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically, and pre-release below release", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("3.20.0", "3.20.0")).toBe(0);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBeGreaterThan(0);
  });
});

describe("readRegistryDocument + classify", () => {
  it("maps registry statuses to standings", () => {
    expect(classify("1.0.0", readRegistryDocument(404, ""))).toEqual({ kind: "unpublished" });
    expect(
      classify("1.0.0", readRegistryDocument(200, '{"dist-tags":{"latest":"1.0.0"}}')),
    ).toEqual({
      kind: "current",
    });
    expect(
      classify("1.1.0", readRegistryDocument(200, '{"dist-tags":{"latest":"1.0.0"}}')),
    ).toEqual({
      kind: "behind",
      latest: "1.0.0",
    });
    expect(
      classify("1.0.0", readRegistryDocument(200, '{"dist-tags":{"latest":"1.1.0"}}')),
    ).toEqual({
      kind: "ahead",
      latest: "1.1.0",
    });
    expect(classify("1.0.0", readRegistryDocument(503, "")).kind).toBe("unreachable");
    expect(classify("1.0.0", readRegistryDocument(200, "{}")).kind).toBe("unreachable");
    expect(classify("1.0.0", readRegistryDocument(200, "nope")).kind).toBe("unreachable");
  });
});

/**
 * The runner in-process, with a registry the test controls and a bump clock it
 * sets, so every verdict is proven to BITE without a network or a child
 * process: behind, unpublished, ahead, unreachable-with-require, pending inside
 * the grace window, and the empty aperture.
 */
describe("the gate bites", () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-09-23T12:00:00Z");

  function workspace(version = "1.0.0"): string {
    const root = mkdtempSync(join(tmpdir(), "pf-gate-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    mkdirSync(join(root, "packages/one"), { recursive: true });
    writeFileSync(
      join(root, "packages/one/package.json"),
      JSON.stringify({ name: "@pf-test/one", version }),
    );
    return root;
  }

  type Registry = { status: number; body?: unknown } | "hang";
  function run(registry: Registry, extra: Partial<Parameters<typeof runPublishFreshness>[0]> = {}) {
    const lines: string[] = [];
    const opts: Parameters<typeof runPublishFreshness>[0] = {
      root: workspace(),
      registry: "https://registry.test",
      requireRegistry: false,
      pendingHours: 6,
      fetch: async (url) => {
        if (registry === "hang") throw new Error(`ECONNREFUSED ${url}`);
        return { status: registry.status, text: async () => JSON.stringify(registry.body ?? {}) };
      },
      versionBumpedAt: () => new Date(NOW - 24 * HOUR), // a day ago: no grace
      now: () => NOW,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
      ...extra,
    };
    return runPublishFreshness(opts).then((r) => ({ ...r, out: lines.join("\n") }));
  }
  const serving = (latest: string): Registry => ({
    status: 200,
    body: { "dist-tags": { latest } },
  });

  it("is green when the registry serves main's version, and states its aperture", async () => {
    const r = await run(serving("1.0.0"));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 publishable package\(s\) examined/);
  });

  it("reds on [behind] with the token repair, and names the manifest", async () => {
    const r = await run(serving("0.9.0"));
    expect(r.code).toBe(1);
    expect(r.findings.map((f) => f.standing.kind)).toEqual(["behind"]);
    expect(r.out).toMatch(/\[behind\] @pf-test\/one \(packages\/one\/package\.json\)/);
    expect(r.out).toMatch(/NPM_TOKEN/);
    expect(r.out).toMatch(/release\.yml/);
  });

  it("reds on [unpublished] when the registry has never seen the name", async () => {
    const r = await run({ status: 404 });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[unpublished\] @pf-test\/one/);
  });

  it("reds on [ahead] when the registry is newer than main", async () => {
    const r = await run(serving("2.0.0"));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[ahead\] @pf-test\/one/);
  });

  it("skips politely on an unreachable registry, and reds with requireRegistry", async () => {
    for (const registry of [{ status: 503 } as Registry, "hang" as Registry]) {
      const soft = await run(registry);
      expect(soft.code).toBe(0);
      expect(soft.out).toMatch(/unreachable/);
      const strict = await run(registry, { requireRegistry: true });
      expect(strict.code).toBe(1);
      expect(strict.out).toMatch(/\[unreachable\]/);
    }
  });

  it("treats a bump younger than the grace window as pending, never behind", async () => {
    const fresh = { versionBumpedAt: () => new Date(NOW - 1 * HOUR) };
    const r = await run(serving("0.9.0"), fresh);
    expect(r.code).toBe(0);
    expect(r.pending).toBe(1);
    expect(r.out).toMatch(/publish still pending/);
    // A zero-hour window makes the same state a finding …
    expect((await run(serving("0.9.0"), { ...fresh, pendingHours: 0 })).code).toBe(1);
    // … and so does a bump time git cannot answer: unknown is not grace.
    expect((await run(serving("0.9.0"), { versionBumpedAt: () => null })).code).toBe(1);
  });

  it("reds on an empty aperture instead of passing over nothing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pf-empty-"));
    writeFileSync(join(empty, "pnpm-workspace.yaml"), 'packages:\n  - "nowhere/*"\n');
    const r = await run(serving("1.0.0"), { root: empty });
    expect(r.code).toBe(1);
    expect(r.examined).toBe(0);
    expect(r.out).toMatch(/0 publishable packages/);
  });
});

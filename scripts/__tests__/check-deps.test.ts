/**
 * check-deps — the layer DAG must actually be enforced for every mapped package.
 *
 * Regression cover for #544. `APP_LAYER` used to be `6`, and both layer checks
 * are written as `... && effectiveLayer !== APP_LAYER`, so **every package
 * explicitly mapped to layer 6 inherited the application tier's exemption and
 * received zero layer enforcement.** That bucket was not only apps: it held
 * `@motebit/verifier`, `@motebit/verify` and `@motebit/state-export-client` —
 * three published Apache-2.0 libraries, one of which external consumers build
 * against under the `check-api-surface` guarantee.
 *
 * The proof was already in the tree: `@motebit/verify` had production
 * dependencies on two other layer-6 packages, which fails anywhere else in the
 * DAG and is not on `SAME_LAYER_PROD_ALLOWED`. It passed only because the check
 * never ran for those packages. A gate that is green because it is not looking
 * is the flaw class `composition-preserves-enforcement.md` names.
 *
 * These tests drive the REAL gate over a perturbed manifest, so they fail if
 * the exemption ever leaks back to mapped packages.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-deps.ts");

/** Run the real gate with one package.json temporarily mutated. */
function runWithManifest(pkgPath: string, mutate: (m: Record<string, never>) => void): string {
  const full = resolve(ROOT, pkgPath);
  const backup = `${full}.deps-test-backup`;
  cpSync(full, backup);
  try {
    const manifest = JSON.parse(readFileSync(full, "utf-8")) as Record<string, never>;
    mutate(manifest);
    writeFileSync(full, `${JSON.stringify(manifest, null, 2)}\n`);
    const r = spawnSync("npx", ["tsx", SCRIPT], { cwd: ROOT, encoding: "utf8" });
    return `${r.stdout}\n${r.stderr}`;
  } finally {
    cpSync(backup, full);
    rmSync(backup, { force: true });
  }
}

function runClean(): string {
  const r = spawnSync("npx", ["tsx", SCRIPT], { cwd: ROOT, encoding: "utf8" });
  return `${r.stdout}\n${r.stderr}`;
}

const VERIFIER = "packages/verifier/package.json";

describe("check-deps layer enforcement", () => {
  afterEach(() => {
    const stale = resolve(ROOT, `${VERIFIER}.deps-test-backup`);
    if (existsSync(stale)) rmSync(stale, { force: true });
  });

  it("passes on the repo as committed", () => {
    expect(runClean()).toContain("All architectural checks passed");
  });

  it("catches a published verification library reaching up the DAG", () => {
    // The exact scenario #544 names: "an accidental @motebit/runtime prod dep
    // added to @motebit/verifier would not be caught."
    const out = runWithManifest(VERIFIER, (m) => {
      (m.dependencies as unknown as Record<string, string>)["@motebit/runtime"] = "workspace:*";
    });

    expect(out).toContain("@motebit/verifier");
    expect(out).toContain("@motebit/runtime");
    expect(out).toMatch(/production dependencies must be in a strictly lower layer/);
    expect(out).not.toContain("All architectural checks passed");
  });

  it("catches a BSL dependency declared in a permissive manifest with NO source import", () => {
    // The purity check scanned `src/` imports only, so a manifest edge that
    // nothing imported was invisible — yet it ships in the published
    // package.json and is installed by every consumer.
    const out = runWithManifest(VERIFIER, (m) => {
      (m.dependencies as unknown as Record<string, string>)["@motebit/memory-graph"] =
        "workspace:*";
    });

    expect(out).toContain("permissive-purity");
    expect(out).toContain("declares a production dependency on BSL package");
    expect(out).toContain("@motebit/memory-graph");
  });

  it("catches a library depending on an application", () => {
    // Dependency-side layers used to resolve through the `LAYER` map alone, so
    // apps and services — absent from that map — came back `undefined` and were
    // silently skipped. A library depending on an APPLICATION is the most
    // inverted edge possible and was never checked.
    const out = runWithManifest(VERIFIER, (m) => {
      (m.dependencies as unknown as Record<string, string>)["motebit"] = "workspace:*";
    });

    expect(out).toContain("@motebit/verifier");
    expect(out).toMatch(/"motebit"/);
    expect(out).not.toContain("All architectural checks passed");
  });

  it("keeps the application tier itself exempt", () => {
    // The exemption is correct FOR APPS — an app is the top of the DAG and may
    // depend on any layer. Narrowing it must not have removed that.
    const out = runWithManifest("apps/cli/package.json", (m) => {
      (m.dependencies as unknown as Record<string, string>)["@motebit/protocol"] = "workspace:*";
    });

    expect(out).toContain("All architectural checks passed");
  });
});

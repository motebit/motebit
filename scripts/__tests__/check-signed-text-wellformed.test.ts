/**
 * check-signed-text-wellformed — tamper test + real-repo smoke.
 *
 * `--fixture` scans only `signed-text-wellformed-fixture/`: every planted
 * signer in bypass.ts (direct canonicalJson, the `sign` product alias, bytes
 * from an untraceable helper) and bypass-holes.ts (a primitive reached by
 * property access — namespace import, noble `ed.signAsync`, element access, a
 * re-bound method — and decoy guards whose output is not what gets signed)
 * must be flagged, and none in guarded.ts / guarded-traced.ts (direct guard,
 * guard handed to a bytes helper, a verify twin, a namespace import, guarded
 * bytes through variables / a digest / a buffer of guarded digests, Math.sign).
 * If someone weakens the scan, a planted bypass stops flagging and this test
 * fails.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-signed-text-wellformed.ts");
const FIXTURE = resolve(__dirname, "signed-text-wellformed-fixture");

describe("check-signed-text-wellformed", () => {
  it("flags every planted bypassing signer and no guarded one", () => {
    const r = spawnSync("npx", ["tsx", SCRIPT, "--fixture", FIXTURE], {
      encoding: "utf-8",
      cwd: ROOT,
    });
    expect(r.status).toBe(1);
    for (const fn of [
      "signPlantedReceipt",
      "signPlantedAlias",
      "signPlantedUntraced",
      "signPlantedNamespace",
      "signPlantedNoble",
      "signPlantedElementAccess",
      "signPlantedRebound",
      "signPlantedDecoy",
      "signPlantedDecoyUntraced",
      "signPlantedReassigned",
    ]) {
      expect(r.stderr).toContain(`${fn}()`);
    }
    expect(r.stderr).not.toContain("guarded.ts");
    expect(r.stderr).not.toContain("guarded-traced.ts");
    expect(r.stderr).toContain("10 signer(s)");
    // Repair instruction: the canonical source and the fix.
    expect(r.stderr).toContain("packages/crypto/src/signing.ts");
    expect(r.stderr).toContain("Fix:");
  });

  it("passes on the real repo and states its aperture", () => {
    const r = spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf-8", cwd: ROOT });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\d+ signing call site\(s\) in \d+ source file\(s\) scanned/);
  });
});

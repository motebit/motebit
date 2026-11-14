/**
 * check-third-party-tx-signing — tamper test + real-repo smoke.
 *
 * `--fixture` scans only `third-party-tx-signing-fixture/`: every planted
 * deserialize-then-sign shape in planted.ts (the Jupiter shape, a legacy
 * chain, a namespace import, raw message bytes, a decoding helper, a hand-off
 * to a local signing helper, a wallet adapter, @solana/kit, a callback, an
 * object field, web3.js sendTransaction, a destructured alias, a reassignment)
 * must be flagged, as must every shape in planted-widened.ts (const / require /
 * member aliases, a destructured-parameter signer, an anonymous default-export
 * signer, kit multi-signers, sodium, and raw network bytes reaching a signer or
 * sendRawTransaction); nothing in clean.ts / clean-network.ts (locally built
 * legacy and v0 transactions, a local signing helper fed a local build,
 * decode-only reads, verify-only network bytes) may be. clean-network.ts also
 * holds the documented blind spot (a local build from third-party
 * instructions): it passes, and the printed blind spots must name it.
 * If someone weakens the scan, a planted shape stops flagging and this fails.
 *
 * Tamper: packages/wallet-solana/src/__tests__/jupiter-containment.tampers.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-third-party-tx-signing.ts");
const FIXTURE = resolve(__dirname, "third-party-tx-signing-fixture");

const PLANTED = [
  "plantedJupiterShape",
  "plantedLegacyChain",
  "plantedNamespace",
  "plantedMessageBytes",
  "plantedViaHelper",
  "plantedHandOff",
  "plantedWalletAdapter",
  "plantedKit",
  "plantedCallback",
  "plantedObjectField",
  "plantedSendTransaction",
  "plantedDestructuredAlias",
  "plantedReassigned",
  // planted-widened.ts — the shapes the cold review slipped past v1.
  "plantedConstAlias",
  "plantedRequireAlias",
  "plantedMemberAlias",
  "plantedPatternParam",
  "plantedDefaultExportSigner",
  "plantedKitModifyAndSign",
  "plantedKitSignAndSendMany",
  "plantedSodium",
  "plantedRawNetworkBytes",
  "plantedRawBroadcast",
  "plantedBase64Decode",
  "plantedBinaryBody",
];

describe("check-third-party-tx-signing", () => {
  it("flags every planted deserialize-then-sign shape and no clean one", () => {
    const r = spawnSync("npx", ["tsx", SCRIPT, "--fixture", FIXTURE], {
      encoding: "utf-8",
      cwd: ROOT,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    for (const fn of PLANTED) expect(r.stderr).toContain(`${fn}()`);
    expect(r.stderr).toContain(`${PLANTED.length} site(s)`);
    expect(r.stderr).not.toContain("clean.ts");
    expect(r.stderr).not.toContain("clean-network.ts");
    expect(r.stderr).not.toContain("default-signer.ts");
    expect(r.stderr).not.toMatch(/\bclean[A-Z]\w*\(\)/);
    // Repair instruction: the canonical source and the fix.
    expect(r.stderr).toContain("scripts/check-third-party-tx-signing.ts (VALIDATOR_MODULES)");
    expect(r.stderr).toContain("Fix:");
  });

  it("does NOT catch a transaction built locally from third-party instructions, and says so", () => {
    // The documented blind spot (clean-network.ts blindSpotThirdPartyInstructions):
    // the gate passes it, and its printed blind spots must name it.
    const r = spawnSync("npx", ["tsx", SCRIPT, "--fixture", FIXTURE], {
      encoding: "utf-8",
      cwd: ROOT,
    });
    expect(r.stderr).not.toContain("blindSpotThirdPartyInstructions()");
    const pass = spawnSync("npx", ["tsx", SCRIPT, "--root", "packages/wallet-solana"], {
      encoding: "utf-8",
      cwd: ROOT,
    });
    expect(pass.stdout).toContain(
      "NOT CAUGHT: (1) a transaction built locally from third-party-supplied instructions",
    );
    expect(pass.stdout).toContain("/swap-instructions");
  });

  it("passes on the real repo and states its aperture and blind spots", () => {
    const r = spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf-8", cwd: ROOT });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /\d+ source file\(s\) scanned in packages\/, services\/, apps\/ .* \d+ transaction-decode site\(s\), \d+ network-bytes decode site\(s\), \d+ signing\/broadcast call site\(s\) examined, 0 signing a decoded transaction or network bytes, 0 validator module\(s\) registered/,
    );
    expect(r.stdout).toContain("NOT CAUGHT:");
  });

  it("stays green on wallet-solana's own locally built transfers, which it examines", () => {
    const r = spawnSync("npx", ["tsx", SCRIPT, "--root", "packages/wallet-solana"], {
      encoding: "utf-8",
      cwd: ROOT,
    });
    expect(r.status, r.stderr).toBe(0);
    const m = r.stdout.match(
      /(\d+) source file\(s\) scanned .* (\d+) transaction-decode site\(s\), \d+ network-bytes decode site\(s\), (\d+) signing\/broadcast call site\(s\) examined/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(5);
    // The adapter, memo submitter and operator transfer sign local builds.
    expect(Number(m![3])).toBeGreaterThan(0);
  });
});

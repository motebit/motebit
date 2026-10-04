/**
 * The Solana RPC default, pinned by execution (incident 2026-09-30).
 *
 * A provider URL is never a browser value: built with no VITE_SOLANA_RPC_URL,
 * the shipped bundle must point the anchor/revocation cross-checks at motebit's
 * server-side passthrough — never at a public or provider endpoint. Cold review
 * R2: reverting main.ts's default stayed green until this ran the real build.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "verify");
const PASSTHROUGH = "https://api.motebit.com/v1/solana-rpc";
const out = mkdtempSync(join(tmpdir(), "verify-rpc-default-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function build(extra: Record<string, string>, outDir: string): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/i.test(k)) env[k] = v;
  }
  const vite = join(
    dirname(createRequire(join(APP, "package.json")).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
  const r = spawnSync(process.execPath, [vite, "build", APP, "--outDir", outDir], {
    cwd: APP,
    encoding: "utf-8",
    env: { ...env, ...extra },
    timeout: 120_000,
  });
  expect(r.status, r.stderr).toBe(0);
  const assets = join(outDir, "assets");
  return readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(assets, f), "utf-8"))
    .join("\n");
}

describe("apps/verify Solana RPC default (real vite build)", () => {
  it("with no VITE_SOLANA_RPC_URL the bundle uses the passthrough, never a public/provider RPC", () => {
    const js = build({}, join(out, "default"));
    // Present only if main.ts's default is the passthrough: reverting to the bare
    // env read or to a public endpoint removes it. (@motebit/state-export-client
    // carries its own mainnet-beta fallback, unused when rpcUrl is passed.)
    expect(js).toContain(PASSTHROUGH);
    expect(js).not.toMatch(/helius|alchemy|quiknode|rpcpool/i);
  }, 120_000);

  it("a local-dev override replaces the default", () => {
    const js = build({ VITE_SOLANA_RPC_URL: "http://localhost:8899" }, join(out, "override"));
    expect(js).toContain("http://localhost:8899");
    expect(js).not.toContain(PASSTHROUGH);
  }, 120_000);
});

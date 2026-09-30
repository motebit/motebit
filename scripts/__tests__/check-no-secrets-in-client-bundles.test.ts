/**
 * check-no-secrets-in-client-bundles — fixture round-trip + gate-mutation table.
 *
 * (1) The incident harness: `leaky/` reproduces 2026-09-30 exactly (a
 *     credential-named VITE_* read in source; the Helius `?api-key=<uuid>` URL in
 *     the built bundle). The gate must go RED on both arms; `clean/` must stay green.
 * (2) The mutation table: one committed sample per CREDENTIAL_RULES id. Deleting
 *     any rule turns its row red — asserted directly by re-scanning with that rule
 *     removed.
 * (3) The vite build guard (`assertPublicBuildEnv`) refuses every forbidden
 *     VITE_SOLANA_RPC_URL shape and accepts the passthrough + local-dev URLs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREDENTIAL_RULES,
  PUBLIC_ENV_ALLOWLIST,
  assertPublicBuildEnv,
  isSecretShapedEnvName,
  publicRpcUrlViolation,
  scanArtifactText,
} from "../lib/client-bundle-secrets.js";
import { runGate } from "../check-no-secrets-in-client-bundles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-no-secrets-in-client-bundles.ts");
const FIXTURE = resolve(__dirname, "client-bundle-secrets-fixture");
const FAKE_UUID = "00000000-0000-4000-8000-000000000000";

let tmp: string;

function stage(app: "leaky" | "clean"): string {
  const root = join(tmp, app);
  mkdirSync(join(root, "apps", app), { recursive: true });
  cpSync(join(FIXTURE, app, "src"), join(root, "apps", app, "src"), { recursive: true });
  cpSync(join(FIXTURE, app, "dist-template"), join(root, "apps", app, "dist"), { recursive: true });
  return root;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "client-bundle-secrets-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("incident harness (fixture round-trip)", () => {
  it("RED on the 2026-09-30 shape — both arms, value redacted", () => {
    const root = stage("leaky");
    const r = runGate(root);
    expect(r.staticFindings.some((f) => f.includes("VITE_HELIUS_API_KEY"))).toBe(true);
    expect(r.staticFindings.some((f) => f.includes("VITE_SOLANA_RPC_URL"))).toBe(true);
    expect(r.artifactFindings.some((f) => f.includes("query-api-key"))).toBe(true);
    for (const f of r.artifactFindings) expect(f).not.toContain(FAKE_UUID);

    const cli = spawnSync("npx", ["tsx", SCRIPT, "--root", root], { encoding: "utf-8", cwd: ROOT });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(
      /apps\/leaky\/dist\/assets\/main-Bx7kq2\.js @ offset \d+ — query-api-key/,
    );
    expect(cli.stderr).toContain("Canonical source: scripts/lib/client-bundle-secrets.ts");
    expect(cli.stderr + cli.stdout).not.toContain(FAKE_UUID);
  });

  it("GREEN on a correct surface (no false positive), with aperture", () => {
    const root = stage("clean");
    const r = runGate(root);
    expect(r.staticFindings).toEqual([]);
    expect(r.artifactFindings).toEqual([]);
    const cli = spawnSync("npx", ["tsx", SCRIPT, "--root", root], { encoding: "utf-8", cwd: ROOT });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toMatch(
      /\d+ app source file\(s\).*\d+ built artifact file\(s\) in 1 dist dir\(s\)/,
    );
  });

  it("--require-dist fails when a required app was not built", () => {
    const root = stage("clean");
    expect(runGate(root, ["clean"]).missingDist).toEqual([]);
    expect(runGate(root, ["web"]).missingDist).toEqual(["web"]);
  });
});

/** One committed sample per rule — the gate-mutation table. */
const RULE_SAMPLES: Record<string, string> = {
  "query-api-key": `fetch("https://mainnet.helius-rpc.com/?api-key=${FAKE_UUID}")`,
  "stripe-secret": `const s="sk_live_${"0".repeat(24)}"`,
  "github-token": `const g="ghp_${"a".repeat(36)}"`,
  "aws-access-key": `const a="AKIA${"A".repeat(16)}"`,
  "pem-private-key": `const p="-----BEGIN PRIVATE KEY-----\\n${"A".repeat(64)}"`,
  "slack-token": `const t="xoxb-${"1".repeat(12)}-abcdef"`,
  "llm-provider-key": `const k="sk-ant-api03-${"x".repeat(32)}"`,
  "jwt-known-issuer": (() => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `const j="${b({ alg: "HS256", typ: "JWT" })}.${b({ iss: "supabase", role: "service_role" })}.${"s".repeat(43)}"`;
  })(),
  "hex-bearer": `const authToken="${"ab".repeat(32)}"`,
};

describe("gate-mutation table: each rule deleted → its row red", () => {
  it("every rule has a committed sample (and vice versa)", () => {
    expect(Object.keys(RULE_SAMPLES).sort()).toEqual(CREDENTIAL_RULES.map((r) => r.id).sort());
  });

  for (const rule of CREDENTIAL_RULES) {
    it(`${rule.id}: caught with the rule, missed without it, value redacted`, () => {
      const sample = RULE_SAMPLES[rule.id]!;
      const hits = scanArtifactText(sample).filter((f) => f.rule === rule.id);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.redacted).toMatch(/…\(\d+ chars\)$/);
      const without = CREDENTIAL_RULES.filter((r) => r.id !== rule.id);
      expect(scanArtifactText(sample, without)).toEqual([]);
    });
  }

  it("does not flag public-by-design shapes", () => {
    for (const ok of [
      "https://api.motebit.com/v1/solana-rpc",
      "u.searchParams.get('api-key')",
      "`?api-key=${k}`",
      'const t="-----BEGIN PRIVATE KEY-----"+body',
      `const hash="${"ab".repeat(32)}"`,
      "pk_live_" + "0".repeat(24),
    ]) {
      expect(scanArtifactText(ok)).toEqual([]);
    }
  });
});

describe("static arm: credential-shaped public env names", () => {
  it("name classifier", () => {
    for (const n of [
      "VITE_HELIUS_API_KEY",
      "VITE_SOLANA_RPC_URL",
      "VITE_API_URL",
      "NEXT_PUBLIC_SECRET",
      "EXPO_PUBLIC_TOKEN",
      "VITE_PRIVATE_X",
      "VITE_DB_PASSWORD",
    ]) {
      expect(isSecretShapedEnvName(n)).toBe(true);
    }
    for (const n of [
      "VITE_RELAY_URL",
      "VITE_BROWSER_SANDBOX_URL",
      "VITE_MOTEBIT_ID",
      "EXPO_PUBLIC_MOTEBIT_RELAY_URL",
    ]) {
      expect(isSecretShapedEnvName(n)).toBe(false);
    }
  });

  it("every allowlist entry carries a reason", () => {
    for (const a of PUBLIC_ENV_ALLOWLIST) expect(a.why.length).toBeGreaterThan(20);
  });

  it("the real repo is green on the static arm (allowlist current, none stale)", () => {
    expect(runGate(ROOT).staticFindings).toEqual([]);
  });
});

describe("vite build guard: assertPublicBuildEnv / publicRpcUrlViolation", () => {
  it.each([
    [`https://mainnet.helius-rpc.com/?api-key=${FAKE_UUID}`, "key/token"],
    ["https://rpc.example.com/?apikey=abc", "key/token"],
    ["https://rpc.example.com/?token=abc", "key/token"],
    ["https://rpc.example.com/?key=abc", "key/token"],
    ["https://user:pass@rpc.example.com/", "userinfo"],
    ["https://rpc.example.com/?cluster=mainnet", "query string"],
    ["https://rpc.example.com/?", "query string"],
    ["not a url", "parseable"],
  ])("refuses %s", (url, why) => {
    expect(publicRpcUrlViolation(url)).toContain(why);
    expect(() => assertPublicBuildEnv({ VITE_SOLANA_RPC_URL: url }, "apps/test")).toThrow(
      /refusing to build/,
    );
  });

  it("accepts the passthrough, local dev, and unset", () => {
    for (const url of [
      "https://api.motebit.com/v1/solana-rpc",
      "http://localhost:3003/v1/solana-rpc",
      "http://127.0.0.1:8899",
      "",
    ]) {
      expect(publicRpcUrlViolation(url)).toBeNull();
    }
    expect(() =>
      assertPublicBuildEnv({ VITE_RELAY_URL: "https://relay.motebit.com" }, "apps/test"),
    ).not.toThrow();
  });

  it("refuses any other VITE_* value with a credential shape, never echoing it", () => {
    let msg = "";
    try {
      assertPublicBuildEnv({ VITE_SOMETHING: `sk_live_${"9".repeat(24)}` }, "apps/test");
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain("stripe-secret");
    expect(msg).not.toContain("9".repeat(24));
  });

  it("refuses a credential-shaped NAME even when the value looks harmless (whole-object import.meta.env inlines it)", () => {
    expect(() =>
      assertPublicBuildEnv({ VITE_BROWSER_SANDBOX_TOKEN: "abc123" }, "apps/web"),
    ).toThrow(/VITE_BROWSER_SANDBOX_TOKEN has a credential-shaped name/);
    expect(() => assertPublicBuildEnv({ VITE_HELIUS_API_KEY: "x" }, "apps/web")).toThrow(
      /refusing to build/,
    );
    expect(() =>
      assertPublicBuildEnv({ VITE_STRIPE_PUBLISHABLE_KEY: "pk_live_x" }, "apps/web", [
        "VITE_STRIPE_PUBLISHABLE_KEY",
      ]),
    ).not.toThrow();
  });

  it("the thrown message never contains the key", () => {
    let msg = "";
    try {
      assertPublicBuildEnv(
        { VITE_SOLANA_RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${FAKE_UUID}` },
        "apps/web",
      );
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain("VITE_SOLANA_RPC_URL");
    expect(msg).not.toContain(FAKE_UUID);
  });
});

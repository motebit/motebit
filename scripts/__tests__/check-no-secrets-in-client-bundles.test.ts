/**
 * check-no-secrets-in-client-bundles — fixture round-trip + gate-mutation table.
 *
 * (1) The incident harness: `leaky/` reproduces 2026-09-30 exactly (a
 *     credential-named VITE_* read in source; the Helius `?api-key=<uuid>` URL in
 *     the built bundle). The gate must go RED on both arms; `clean/` must stay green.
 * (2) The mutation table: one committed sample per CREDENTIAL_RULES id. Deleting
 *     any rule turns its row red — asserted directly by re-scanning with that rule
 *     removed.
 * (3) The public build env law (`PUBLIC_BUILD_ENV` / `enforcePublicBuildEnv`),
 *     deny by default: every R1 cold-review shape (key in a URL path, a
 *     non-credential name, a lowercase name, an unknown var, a non-http(s)
 *     protocol) is refused by the build guard AND by the gate's static + dist arms.
 * (4) Wiring, by execution: the real `vite build` of apps/web and apps/verify
 *     refuses a planted unlisted var; the operator's real prod env builds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CREDENTIAL_RULES,
  PUBLIC_BUILD_ENV,
  PUBLIC_ENV_ALLOWLIST,
  PUBLIC_ENV_SURFACES,
  enforcePublicBuildEnv,
  forbiddenEnvValues,
  isSecretShapedEnvName,
  publicBuildEnvGuard,
  publicEnvViolations,
  publicUrlViolation,
  scanArtifactForPublicEnvPairs,
  scanArtifactText,
} from "../lib/client-bundle-secrets.js";
import { WIRING_PROBE_VAR, checkWiring, runGate } from "../check-no-secrets-in-client-bundles.js";

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
      "VITE_helius_api_key",
      "vite_Some_Secret",
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

  it("a stale PUBLIC_ENV_ALLOWLIST entry is RED (repoRoot injected), a live one is not", () => {
    const root = join(tmp, "stale");
    mkdirSync(join(root, "apps", "tool", "src"), { recursive: true });
    writeFileSync(
      join(root, "apps", "tool", "src", "a.ts"),
      "export const t = import.meta.env.VITE_API_TOKEN;\n",
    );
    const live = { file: "apps/tool/src/a.ts", name: "VITE_API_TOKEN", why: "fixture: live" };
    const stale = { file: "apps/tool/src/gone.ts", name: "VITE_OLD_TOKEN", why: "fixture: stale" };
    const r = runGate(root, [], { repoRoot: root, allowlist: [live, stale] });
    expect(r.staticFindings).toEqual([
      "apps/tool/src/gone.ts — stale PUBLIC_ENV_ALLOWLIST entry for `VITE_OLD_TOKEN` (the file no longer references it); delete the entry",
    ]);
    // A fixture root that is not the allowlist's repo skips the stale check.
    expect(runGate(root, [], { allowlist: [live, stale] }).staticFindings).toEqual([]);
  });

  it("an ungoverned app's lowercase credential-shaped name is RED", () => {
    const root = join(tmp, "lower");
    mkdirSync(join(root, "apps", "tool", "src"), { recursive: true });
    writeFileSync(
      join(root, "apps", "tool", "src", "a.ts"),
      "export const k = import.meta.env.VITE_helius_api_key;\n",
    );
    expect(runGate(root).staticFindings.join("\n")).toContain("VITE_helius_api_key");
  });
});

// ── The public build env law ────────────────────────────────────────────────

/** Deterministic fake high-entropy material; never a real key, never printed. */
function fake(alphabet: string, n: number, seed = 7): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  return out;
}
const AN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const ALCHEMY_KEY = fake(AN, 32);
const QN_HEX = fake(HEX, 40, 11);

/** The R1 cold-review shapes: each shipped green under the value denylist. */
const R1_SHAPES: [label: string, env: Record<string, string>, why: RegExp][] = [
  [
    "key in URL path (Alchemy /v2/<key>)",
    { VITE_SOLANA_RPC_URL: `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` },
    /not in its host allowlist/,
  ],
  [
    "key in URL path (QuickNode /<40hex>/)",
    { VITE_SOLANA_RPC_URL: `https://x.solana-mainnet.quiknode.pro/${QN_HEX}/` },
    /not in its host allowlist/,
  ],
  [
    "key in URL path (Triton /<uuid>)",
    { VITE_SOLANA_RPC_URL: `https://motebit.rpcpool.com/${FAKE_UUID}` },
    /not in its host allowlist/,
  ],
  [
    "key in URL path on an ALLOWED host (/<uuid>)",
    { VITE_SOLANA_RPC_URL: `https://api.motebit.com/${FAKE_UUID}` },
    /high-entropy path segment/,
  ],
  [
    "non-credential name (VITE_RPC_ENDPOINT)",
    { VITE_RPC_ENDPOINT: `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` },
    /VITE_RPC_ENDPOINT is not in PUBLIC_BUILD_ENV\.web/,
  ],
  [
    "lowercase name (VITE_helius_api_key)",
    { VITE_helius_api_key: FAKE_UUID },
    /VITE_helius_api_key is not in PUBLIC_BUILD_ENV\.web/,
  ],
  ["lowercase prefix (vite_foo)", { vite_foo: "bar" }, /vite_foo is not in PUBLIC_BUILD_ENV\.web/],
  ["unknown var (VITE_FOO)", { VITE_FOO: "bar" }, /VITE_FOO is not in PUBLIC_BUILD_ENV\.web/],
  [
    "other public prefix (NEXT_PUBLIC_X)",
    { NEXT_PUBLIC_X: "y" },
    /NEXT_PUBLIC_X is not in PUBLIC_BUILD_ENV\.web/,
  ],
  [
    "Stripe secret under the publishable name",
    { VITE_STRIPE_PUBLISHABLE_KEY: `sk_live_${"0".repeat(24)}` },
    /not a Stripe publishable key/,
  ],
];

function refusal(env: Record<string, unknown>, app = "web"): string {
  try {
    enforcePublicBuildEnv(app, env);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

describe("build guard: the resolved-env law refuses every R1 shape (deny by default)", () => {
  it.each(R1_SHAPES)("%s", (_label, env, why) => {
    const msg = refusal(env);
    expect(msg).toContain("refusing to build");
    expect(msg).toMatch(why);
    for (const v of Object.values(env)) if (v.length > 8) expect(msg).not.toContain(v);
    expect(msg).not.toContain(ALCHEMY_KEY);
    expect(msg).not.toContain(FAKE_UUID);
  });

  it("the gate's static arm refuses the same NAMES in a governed surface's source", () => {
    const root = join(tmp, "static-law");
    mkdirSync(join(root, "apps", "web", "src"), { recursive: true });
    const names = [
      "VITE_RPC_ENDPOINT",
      "VITE_helius_api_key",
      "VITE_FOO",
      "NEXT_PUBLIC_X",
      "vite_foo",
    ];
    writeFileSync(
      join(root, "apps", "web", "src", "a.ts"),
      names.map((n, i) => `export const v${i} = import.meta.env.${n};`).join("\n") +
        "\nexport const ok = import.meta.env.VITE_PROXY_URL;\n",
    );
    const r = runGate(root);
    for (const n of names) {
      expect(r.staticFindings.some((f) => f.includes(`${n} is not in PUBLIC_BUILD_ENV.web`))).toBe(
        true,
      );
    }
    expect(r.staticFindings.some((f) => f.includes("VITE_PROXY_URL"))).toBe(false);
  });

  it("the gate's dist arm refuses the same NAMES + VALUES in the emitted env literal", () => {
    for (const [label, env, why] of R1_SHAPES) {
      const root = join(tmp, `dist-law-${label.replace(/\W+/g, "-")}`);
      mkdirSync(join(root, "apps", "web", "dist", "assets"), { recursive: true });
      const pairs = Object.entries(env)
        .map(([k, v]) => `${k}:\`${v}\``)
        .join(",");
      writeFileSync(
        join(root, "apps", "web", "dist", "assets", "main-x.js"),
        `const e={BASE_URL:\`/\`,DEV:!1,${pairs}};`,
      );
      const r = runGate(root);
      const law = r.artifactFindings.filter((f) => f.includes("public-env-law"));
      expect(law.length, label).toBeGreaterThan(0);
      expect(law.join("\n"), label).toMatch(why);
      for (const f of r.artifactFindings) expect(f).not.toContain(FAKE_UUID);
    }
  });

  it("the env-literal scanner reads every quote style and ignores minified ternaries", () => {
    expect(
      scanArtifactForPublicEnvPairs(
        `a={"VITE_A":"1",'VITE_B':'2',VITE_C:\`3\`},x=c.VITE_D!==\`\`?c.VITE_D:\`\${o}/v1\``,
      ).map((p) => `${p.name}=${p.value}`),
    ).toEqual(["VITE_A=1", "VITE_B=2", "VITE_C=3"]);
  });

  it.each([
    ["ftp://api.motebit.com/x", /uses ftp:/],
    ["javascript:alert(1)", /uses javascript:/],
    ["http://api.motebit.com/v1/solana-rpc", /uses http:/],
    ["https://user:pass@api.motebit.com/", /userinfo/],
    ["https://api.motebit.com/v1/solana-rpc?cluster=mainnet", /query string/],
    ["https://api.motebit.com/?", /query string/],
    ["https://api.motebit.com/#k", /fragment/],
    ["https://api.motebit.com.evil.example/", /not in its host allowlist/],
    ["https://evilmotebit.com/", /not in its host allowlist/],
    [" https://api.motebit.com/", /whitespace/],
    ["not a url", /parseable/],
  ])("URL validator refuses %s", (url, why) => {
    expect(publicUrlViolation(url, PUBLIC_BUILD_ENV_HOSTS)).toMatch(why);
  });

  it("accepts the operator's real prod env, the passthrough, local dev, and unset", () => {
    for (const url of [
      "https://api.motebit.com/v1/solana-rpc",
      "https://motebit.com/",
      "http://localhost:3003/v1/solana-rpc",
      "http://127.0.0.1:8899",
    ]) {
      expect(publicUrlViolation(url, PUBLIC_BUILD_ENV_HOSTS)).toBeNull();
    }
    expect(refusal(PROD_WEB_ENV)).toBe("");
    expect(refusal({ VITE_SOLANA_RPC_URL: "" })).toBe("");
    expect(refusal({ VITE_RELAY_URL: "https://relay.motebit.com" }, "verify")).toBe("");
    expect(refusal({ VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_abc" }, "verify")).toMatch(
      /not in PUBLIC_BUILD_ENV\.verify/,
    );
    expect(refusal({ VITE_X: "1" }, "nope")).toMatch(/no PUBLIC_BUILD_ENV entry/);
  });

  it("the guard plugin's config hook drops Vercel's VITE_VERCEL_* from process.env before vite reads it", () => {
    const proc: Record<string, string | undefined> = {
      VITE_VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
      VITE_VERCEL_URL: "motebit-web-abc.vercel.app",
      PATH: "/bin",
    };
    publicBuildEnvGuard("web", proc).config();
    expect(proc).toEqual({ PATH: "/bin" });
    // The same name in Vite's resolved env (e.g. from a .env file) is an unknown var → refused.
    expect(refusal({ VITE_VERCEL_URL: "x" })).toMatch(/not in PUBLIC_BUILD_ENV\.web/);
  });

  it("VITE_USER_NODE_ENV is an enum: a mode label passes, anything else is refused", () => {
    for (const ok of ["production", "development", "test"]) {
      expect(refusal({ VITE_USER_NODE_ENV: ok })).toBe("");
      expect(refusal({ VITE_USER_NODE_ENV: ok }, "verify")).toBe("");
    }
    for (const bad of ["staging", `https://x.example/${FAKE_UUID}`, "Production"]) {
      expect(refusal({ VITE_USER_NODE_ENV: bad })).toMatch(/VITE_USER_NODE_ENV is not one of/);
    }
  });

  it("judges Vite's resolved env exactly: builtins pass, any other unlisted key (custom envPrefix) refuses", () => {
    const builtins = { BASE_URL: "/", MODE: "production", DEV: false, PROD: true, SSR: false };
    expect(refusal(builtins)).toBe("");
    expect(refusal({ ...builtins, APP_SECRET: "x".repeat(20) })).toMatch(
      /APP_SECRET is not in PUBLIC_BUILD_ENV\.web/,
    );
  });

  it("judges `define` entries under import.meta.env.* (name + JSON-string value)", () => {
    const def = (k: string, v: string) => {
      try {
        enforcePublicBuildEnv("web", {}, { [k]: v });
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return "";
    };
    expect(def("import.meta.env.VITE_FOO", JSON.stringify("bar"))).toMatch(
      /VITE_FOO \(via define\) is not in PUBLIC_BUILD_ENV\.web/,
    );
    expect(
      def(
        "import.meta.env.VITE_SOLANA_RPC_URL",
        JSON.stringify(`https://api.motebit.com/${FAKE_UUID}`),
      ),
    ).toMatch(/high-entropy path segment/);
    expect(
      def(
        "import.meta.env.VITE_SOLANA_RPC_URL",
        JSON.stringify("https://api.motebit.com/v1/solana-rpc"),
      ),
    ).toBe("");
    expect(def("global", "globalThis")).toBe("");
  });

  it("every PUBLIC_BUILD_ENV entry carries a reason; URL entries name hosts", () => {
    for (const [app, entries] of Object.entries(PUBLIC_BUILD_ENV)) {
      expect(publicEnvViolations(app, [])).toEqual([]);
      for (const e of entries) {
        expect(e.why.length, e.name).toBeGreaterThan(20);
        if (e.rule.kind === "url") expect(e.rule.hosts.length).toBeGreaterThan(0);
      }
    }
  });
});

const PUBLIC_BUILD_ENV_HOSTS = ["motebit.com", "*.motebit.com", "localhost", "127.0.0.1"];

/** Vercel project motebit-web, 2026-09-30: exactly these three (+ platform-injected). */
const PROD_WEB_ENV: Record<string, string> = {
  VITE_BROWSER_SANDBOX_URL: "https://motebit-browser-sandbox.fly.dev",
  VITE_STRIPE_PUBLISHABLE_KEY: `pk_live_${fake(AN, 24, 3)}`,
  VITE_PROXY_URL: "https://api.motebit.com",
};

// ── Wiring, by execution ─────────────────────────────────────────────────────

function viteBin(app: string): string {
  const req = createRequire(join(ROOT, "apps", app, "package.json"));
  return join(dirname(req.resolve("vite/package.json")), "bin", "vite.js");
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/i.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

describe("wiring: the real vite build refuses (execution, not text)", () => {
  for (const app of ["web", "verify"]) {
    it(`apps/${app}: \`vite build\` with a planted unlisted var exits non-zero before bundling`, () => {
      const out = join(tmp, `build-${app}`);
      const r = spawnSync(process.execPath, [viteBin(app), "build", "--outDir", out], {
        cwd: join(ROOT, "apps", app),
        encoding: "utf-8",
        env: cleanEnv({ VITE_RPC_ENDPOINT: `https://x.example/v2/${ALCHEMY_KEY}` }),
        timeout: 60_000,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toContain("refusing to build");
      expect(r.stderr + r.stdout).toContain("VITE_RPC_ENDPOINT");
      expect(r.stderr + r.stdout).not.toContain(ALCHEMY_KEY);
    });

    it(`apps/${app}: vite resolveConfig accepts its real prod env and drops VITE_VERCEL_*`, async () => {
      const req = createRequire(join(ROOT, "apps", app, "package.json"));
      const vite = (await import(pathToFileURL(req.resolve("vite")).href)) as {
        resolveConfig: (
          c: { root: string; configFile: string; logLevel: "silent" },
          cmd: "build",
          mode: string,
        ) => Promise<{ env: Record<string, unknown> }>;
      };
      const planted: Record<string, string> = {
        ...(app === "web" ? PROD_WEB_ENV : {}),
        VITE_VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
      };
      const saved = { ...process.env };
      for (const k of Object.keys(process.env)) {
        if (/^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/i.test(k)) delete process.env[k];
      }
      Object.assign(process.env, planted);
      try {
        const cfg = await vite.resolveConfig(
          {
            root: join(ROOT, "apps", app),
            configFile: join(ROOT, "apps", app, "vite.config.ts"),
            logLevel: "silent",
          },
          "build",
          "production",
        );
        expect(Object.keys(cfg.env).filter((k) => k.startsWith("VITE_VERCEL_"))).toEqual([]);
        if (app === "web") expect(cfg.env.VITE_PROXY_URL).toBe(PROD_WEB_ENV.VITE_PROXY_URL);
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    });
  }

  it("the gate's wiring arm executes both configs and refuses the planted var", async () => {
    const w = await checkWiring(ROOT);
    expect(w.checked).toEqual(["apps/web/vite.config.ts", "apps/verify/vite.config.ts"]);
    expect(w.findings).toEqual([]);
    expect(WIRING_PROBE_VAR).toMatch(/^VITE_/);
  });

  it("the gate's wiring arm is RED for a governed surface whose config skips the guard", async () => {
    const root = join(tmp, "unwired");
    mkdirSync(join(root, "apps", "verify"), { recursive: true });
    writeFileSync(
      join(root, "apps", "verify", "vite.config.ts"),
      "export default () => ({ server: { port: 5176 } });\n",
    );
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    const w = await checkWiring(root);
    expect(w.findings.some((f) => f.startsWith("apps/verify/vite.config.ts — resolving"))).toBe(
      true,
    );
    expect(
      w.findings.some((f) => f.startsWith("apps/web/vite.config.ts — governed surface has no")),
    ).toBe(true);
  });
});

// ── Cold review R2: the guard judges the env VITE resolved, not the cwd's ───
//
// R2: `vite build apps/verify` from the repo root shipped a key-in-path value
// from apps/verify/.env.production — the old guard re-derived env with
// loadEnv(mode, process.cwd()) while Vite loads from root/envDir. Every case
// below executes a real `vite build` in a child process.

const PATH_KEY_URL = `https://api.motebit.com/v2/${ALCHEMY_KEY}`;

function viteBuild(args: string[], cwd: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [viteBin("verify"), "build", ...args], {
    cwd,
    encoding: "utf-8",
    env: cleanEnv(extra),
    timeout: 120_000,
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("R2: the gate's wiring arm judges Vite's resolved env, not process.env", () => {
  it("a guard that reads only process.env (the R2 shape) is RED on the envDir probe", async () => {
    const root = join(tmp, "process-env-only");
    for (const app of ["web", "verify"]) {
      mkdirSync(join(root, "apps", app), { recursive: true });
      writeFileSync(
        join(root, "apps", app, "vite.config.ts"),
        `export default () => { if (process.env.${WIRING_PROBE_VAR}) throw new Error("refusing to build: ${WIRING_PROBE_VAR}"); return {}; };\n`,
      );
    }
    const w = await checkWiring(root);
    expect(w.findings.filter((f) => f.includes("planted in process.env"))).toEqual([]);
    expect(w.findings.filter((f) => f.includes("envDir != cwd"))).toHaveLength(2);
  });
});

describe("R2: the real apps refuse env from their own root, whatever the cwd", () => {
  for (const app of ["verify", "web"]) {
    it(`apps/${app}: a violating var in apps/${app}/.env.<mode> refuses — cwd = repo root, and cwd elsewhere`, () => {
      const mode = `gateprobe${app}`;
      const envFile = join(ROOT, "apps", app, `.env.${mode}`);
      writeFileSync(envFile, `VITE_SOLANA_RPC_URL=${PATH_KEY_URL}\n`);
      try {
        // Form 1: `vite build apps/<app>` from the repo root (root != cwd).
        const a = viteBuild(
          [`apps/${app}`, "--mode", mode, "--outDir", join(tmp, `r2-${app}-a`)],
          ROOT,
        );
        // Form 2: an absolute root from an unrelated cwd.
        const b = viteBuild(
          [join(ROOT, "apps", app), "--mode", mode, "--outDir", join(tmp, `r2-${app}-b`)],
          tmp,
        );
        for (const r of [a, b]) {
          expect(r.status).not.toBe(0);
          expect(r.out).toContain("refusing to build");
          expect(r.out).toMatch(/VITE_SOLANA_RPC_URL has a 32-char high-entropy path segment/);
          expect(r.out).not.toContain(ALCHEMY_KEY);
        }
      } finally {
        rmSync(envFile, { force: true });
      }
    });
  }
});

/** A minimal Vite project wired with the real guard plugin (whole-object env access). */
function fixtureProject(name: string, configExtra = "", pluginsExtra = ""): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><script type="module" src="/main.js"></script>\n',
  );
  writeFileSync(join(dir, "main.js"), "console.log(import.meta.env);\n");
  const guard = JSON.stringify(join(ROOT, "scripts", "lib", "client-bundle-secrets.ts"));
  writeFileSync(
    join(dir, "vite.config.ts"),
    `import { publicBuildEnvGuard } from ${guard};\n` +
      `export default { logLevel: "warn", ${configExtra} plugins: [publicBuildEnvGuard("verify"), ${pluginsExtra}] };\n`,
  );
  return dir;
}

describe("R2: every way Vite resolves env is judged (fixture project, real vite build)", () => {
  it("baseline: a clean fixture builds and inlines its (valid) env", () => {
    const dir = fixtureProject("fx-clean");
    writeFileSync(join(dir, ".env"), "VITE_RELAY_URL=https://relay.motebit.com\n");
    const r = viteBuild([dir, "--outDir", join(dir, "dist")], tmp);
    expect(r.status, r.out).toBe(0);
  });

  it("envDir override: a violating var in the configured envDir refuses", () => {
    const envDir = join(tmp, "fx-envdir-env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, ".env"), `VITE_SOLANA_RPC_URL=${PATH_KEY_URL}\n`);
    const dir = fixtureProject("fx-envdir", `envDir: ${JSON.stringify(envDir)},`);
    const r = viteBuild([dir, "--outDir", join(dir, "dist")], ROOT);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/VITE_SOLANA_RPC_URL has a 32-char high-entropy path segment/);
    expect(r.out).not.toContain(ALCHEMY_KEY);
  });

  it("--mode x with .env.x refuses (and the default mode does not read it)", () => {
    const dir = fixtureProject("fx-mode");
    writeFileSync(join(dir, ".env.staging"), "VITE_RPC_ENDPOINT=https://x.example/rpc\n");
    const bad = viteBuild([dir, "--mode", "staging", "--outDir", join(dir, "dist")], ROOT);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toMatch(/VITE_RPC_ENDPOINT is not in PUBLIC_BUILD_ENV\.verify/);
    expect(viteBuild([dir, "--outDir", join(dir, "dist")], ROOT).status).toBe(0);
  });

  it(".env.local refuses", () => {
    const dir = fixtureProject("fx-local");
    writeFileSync(join(dir, ".env.local"), `VITE_HELIUS_API_KEY=${FAKE_UUID}\n`);
    const r = viteBuild([dir, "--outDir", join(dir, "dist")], ROOT);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/VITE_HELIUS_API_KEY is not in PUBLIC_BUILD_ENV\.verify/);
    expect(r.out).not.toContain(FAKE_UUID);
  });

  it("NODE_ENV in a .env file becomes VITE_USER_NODE_ENV — a mode label passes, anything else refuses", () => {
    const ok = fixtureProject("fx-nodeenv-ok");
    writeFileSync(join(ok, ".env"), "NODE_ENV=development\n");
    expect(viteBuild([ok, "--outDir", join(ok, "dist")], ROOT).status).toBe(0);
    const bad = fixtureProject("fx-nodeenv-bad");
    writeFileSync(join(bad, ".env"), "NODE_ENV=staging\n");
    const r = viteBuild([bad, "--outDir", join(bad, "dist")], ROOT);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/VITE_USER_NODE_ENV is not one of/);
  });

  it("a `define` under import.meta.env.* refuses", () => {
    const dir = fixtureProject(
      "fx-define",
      `define: { "import.meta.env.VITE_SECRET_THING": ${JSON.stringify(JSON.stringify(FAKE_UUID))} },`,
    );
    const r = viteBuild([dir, "--outDir", join(dir, "dist")], ROOT);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/VITE_SECRET_THING \(via define\) is not in PUBLIC_BUILD_ENV\.verify/);
    expect(r.out).not.toContain(FAKE_UUID);
  });

  it("defence in depth: a later plugin that mutates config.env after configResolved is refused at generateBundle", () => {
    const dir = fixtureProject(
      "fx-mutate",
      "",
      `{ name: "sneak", configResolved(c) { c.env.VITE_SNEAK = ${JSON.stringify(PATH_KEY_URL)}; } }`,
    );
    const r = viteBuild([dir, "--outDir", join(dir, "dist")], ROOT);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/changed after configResolved[\s\S]*VITE_SNEAK/);
    expect(r.out).not.toContain(ALCHEMY_KEY);
  });

  it("defence in depth: a refused process.env value inlined by another path is caught in the emitted chunk", () => {
    const dir = fixtureProject(
      "fx-inject",
      "",
      `{ name: "inject", transform(code, id) { return id.endsWith("main.js") ? code + "\\nconsole.log(" + JSON.stringify(process.env.vite_lower_key) + ");" : null; } }`,
    );
    const r = viteBuild([dir, "--outDir", join(dir, "dist")], ROOT, { vite_lower_key: FAKE_UUID });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(
      /emitted file carries an env value[\s\S]*contains the value of vite_lower_key/,
    );
    expect(r.out).not.toContain(FAKE_UUID);
  });

  it("forbiddenEnvValues: unlisted or invalid values (>= 8 chars) only; valid listed values are not forbidden", () => {
    const f = forbiddenEnvValues(
      "verify",
      {
        VITE_RELAY_URL: "https://relay.motebit.com",
        VITE_SOLANA_RPC_URL: PATH_KEY_URL,
        MODE: "production",
      },
      { "import.meta.env.VITE_D": JSON.stringify("dddddddddd") },
      { vite_x: "xxxxxxxxxx", VITE_SHORT: "abc", PATH: "/usr/bin:/bin:/x/y" },
    ).map((x) => x.name);
    expect(f.sort()).toEqual(["VITE_D", "VITE_SOLANA_RPC_URL", "vite_x"]);
  });
});

// ── Cold review R2 (4): mobile (Expo/EAS) and docs (Next/Vercel) are governed ──

describe("R2: mobile and docs are governed deny-by-default (static arm)", () => {
  function app(root: string, name: string, files: Record<string, string>): void {
    for (const [rel, text] of Object.entries(files)) {
      const full = join(root, "apps", name, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }

  it("every governed surface has a PUBLIC_BUILD_ENV entry and vice versa", () => {
    expect(Object.keys(PUBLIC_ENV_SURFACES).sort()).toEqual(Object.keys(PUBLIC_BUILD_ENV).sort());
    expect(Object.keys(PUBLIC_ENV_SURFACES).sort()).toEqual(["docs", "mobile", "verify", "web"]);
  });

  it("mobile: an unlisted EXPO_PUBLIC_* in source is RED (the R2 plant), the listed one is green", () => {
    const root = join(tmp, "gov-mobile-src");
    app(root, "mobile", {
      "src/a.ts":
        "export const a = process.env.EXPO_PUBLIC_SOLANA_ENDPOINT;\n" +
        "export const b = process.env.EXPO_PUBLIC_MOTEBIT_RELAY_URL;\n" +
        "export const c = process.env.expo_public_lower;\n",
    });
    const f = runGate(root).staticFindings.join("\n");
    expect(f).toMatch(/EXPO_PUBLIC_SOLANA_ENDPOINT is not in PUBLIC_BUILD_ENV\.mobile/);
    expect(f).toMatch(/expo_public_lower is not in PUBLIC_BUILD_ENV\.mobile/);
    expect(f).not.toContain("EXPO_PUBLIC_MOTEBIT_RELAY_URL");
  });

  it("mobile config: app.json names, eas.json env names AND values, credential shapes", () => {
    const root = join(tmp, "gov-mobile-cfg");
    app(root, "mobile", {
      "app.json": JSON.stringify({
        expo: { extra: { note: "EXPO_PUBLIC_FROM_APP_JSON", stripe: `sk_live_${"0".repeat(24)}` } },
      }),
      "eas.json": JSON.stringify({
        build: {
          production: {
            env: {
              EXPO_PUBLIC_MOTEBIT_RELAY_URL: `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
              EXPO_PUBLIC_HELIUS: FAKE_UUID,
              SENTRY_DSN_BUILD_ONLY: "x",
            },
          },
          preview: { env: { EXPO_PUBLIC_MOTEBIT_RELAY_URL: "https://relay.motebit.com" } },
        },
      }),
      "package.json": JSON.stringify({ scripts: { start: "EXPO_PUBLIC_DEV_KEY=1 expo start" } }),
    });
    const r = runGate(root);
    const f = r.staticFindings.join("\n");
    expect(f).toMatch(/app\.json:1 — EXPO_PUBLIC_FROM_APP_JSON is not in PUBLIC_BUILD_ENV\.mobile/);
    expect(f).toMatch(/app\.json @ offset \d+ — stripe-secret/);
    expect(f).toMatch(
      /eas\.json build\.production\.env — EXPO_PUBLIC_MOTEBIT_RELAY_URL host solana-mainnet\.g\.alchemy\.com is not in its host allowlist/,
    );
    expect(f).toMatch(/EXPO_PUBLIC_HELIUS is not in PUBLIC_BUILD_ENV\.mobile/);
    expect(f).toMatch(/package\.json:1 — EXPO_PUBLIC_DEV_KEY is not in PUBLIC_BUILD_ENV\.mobile/);
    expect(f).not.toContain("build.preview");
    expect(f).not.toContain("SENTRY_DSN_BUILD_ONLY");
    expect(f).not.toContain(ALCHEMY_KEY);
    expect(f).not.toContain(FAKE_UUID);
    expect(r.configFiles).toEqual([
      "apps/mobile/app.json",
      "apps/mobile/eas.json",
      "apps/mobile/package.json",
    ]);
  });

  it("docs: any NEXT_PUBLIC_* (source, .mdx, config) is RED; next.config env/publicRuntimeConfig is RED; VITE_* prose is not", () => {
    const root = join(tmp, "gov-docs");
    app(root, "docs", {
      "src/page.tsx": "export const k = process.env.NEXT_PUBLIC_RPC_URL;\n",
      "content/docs/a.mdx":
        "Set `VITE_ANTHROPIC_API_KEY` for desktop.\n\n{process.env.NEXT_PUBLIC_FROM_MDX}\n",
      "next.config.mjs":
        "export default { env: { HELIUS: process.env.HELIUS }, publicRuntimeConfig: {} };\n",
    });
    const f = runGate(root).staticFindings.join("\n");
    expect(f).toMatch(/src\/page\.tsx:1 — NEXT_PUBLIC_RPC_URL is not in PUBLIC_BUILD_ENV\.docs/);
    expect(f).toMatch(/a\.mdx:3 — NEXT_PUBLIC_FROM_MDX is not in PUBLIC_BUILD_ENV\.docs/);
    expect(f).toMatch(/next\.config\.mjs:1 — next\.config `env` inlines arbitrary/);
    expect(f).toMatch(/next\.config\.mjs:1 — next\.config `publicRuntimeConfig` inlines arbitrary/);
    expect(f).not.toContain("VITE_ANTHROPIC_API_KEY");
  });

  it("the gate's dist arm judges only the names a surface's bundler inlines", () => {
    const root = join(tmp, "gov-docs-dist");
    mkdirSync(join(root, "apps", "docs", ".next", "static", "chunks"), { recursive: true });
    writeFileSync(
      join(root, "apps", "docs", ".next", "static", "chunks", "a.js"),
      'const sample={"VITE_API_URL":"http://localhost:3000"},e={NEXT_PUBLIC_X:"y"};',
    );
    const f = runGate(root).artifactFindings.join("\n");
    expect(f).toMatch(/NEXT_PUBLIC_X is not in PUBLIC_BUILD_ENV\.docs/);
    expect(f).not.toContain("VITE_API_URL");
  });
});

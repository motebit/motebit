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
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CREDENTIAL_RULES,
  OUTPUT_SCAN_EXCLUDED_ENV_NAMES,
  OUTPUT_SCAN_MIN_LENGTH,
  PUBLIC_BUILD_ENV,
  PUBLIC_ENV_ALLOWLIST,
  PUBLIC_ENV_SURFACES,
  enforcePublicBuildEnv,
  forbiddenEnvValues,
  fragmentNeedlesApply,
  outputScanExclusion,
  outputScanRefusal,
  parseDotenv,
  publicValueViolation,
  scanOutputForEnvValues,
  valueNeedles,
  isSecretShapedEnvName,
  localOnlyApps,
  localOnlyPremiseViolations,
  publicBuildEnvGuard,
  publicEnvViolations,
  publicUrlViolation,
  scanArtifactForPublicEnvPairs,
  scanArtifactText,
} from "../lib/client-bundle-secrets.js";
import {
  WIRING_PROBE_VAR,
  checkWiring,
  judgeConfigFile,
  judgeSurfaceWiring,
  runGate,
} from "../check-no-secrets-in-client-bundles.js";
import {
  checkBuildOutput,
  expoPublicConfig,
  outputVacuityRefusal,
} from "../check-client-build-output.js";

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
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "client-bundle-secrets-")));
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
    expect(refusal({ VITE_STRIPE_PUBLISHABLE_KEY: `pk_test_${"a".repeat(24)}` }, "verify")).toMatch(
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

  it("R3 (6): URL hosts are EXACT per var — no wildcard; a key in a subdomain label is refused", () => {
    for (const entries of Object.values(PUBLIC_BUILD_ENV)) {
      for (const e of entries) {
        if (e.rule.kind !== "url") continue;
        for (const h of e.rule.hosts) expect(h, e.name).not.toContain("*");
      }
    }
    const web = new Map(PUBLIC_BUILD_ENV.web!.map((e) => [e.name, e.rule]));
    const proxy = web.get("VITE_PROXY_URL")!;
    expect(publicValueViolation("https://api.motebit.com", proxy)).toBeNull();
    expect(publicValueViolation(`https://${FAKE_UUID}.motebit.com`, proxy)).toMatch(
      /not in its host allowlist/,
    );
    expect(
      publicValueViolation(`https://${ALCHEMY_KEY.toLowerCase()}.api.motebit.com`, proxy),
    ).toMatch(/not in its host allowlist/);
    expect(publicValueViolation("https://motebit.com", proxy)).toMatch(/not in its host allowlist/);
    const sandbox = web.get("VITE_BROWSER_SANDBOX_URL")!;
    expect(publicValueViolation("https://motebit-browser-sandbox.fly.dev", sandbox)).toBeNull();
    expect(publicValueViolation("https://evil.fly.dev", sandbox)).toMatch(
      /not in its host allowlist/,
    );
    expect(publicValueViolation("http://localhost:3000", sandbox)).toBeNull();
  });

  it("R3 (6): a Stripe publishable key is pk_live_/pk_test_ + 24..247 alphanumerics", () => {
    const rule = { kind: "stripe-publishable" } as const;
    expect(publicValueViolation(`pk_live_${fake(AN, 24, 3)}`, rule)).toBeNull();
    expect(publicValueViolation(`pk_test_${fake(AN, 99, 5)}`, rule)).toBeNull();
    expect(publicValueViolation("pk_live_abc", rule)).toMatch(/not a Stripe publishable key/);
    expect(publicValueViolation(`pk_live_${"a".repeat(23)}`, rule)).toMatch(/not a Stripe/);
    expect(publicValueViolation(`pk_live_${"a".repeat(248)}`, rule)).toMatch(/not a Stripe/);
    expect(publicValueViolation(`sk_live_${"a".repeat(24)}`, rule)).toMatch(/not a Stripe/);
  });
});

const PUBLIC_BUILD_ENV_HOSTS = ["motebit.com", "api.motebit.com", "localhost", "127.0.0.1"];

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
          preview: { env: { EXPO_PUBLIC_MOTEBIT_RELAY_URL: "https://api.motebit.com" } },
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

/** Writes `files` under <root>/apps/<name>/. */
function stageApp(root: string, name: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, "apps", name, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

// ── Cold review R3: THE LAW is the ground-truth output scan ────────────────
//
// Every R3 bypass shipped a value through a route a static check did not
// enumerate. The output scan judges what was EMITTED: every build env value
// (minus the stated exclusion rule) must be absent from every emitted file.
// Each plant below is (1)-(4) from the review; each fails NAMING the var,
// never printing the value.

/** A server-only secret: no public prefix, so no name-based arm judges it. */
const SERVER_SECRET = `srv_${fake(AN, 40, 13)}`;

describe("R3 the law: output scan — exclusion rule, encodings, redaction", () => {
  it("the exclusion rule, exactly: public-allowlisted values, < 16 chars, scalars, paths, credential-free locators", () => {
    const allowed = new Set(["https://api.motebit.com"]);
    expect(outputScanExclusion("https://api.motebit.com", allowed)).toBe(
      "public (PUBLIC_BUILD_ENV)",
    );
    expect(outputScanExclusion("a".repeat(15), allowed)).toBe("short");
    expect(outputScanExclusion("1234567890.12345", allowed)).toBe("scalar");
    expect(outputScanExclusion("/usr/local/bin:/usr/bin:/bin", allowed)).toBe("path");
    expect(outputScanExclusion("https://github.com/motebit/motebit", allowed)).toBe(
      "credential-free locator",
    );
    expect(outputScanExclusion("motebit-browser-sandbox.fly.dev", allowed)).toBe(
      "credential-free locator",
    );
    // Credential-bearing locators are NOT excluded: query, userinfo, key-in-path, key-in-label.
    for (const v of [
      `https://mainnet.helius-rpc.com/?api-key=${FAKE_UUID}`,
      `https://user:${ALCHEMY_KEY}@x.example`,
      `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      `https://${FAKE_UUID}.rpc.example.com`,
      `https://hooks.slack.com/services/T0000/B0000/${ALCHEMY_KEY}`,
      SERVER_SECRET,
      `pk_live_${fake(AN, 24, 3)}`,
    ]) {
      expect(outputScanExclusion(v, allowed), v.slice(0, 12)).toBeNull();
    }
  });

  it("finds a value raw, url-encoded, json-escaped and base64 (all alignments, std + url) — and never prints it", () => {
    const v = `${SERVER_SECRET}/+"q`;
    const vars = [{ name: "SNEAKY", value: v }];
    const b = Buffer.from(v, "utf8");
    const cases: Record<string, string> = {
      raw: `x="${v.replace('"', "")}"`.replace(v.replace('"', ""), v),
      "url-encoded": `a?b=${encodeURIComponent(v)}`,
      "json-escaped": JSON.stringify({ k: v }),
      b64a0: Buffer.concat([b]).toString("base64"),
      b64a1: Buffer.concat([Buffer.from("x"), b]).toString("base64"),
      b64a2: Buffer.concat([Buffer.from("xy"), b]).toString("base64"),
      b64url: Buffer.concat([Buffer.from("x"), b]).toString("base64url"),
      sourcemapDataUrl: `//# source${"MappingURL"}=data:application/json;base64,${Buffer.from(
        JSON.stringify({ sourcesContent: [`const k = ${JSON.stringify(v)};`] }),
      ).toString("base64")}`,
    };
    for (const [label, text] of Object.entries(cases)) {
      const r = scanOutputForEnvValues("verify", vars, [{ label, text }]);
      expect(r.findings, label).toHaveLength(1);
      expect(r.findings[0]).toContain("carries the value of SNEAKY");
      expect(r.findings[0]).not.toContain(SERVER_SECRET);
    }
    expect(
      scanOutputForEnvValues("verify", vars, [{ label: "c", text: "clean" }]).findings,
    ).toEqual([]);
    expect(valueNeedles(v).every((n) => n.needle.length >= 16)).toBe(true);
  });

  it("the surface's public values are excluded by VALUE (also under another name); an invalid one is not", () => {
    const pk = `pk_live_${fake(AN, 24, 3)}`;
    const text = `{"k":"${pk}","u":"https://api.motebit.com"}`;
    const ok = scanOutputForEnvValues(
      "web",
      [
        { name: "VITE_STRIPE_PUBLISHABLE_KEY", value: pk },
        { name: "STRIPE_PK_COPY", value: pk },
      ],
      [{ label: "main.js", text }],
    );
    expect(ok.findings).toEqual([]);
    // The same key on a surface that does not publish it is a leak there.
    const bad = scanOutputForEnvValues(
      "verify",
      [{ name: "VITE_STRIPE_PUBLISHABLE_KEY", value: pk }],
      [{ label: "main.js", text }],
    );
    expect(bad.findings.join("\n")).toMatch(/carries the value of VITE_STRIPE_PUBLISHABLE_KEY/);
  });

  it("parseDotenv reads KEY=VALUE, export, quotes and comments", () => {
    expect(
      parseDotenv(`# c\nexport A=1\nB="two words" # x\nC='q'\nD=plain # tail\n bad line\n`),
    ).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "two words" },
      { name: "C", value: "q" },
      { name: "D", value: "plain" },
    ]);
  });

  it("checkBuildOutput reads .env* files in the app dir as build env too, and refuses vacuity", () => {
    const root = join(tmp, "r3-dotenv");
    mkdirSync(join(root, "apps", "docs", ".next", "static"), { recursive: true });
    writeFileSync(
      join(root, "apps", "docs", ".env.production"),
      `DOCS_ONLY_SECRET=${SERVER_SECRET}\n`,
    );
    writeFileSync(
      join(root, "apps", "docs", ".next", "static", "a.js"),
      `x=${JSON.stringify(SERVER_SECRET)}`,
    );
    const r = checkBuildOutput("docs", { repo: root, processEnv: {} });
    expect(r.findings.join("\n")).toMatch(
      /apps\/docs\/\.next\/static\/a\.js carries the value of DOCS_ONLY_SECRET \(raw; from \.env\.production/,
    );
    expect(r.findings.join("\n")).not.toContain(SERVER_SECRET);
    expect(checkBuildOutput("web", { repo: root, processEnv: {} }).files).toBe(0);
  });
});

/** A minimal Vite app at <root>/apps/verify (the governed name) with BOTH configs. */
function siblingConfigApp(root: string): string {
  const dir = join(root, "apps", "verify");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><script type="module" src="/main.js"></script>\n',
  );
  writeFileSync(join(dir, "main.js"), "console.log(__BUILD_INFO__);\n");
  const guard = JSON.stringify(join(ROOT, "scripts", "lib", "client-bundle-secrets.ts"));
  writeFileSync(
    join(dir, "vite.config.ts"),
    `import { publicBuildEnvGuard } from ${guard};\nexport default { logLevel: "warn", plugins: [publicBuildEnvGuard("verify")], define: { __BUILD_INFO__: "1" } };\n`,
  );
  // The R3 (1) plant: Vite loads vite.config.js BEFORE vite.config.ts.
  writeFileSync(
    join(dir, "vite.config.js"),
    `export default { logLevel: "warn", define: { __BUILD_INFO__: JSON.stringify(process.env.SNEAKY_SERVER_SECRET) } };\n`,
  );
  return dir;
}

describe("R3 plants: each bypass ships green past the static arms, and the output scan refuses it", () => {
  it("(1) sibling vite.config.js without the guard: vite builds it; the output scan names the var; the gate refuses the file", () => {
    const root = join(tmp, "r3-sibling");
    const dir = siblingConfigApp(root);
    const r = spawnSync(process.execPath, [viteBin("verify"), "build", "--outDir", "dist"], {
      cwd: dir,
      encoding: "utf-8",
      env: cleanEnv({ SNEAKY_SERVER_SECRET: SERVER_SECRET }),
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0); // the guard never ran: the .js config won
    const out = checkBuildOutput("verify", {
      repo: root,
      processEnv: { SNEAKY_SERVER_SECRET: SERVER_SECRET },
    });
    expect(out.files).toBeGreaterThan(0);
    expect(out.findings.join("\n")).toMatch(
      /apps\/verify\/dist\/assets\/.+ carries the value of SNEAKY_SERVER_SECRET/,
    );
    expect(out.findings.join("\n")).not.toContain(SERVER_SECRET);
    expect(judgeSurfaceWiring("verify", dir, { bundler: "vite" }).join("\n")).toMatch(
      /apps\/verify\/vite\.config\.js — a second vite config beside vite\.config\.ts/,
    );
  });

  it("(1') the guard plugin's closeBundle runs the law on disk: a non-public server var inlined by any route is refused", () => {
    const dir = fixtureProject(
      "fx-r3-close",
      `define: { __X__: JSON.stringify(process.env.SNEAKY_SERVER_SECRET) },`,
    );
    writeFileSync(join(dir, "main.js"), "console.log(import.meta.env, __X__);\n");
    mkdirSync(join(dir, "public"), { recursive: true });
    const r = viteBuild([dir, "--outDir", join(dir, "dist")], ROOT, {
      SNEAKY_SERVER_SECRET: SERVER_SECRET,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(
      /ground-truth output scan[\s\S]*carries the value of SNEAKY_SERVER_SECRET/,
    );
    expect(r.out).not.toContain(SERVER_SECRET);
    // Same project, value only in a copied public/ asset (never a chunk): still refused.
    const dir2 = fixtureProject("fx-r3-public");
    mkdirSync(join(dir2, "public"), { recursive: true });
    writeFileSync(join(dir2, ".env.production"), `SERVER_ONLY_TOKEN=${SERVER_SECRET}\n`);
    writeFileSync(join(dir2, "public", "cfg.json"), JSON.stringify({ t: SERVER_SECRET }));
    const r2 = viteBuild([dir2, "--outDir", join(dir2, "dist")], ROOT);
    expect(r2.status).not.toBe(0);
    expect(r2.out).toMatch(/cfg\.json carries the value of SERVER_ONLY_TOKEN/);
    expect(r2.out).not.toContain(SERVER_SECRET);
  });

  it("(2) next.config `env` quoted/shorthand and compiler.define: the static arm now warns, the output scan refuses what shipped", () => {
    const surface = PUBLIC_ENV_SURFACES.docs!;
    for (const cfg of [
      `const c = { "env": { LEAK: process.env.S } };`,
      `const c = { 'env': { LEAK: process.env.S } };`,
      `const env = { LEAK: process.env.S }; const c = { env, x: 1 };`,
      `const c = { compiler: { define: { "process.env.LEAK": JSON.stringify(process.env.S) } } };`,
    ]) {
      expect(
        judgeConfigFile("docs", "apps/docs/next.config.mjs", cfg, surface).join("\n"),
        cfg,
      ).toMatch(/next\.config `(?:env|define)` inlines/);
    }
    const root = join(tmp, "r3-next");
    mkdirSync(join(root, "apps", "docs", ".next", "static", "chunks"), { recursive: true });
    writeFileSync(
      join(root, "apps", "docs", ".next", "static", "chunks", "page-1.js"),
      `self.__next_f.push([1,"${SERVER_SECRET}"])`,
    );
    const r = checkBuildOutput("docs", {
      repo: root,
      processEnv: { DOCS_SERVER_SECRET: SERVER_SECRET },
    });
    expect(r.findings.join("\n")).toMatch(/page-1\.js carries the value of DOCS_SERVER_SECRET/);
  });

  it("(3) source under build/ out/ public/ below the app root is scanned by the static arm; the output scan covers __tests__/e2e too", () => {
    const root = join(tmp, "r3-skipdirs");
    for (const d of ["src/build", "src/out", "src/public"]) {
      stageApp(root, "docs", {
        [`${d}/leak.ts`]: "export const k = process.env.NEXT_PUBLIC_SNEAK;\n",
      });
    }
    const f = runGate(root).staticFindings.filter((x) => x.includes("NEXT_PUBLIC_SNEAK"));
    expect(f.map((x) => x.split(":")[0]).sort()).toEqual([
      "apps/docs/src/build/leak.ts",
      "apps/docs/src/out/leak.ts",
      "apps/docs/src/public/leak.ts",
    ]);
    // Whatever dir the source sat in, its value in the emitted output is refused.
    mkdirSync(join(root, "apps", "docs", ".next", "static"), { recursive: true });
    writeFileSync(
      join(root, "apps", "docs", ".next", "static", "x.js"),
      `const k="${SERVER_SECRET}"`,
    );
    const r = checkBuildOutput("docs", {
      repo: root,
      processEnv: { NEXT_PUBLIC_SNEAK: SERVER_SECRET },
    });
    expect(r.findings.join("\n")).toMatch(/x\.js carries the value of NEXT_PUBLIC_SNEAK/);
  });

  it("(4) Expo app.config.js `extra: { x: process.env.SECRET }`: the REAL `expo config --type public` output is refused", () => {
    const probe = mkdtempSync(join(ROOT, "apps", "mobile", ".r3-probe-"));
    try {
      cpSync(join(ROOT, "apps", "mobile", "app.json"), join(probe, "app.json"));
      cpSync(join(ROOT, "apps", "mobile", "package.json"), join(probe, "package.json"));
      writeFileSync(
        join(probe, "app.config.js"),
        "module.exports = ({ config }) => ({ ...config, extra: { ...(config.extra ?? {}), x: process.env.SNEAKY_SERVER_SECRET } });\n",
      );
      const saved = process.env.SNEAKY_SERVER_SECRET;
      process.env.SNEAKY_SERVER_SECRET = SERVER_SECRET;
      let manifest = "";
      try {
        manifest = expoPublicConfig(probe);
      } finally {
        if (saved === undefined) delete process.env.SNEAKY_SERVER_SECRET;
        else process.env.SNEAKY_SERVER_SECRET = saved;
      }
      expect(manifest).toContain('"extra"');
      const root = join(tmp, "r3-expo");
      mkdirSync(join(root, "apps", "mobile"), { recursive: true });
      const r = checkBuildOutput("mobile", {
        repo: root,
        expoConfigJson: manifest,
        processEnv: { SNEAKY_SERVER_SECRET: SERVER_SECRET },
      });
      expect(r.findings.join("\n")).toMatch(
        /apps\/mobile \(expo public config\) carries the value of SNEAKY_SERVER_SECRET/,
      );
      expect(r.findings.join("\n")).not.toContain(SERVER_SECRET);
      // The real app.json (no app.config.js) ships no env value.
      const clean = checkBuildOutput("mobile", {
        repo: root,
        expoConfigJson: expoPublicConfig(join(ROOT, "apps", "mobile")),
        processEnv: { SNEAKY_SERVER_SECRET: SERVER_SECRET },
      });
      expect(clean.findings).toEqual([]);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });
});

describe("R3 wiring: every governed surface runs the law from its build", () => {
  it("the real repo: one vite config per Vite surface; every build script (EAS hook for mobile) runs the output scan", () => {
    for (const [app, surface] of Object.entries(PUBLIC_ENV_SURFACES)) {
      expect(judgeSurfaceWiring(app, join(ROOT, "apps", app), surface), app).toEqual([]);
    }
  });

  it("a build script that drops the output scan is RED", () => {
    const root = join(tmp, "r3-unwired");
    stageApp(root, "docs", {
      "package.json": JSON.stringify({ scripts: { build: "next build" } }),
    });
    expect(
      judgeSurfaceWiring("docs", join(root, "apps", "docs"), { bundler: "next" }).join("\n"),
    ).toMatch(/scripts\.build — does not run `check-client-build-output\.ts docs`/);
  });
});

// ── Cold review R4: the exclusion rule is deny-by-default ──────────────────
//
// Each plant below shipped green on 9073c24: the value went into emitted
// output and the scan excluded it (or never read the file). Each must be RED.

/** A planted `/`-leading base64 secret (~1 in 64 `openssl rand -base64 32`). */
const SLASH_B64 = "/q8Zr3Kx9WvT2mLp7Yb4Nc6Hd1Fg5Js0Ae+uIoP3kQ=";
const SLASH_HEX = `/${fake(HEX, 64, 5)}`;

/** Plants `value` as `name` into apps/<app>/<outDir>/<file> under a fresh root and runs the law. */
function plantOutput(
  label: string,
  app: string,
  file: string,
  name: string,
  value: string,
): ReturnType<typeof checkBuildOutput> {
  const root = join(tmp, label);
  const full = join(root, "apps", app, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `const k=${JSON.stringify(value)};`);
  return checkBuildOutput(app, { repo: root, processEnv: { [name]: value } });
}

describe("R4 (1) a `/`-leading value is a path only when it has the real shape of one", () => {
  it("a `/`-leading base64 and hex secret are scanned for, and refused in apps/verify output", () => {
    for (const v of [
      SLASH_B64,
      SLASH_HEX,
      "/q8Zr3Kx9Wv/T2mLp7Yb4Nc6H/d1Fg5Js0Ae+uIoP3kQ=",
      "/q8Zr3Kx9WvT2/mLp7Yb4Nc6Hd/1Fg5Js0Ae+uIo",
    ]) {
      expect(outputScanExclusion(v, new Set()), v.slice(0, 6)).toBeNull();
    }
    for (const [i, v] of [SLASH_B64, SLASH_HEX].entries()) {
      const r = plantOutput(`r4-slash-${i}`, "verify", "dist/assets/index.js", "SESSION_KEY", v);
      expect(r.findings.join("\n")).toMatch(
        /apps\/verify\/dist\/assets\/index\.js carries the value of SESSION_KEY/,
      );
      expect(r.findings.join("\n")).not.toContain(v);
    }
  });

  it("real paths stay excluded: existing on disk, or multi-segment and low-entropy", () => {
    for (const v of [
      ROOT,
      `${ROOT}/apps/docs:${ROOT}/node_modules/.bin`,
      "/vercel/path0/apps/docs",
      "/opt/does-not-exist/node_modules/.bin:/usr/bin",
    ]) {
      expect(outputScanExclusion(v, new Set()), v).toBe("path");
    }
    // A non-existent single segment, or one carrying a base64/hex run, is not a path.
    for (const v of [
      "/nonexistent-dir-xyz",
      `/opt/${fake(AN, 20, 9)}/bin`,
      `/srv/${fake(HEX, 32, 4)}`,
    ]) {
      expect(outputScanExclusion(v, new Set()), v).toBeNull();
    }
  });
});

describe("R4 (2) apps/docs/public/ ships verbatim and is scanned", () => {
  it("a value written into apps/docs/public/ is refused (also under a nested cache/ dir)", () => {
    for (const f of ["public/cfg.json", "public/cache/x.txt"]) {
      const r = plantOutput(
        `r4-docs-public-${f.length}`,
        "docs",
        f,
        "DOCS_SERVER_SECRET",
        SERVER_SECRET,
      );
      expect(r.findings.join("\n"), f).toContain(
        `apps/docs/${f} carries the value of DOCS_SERVER_SECRET`,
      );
    }
    // .next/cache stays out of the scan (build cache, never served).
    const r = plantOutput(
      "r4-docs-cache",
      "docs",
      ".next/cache/x.txt",
      "DOCS_SERVER_SECRET",
      SERVER_SECRET,
    );
    expect(r.findings).toEqual([]);
  });
});

describe("R4 (3) the mobile EAS hook can never pass vacuously", () => {
  it("--dir paths that do not exist (or hold no JS bundle) are refused even when the Expo config was scanned", () => {
    const root = join(tmp, "r4-vacuous");
    mkdirSync(join(root, "apps", "mobile"), { recursive: true });
    const dirs = ["android/app/build/generated", "ios/build"];
    const run = (): ReturnType<typeof checkBuildOutput> =>
      checkBuildOutput("mobile", { repo: root, dirs, expoConfigJson: "{}", processEnv: {} });
    let r = run();
    expect(r.findings).toEqual([]);
    expect(outputVacuityRefusal("mobile", r, { expoConfigOnly: false })).toMatch(/no JS bundle/);
    // A dir that exists but holds no JS bundle is still vacuous.
    mkdirSync(join(root, "apps", "mobile", "ios", "build"), { recursive: true });
    writeFileSync(join(root, "apps", "mobile", "ios", "build", "Info.plist"), "<plist/>");
    r = run();
    expect(outputVacuityRefusal("mobile", r, { expoConfigOnly: false })).toMatch(/no JS bundle/);
    // The real Android bundle satisfies it.
    const gen = join(root, "apps", "mobile", "android", "app", "build", "generated", "assets");
    mkdirSync(gen, { recursive: true });
    writeFileSync(join(gen, "index.android.bundle"), "__d(function(){})");
    r = run();
    expect(outputVacuityRefusal("mobile", r, { expoConfigOnly: false })).toBeNull();
    // An explicit config-only mode needs no bundle; with nothing at all it is still refused.
    const bare = checkBuildOutput("mobile", {
      repo: join(tmp, "r4-none"),
      expoConfigJson: "{}",
      processEnv: {},
    });
    expect(outputVacuityRefusal("mobile", bare, { expoConfigOnly: true })).toBeNull();
    const none = checkBuildOutput("mobile", { repo: join(tmp, "r4-none"), processEnv: {} });
    expect(outputVacuityRefusal("mobile", none, { expoConfigOnly: true })).toMatch(
      /nothing to scan/,
    );
  });

  it("the EAS hook must not use --expo-config-only (wiring is RED if it does)", () => {
    const root = join(tmp, "r4-eas");
    stageApp(root, "mobile", {
      "package.json": JSON.stringify({
        scripts: {
          "eas-build-on-success":
            "npx tsx ../../scripts/check-client-build-output.ts mobile --expo-config-only",
        },
      }),
    });
    expect(
      judgeSurfaceWiring("mobile", join(root, "apps", "mobile"), { bundler: "expo" }).join("\n"),
    ).toMatch(/--expo-config-only/);
  });
});

describe("R4 (4) long digit runs and short-segment URLs are scanned", () => {
  it("an all-digit value of 16+ digits is scanned (unless a known public numeric name) and refused", () => {
    const digits = "4929173859201746";
    expect(outputScanExclusion(digits, new Set())).toBeNull();
    expect(outputScanExclusion("123456789012345", new Set())).toBe("short");
    expect(outputScanExclusion("1700000000.123", new Set())).toBe("short");
    expect(outputScanExclusion("1234567890.12345", new Set())).toBe("scalar");
    expect(outputScanExclusion(digits, new Set(), "SOURCE_DATE_EPOCH")).toBe("scalar");
    const r = plantOutput("r4-digits", "verify", "dist/assets/a.js", "PIN_SECRET", digits);
    expect(r.findings.join("\n")).toMatch(/carries the value of PIN_SECRET/);
  });

  it("a URL whose key segments are 8-11 chars (or mixed-case letters) is not credential-free, and is refused", () => {
    for (const u of [
      "https://hooks.example.com/services/T0a1B2c3/B9z8Y7x6/Qw3Er5Ty7U",
      "https://x.example.com/k/AbCdEfGhIjKlMnOpQr",
    ]) {
      expect(outputScanExclusion(u, new Set()), u).toBeNull();
      const r = plantOutput(`r4-url-${u.length}`, "verify", "dist/assets/u.js", "WEBHOOK_URL", u);
      expect(r.findings.join("\n"), u).toMatch(/carries the value of WEBHOOK_URL/);
    }
    // Real public locators stay excluded.
    for (const u of [
      "https://motebit-browser-sandbox.fly.dev",
      "https://github.com/motebit/motebit",
      "https://api.motebit.com/v1/agents",
      "https://registry.npmjs.org/",
    ]) {
      expect(outputScanExclusion(u, new Set()), u).toBe("credential-free locator");
    }
  });
});

/**
 * Real main commit messages (verbatim excerpts) that false-REDed the docs
 * build on Vercel as `VERCEL_GIT_COMMIT_MESSAGE` before the needle policy was
 * narrowed: a letters+digits fragment of 16+ chars (a model id, a package
 * name) also appears in ordinary docs output.
 */
const REAL_COMMIT_MESSAGES = [
  "fix(ai-core): 'default' tier resolves to the user's model — never the family workhorse (#533) (#534)\n\nThe default tier fell back to claude-sonnet-4-6 even when the user had picked claude-sonnet-5.",
  "chore(deps): bump @modelcontextprotocol/sdk and vitest-coverage-v8 to the patched majors",
];

describe("R5 the second net claims only what it checks: needle policy + platform metadata", () => {
  const SECRET = `sk_${fake(AN, 32, 7)}`;
  const KEYISH = `Zq8Rt3Kx9Wv2mLp7Yb4N`; // a 20-char letters+digits run (fragment-shaped)

  it("platform metadata is excluded by EXACT name — never a pattern", () => {
    for (const n of [
      "VERCEL_GIT_COMMIT_MESSAGE",
      "VERCEL_GIT_COMMIT_AUTHOR_NAME",
      "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
      "VERCEL_GIT_COMMIT_REF",
      "VITE_VERCEL_GIT_COMMIT_MESSAGE",
      "NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE",
      "GITHUB_REF",
      "GITHUB_HEAD_REF",
      "GITHUB_ACTOR",
      "NEXT_DEPLOYMENT_ID",
      "VERCEL_DEPLOYMENT_ID",
    ]) {
      expect(OUTPUT_SCAN_EXCLUDED_ENV_NAMES.has(n), n).toBe(true);
      expect(outputScanExclusion(SECRET, new Set(), n), n).toBe("platform metadata");
    }
    // A name that merely RESEMBLES the list is scanned (no prefix/suffix matching).
    for (const n of [
      "VERCEL_GIT_COMMIT_MESSAGE_KEY",
      "X_VERCEL_GIT_COMMIT_MESSAGE",
      "VERCEL_GIT_COMMIT_SHA",
      "vercel_git_commit_message",
      "GITHUB_TOKEN",
      "NEXT_PUBLIC_DEPLOYMENT_ID",
      "VERCEL_DEPLOYMENT_ID_KEY",
      "DEPLOYMENT_ID",
    ]) {
      expect(outputScanExclusion(SECRET, new Set(), n), n).toBeNull();
    }
    // The list is small and named; every entry is platform metadata, never a credential name.
    expect(OUTPUT_SCAN_EXCLUDED_ENV_NAMES.size).toBeLessThanOrEqual(25);
    for (const n of OUTPUT_SCAN_EXCLUDED_ENV_NAMES) {
      expect(isSecretShapedEnvName(n), n).toBe(false);
    }
  });

  it("fragments are needles only for secret-shaped names and public-prefixed vars", () => {
    expect(fragmentNeedlesApply("HELIUS_API_KEY")).toBe(true);
    expect(fragmentNeedlesApply("SOLANA_RPC_URL")).toBe(true);
    expect(fragmentNeedlesApply("DB_PASSWORD")).toBe(true);
    expect(fragmentNeedlesApply("VITE_ANYTHING")).toBe(true);
    expect(fragmentNeedlesApply("NEXT_PUBLIC_VERCEL_URL")).toBe(true);
    expect(fragmentNeedlesApply("DEPLOY_NOTE")).toBe(false);
    expect(fragmentNeedlesApply("VERCEL_GIT_COMMIT_SHA")).toBe(false);
    const v = `note: rotated ${KEYISH} today`;
    expect(valueNeedles(v, { fragments: false }).some((n) => n.encoding.includes("fragment"))).toBe(
      false,
    );
    expect(valueNeedles(v).some((n) => n.encoding === "fragment" && n.needle === KEYISH)).toBe(
      true,
    );
  });

  it("a planted secret-named var goes RED raw, url, json, base64 AND fragment", () => {
    const v = `${SECRET}/+"q ${KEYISH}`;
    const b = Buffer.from(v, "utf8");
    const cases: Record<string, [string, RegExp]> = {
      raw: [`x=${v}`, /\(raw;/],
      url: [`a?b=${encodeURIComponent(v)}`, /\(url-encoded;/],
      json: [JSON.stringify({ k: v }), /\(json-escaped;/],
      base64: [Buffer.concat([Buffer.from("xy"), b]).toString("base64"), /\(base64 of /],
      fragment: [`hex(${KEYISH})`, /\(fragment;/],
    };
    for (const [label, [text, enc]] of Object.entries(cases)) {
      const r = scanOutputForEnvValues(
        "verify",
        [{ name: "HELIUS_API_KEY", value: v }],
        [{ label, text }],
      );
      expect(r.findings, label).toHaveLength(1);
      expect(r.findings[0], label).toMatch(enc);
      expect(r.findings[0]).not.toContain(SECRET);
    }
    // An unlisted public-prefixed var gets fragment needles too.
    const pub = scanOutputForEnvValues(
      "verify",
      [{ name: "VITE_NOTE", value: v }],
      [{ label: "f", text: KEYISH }],
    );
    expect(pub.findings.join("\n")).toMatch(/VITE_NOTE \(fragment;/);
  });

  it("any other var is scanned for its FULL value only: its fragment in output is not a finding", () => {
    const v = `note: rotated ${KEYISH} today`;
    const frag = scanOutputForEnvValues(
      "docs",
      [{ name: "DEPLOY_NOTE", value: v }],
      [{ label: "page.html", text: `<p>${KEYISH}</p>` }],
    );
    expect(frag.findings).toEqual([]);
    for (const text of [v, encodeURIComponent(v), Buffer.from(v).toString("base64")]) {
      const full = scanOutputForEnvValues(
        "docs",
        [{ name: "DEPLOY_NOTE", value: v }],
        [{ label: "page.html", text }],
      );
      expect(full.findings.join("\n"), text.slice(0, 8)).toMatch(
        /carries the value of DEPLOY_NOTE/,
      );
    }
  });

  it("real main commit messages as VERCEL_GIT_COMMIT_MESSAGE never go RED, even when their fragments ship", () => {
    // The docs output really contains the model id the message names.
    const out = [
      {
        label: "apps/docs/.next/server/app/models.html",
        text: "<code>claude-sonnet-4-6</code> <code>@modelcontextprotocol/sdk</code> vitest-coverage-v8x",
      },
    ];
    for (const m of REAL_COMMIT_MESSAGES) {
      expect(m.length).toBeGreaterThan(OUTPUT_SCAN_MIN_LENGTH);
      for (const name of [
        "VERCEL_GIT_COMMIT_MESSAGE",
        "VITE_VERCEL_GIT_COMMIT_MESSAGE",
        "NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE",
      ]) {
        expect(scanOutputForEnvValues("docs", [{ name, value: m }], out).findings, name).toEqual(
          [],
        );
      }
      // Without the exact-name exclusion, the narrowed needle policy alone keeps a
      // non-secret name green (the fragment is not a needle) ...
      expect(
        scanOutputForEnvValues("docs", [{ name: "BUILD_DESCRIPTION", value: m }], out).findings,
      ).toEqual([]);
    }
    // ... while the same text under a secret-shaped name is still caught by fragment.
    expect(
      scanOutputForEnvValues(
        "docs",
        [{ name: "RELEASE_TOKEN", value: REAL_COMMIT_MESSAGES[0]! }],
        out,
      ).findings.join("\n"),
    ).toMatch(/RELEASE_TOKEN \(fragment;/);
  });

  it("checkBuildOutput (the build-script entry) applies the same policy to a Vercel-like env", () => {
    const root = join(tmp, "r5-vercel");
    const full = join(root, "apps", "docs", ".next", "static", "chunks", "a.js");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `const m="claude-sonnet-4-6";const k=${JSON.stringify(SECRET)};`);
    const env = {
      VERCEL: "1",
      CI: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "motebit-docs-git-fix-motebit.vercel.app",
      VERCEL_GIT_COMMIT_MESSAGE: REAL_COMMIT_MESSAGES[0],
      VERCEL_GIT_COMMIT_AUTHOR_NAME: "Some Author",
      VERCEL_GIT_COMMIT_REF: "fix/no-browser-provider-keys",
    };
    expect(checkBuildOutput("docs", { repo: root, processEnv: env }).findings).toEqual([]);
    const red = checkBuildOutput("docs", {
      repo: root,
      processEnv: { ...env, STRIPE_SECRET_KEY: SECRET },
    });
    expect(red.findings.join("\n")).toMatch(/carries the value of STRIPE_SECRET_KEY/);
    expect(red.excluded["platform metadata"]).toBe(4); // + VERCEL_URL (preview metadataBase)
  });

  it("Skew Protection: a docs/web build whose every file carries the deployment id builds green; a secret beside it is RED", () => {
    // Vercel sets NEXT_DEPLOYMENT_ID / VERCEL_DEPLOYMENT_ID; Next inlines it as `?dpl=` into every page/chunk.
    const DPL = `dpl_${fake(AN, 28, 11)}`;
    expect(DPL).toHaveLength(32);
    // Without the exact-name exclusion the id would be scanned (32 chars, not scalar/path/locator).
    expect(outputScanExclusion(DPL, new Set())).toBeNull();
    const env = {
      VERCEL: "1",
      CI: "1",
      VERCEL_ENV: "production",
      VERCEL_URL: "motebit-docs-git-fix-motebit.vercel.app",
      VERCEL_GIT_COMMIT_MESSAGE: REAL_COMMIT_MESSAGES[0],
      NEXT_DEPLOYMENT_ID: DPL,
      VERCEL_DEPLOYMENT_ID: DPL,
    };
    const builds: [string, string[]][] = [
      [
        "docs",
        [
          ".next/static/chunks/main-app.js",
          ".next/server/app/index.html",
          ".next/server/app/docs/page.html",
        ],
      ],
      ["web", ["dist/index.html", "dist/assets/main-abc.js"]],
    ];
    for (const [app, files] of builds) {
      const root = join(tmp, `r5-dpl-${app}`);
      for (const f of files) {
        const full = join(root, "apps", app, f);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(
          full,
          `<script src="/_next/static/chunks/x.js?dpl=${DPL}"></script>` +
            `self.__next_f.push([1,${JSON.stringify(JSON.stringify({ dpl: DPL }))}]);` +
            `const k=${JSON.stringify(SECRET)};`,
        );
      }
      const green = checkBuildOutput(app, { repo: root, processEnv: env });
      expect(green.files, app).toBeGreaterThan(0);
      expect(green.findings, app).toEqual([]);
      expect(green.excluded["platform metadata"], app).toBe(4); // + VERCEL_URL
      const red = checkBuildOutput(app, {
        repo: root,
        processEnv: { ...env, STRIPE_SECRET_KEY: SECRET },
      });
      const msg = red.findings.join("\n");
      expect(msg, app).toMatch(/carries the value of STRIPE_SECRET_KEY/);
      expect(msg, app).not.toMatch(/DEPLOYMENT_ID/);
      expect(msg, app).not.toContain(DPL);
    }
  });

  it("the repair hint never tells you to allowlist a non-public var", () => {
    const msg = outputScanRefusal("docs", ["x carries the value of STRIPE_SECRET_KEY (raw)"]);
    expect(msg).toMatch(/Never rename a non-public var/);
    expect(msg).toMatch(/Only a var that ALREADY carries a public prefix/);
    expect(msg).not.toMatch(/or — only if it is genuinely public — add it to PUBLIC_BUILD_ENV/);
  });
});

describe("R5 mutation pins: json-escaped twice, base64url and the latin1 conversion", () => {
  it("json-escaped twice is the ONLY needle that finds a double-escaped value (no fragment rescue)", () => {
    // Non-secret name: no fragments. The value has `"` and `\\`, so twice ≠ once ≠ raw.
    const v = `abc"def\\ghi"jkl mno pqr`;
    const text = JSON.stringify(JSON.stringify({ k: v }));
    const hits = valueNeedles(v, { fragments: false }).filter((n) => text.includes(n.needle));
    expect(hits.map((n) => n.encoding)).toEqual(["json-escaped twice"]);
    const r = scanOutputForEnvValues(
      "verify",
      [{ name: "DEPLOY_NOTE", value: v }],
      [{ label: "server.js", text }],
    );
    expect(r.findings.join("\n")).toMatch(/DEPLOY_NOTE \(json-escaped twice;/);
  });

  it("a secret whose base64 carries `+`/`/`, shipped as base64url, is found ONLY by the base64url needle", () => {
    // All escape-stable chars, so the value is its own (and only) fragment: no fragment rescue.
    const v = "sk_live_~~~Q7m2Xr9KpZ4t8WvN3bLc~~~";
    const b64 = Buffer.from(v, "utf8").toString("base64");
    expect(b64).toMatch(/[+/]/);
    const shipped = Buffer.from(v, "utf8").toString("base64url");
    expect(shipped).not.toBe(b64.replace(/=+$/, ""));
    const text = `const blob="${shipped}";`;
    expect(valueNeedles(v).some((n) => n.encoding === "fragment")).toBe(false);
    const hits = valueNeedles(v).filter((n) => text.includes(n.needle));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((n) => n.encoding.startsWith("base64url of "))).toBe(true);
    const r = scanOutputForEnvValues(
      "web",
      [{ name: "HELIUS_API_KEY", value: v }],
      [{ label: "dist/assets/b.js", text }],
    );
    expect(r.findings.join("\n")).toMatch(/HELIUS_API_KEY \(base64url of /);
    expect(r.findings.join("\n")).not.toContain(v);
  });

  it("a non-ASCII value is found byte-for-byte in output read as latin1 (only via the latin1 conversion)", () => {
    // Non-secret name; no `"`/`\\`, so raw is the only plain-text form that matches.
    const v = "café-Überprüfung-naïve-ñandú-ø";
    const r = plantOutput("r5-latin1", "verify", "dist/assets/u.js", "DEPLOY_NOTE", v);
    expect(r.findings.join("\n")).toMatch(/DEPLOY_NOTE \(raw;/);
    const fileText = Buffer.from(`const k=${JSON.stringify(v)};`, "utf8").toString("latin1");
    const hits = valueNeedles(v, { fragments: false }).filter((n) => fileText.includes(n.needle));
    expect(hits.map((n) => n.encoding)).toEqual(["raw"]);
    // The JS string itself (UTF-16 code points) is NOT in the latin1-read file.
    expect(fileText.includes(v)).toBe(false);
  });
});

describe("R6 a Vercel preview's full system env: the docs build is green, platform secrets stay RED", () => {
  // PR #1050: the motebit-docs Preview failed on every commit while main passed. Reproduced
  // locally by `next build` under this env: Next inlined NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID (the
  // twin of the excluded VERCEL_DEPLOYMENT_ID) as `?dpl=` into every page, and on a preview it
  // overrides metadataBase with VERCEL_BRANCH_URL || VERCEL_URL in og:image/twitter:image.
  const SHA = fake("0123456789abcdef", 40, 3);
  const DPL = `dpl_${fake(AN, 28, 5)}`;
  const OIDC =
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
    Buffer.from(
      '{"iss":"https://oidc.vercel.com/motebit","sub":"owner:motebit:project:motebit-docs"}',
    ).toString("base64url") +
    `.${fake(AN, 86, 9)}`;
  const BYPASS = fake(AN, 32, 13);
  const RAW: Record<string, string> = {
    VERCEL_ENV: "preview",
    VERCEL_TARGET_ENV: "preview",
    VERCEL_URL: "motebit-docs-k3j9x2abq-motebit.vercel.app",
    VERCEL_BRANCH_URL: "motebit-docs-git-fix-no-browser-provider-keys-v2-motebit.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "docs.motebit.com",
    VERCEL_REGION: "iad1",
    VERCEL_DEPLOYMENT_ID: DPL,
    VERCEL_PROJECT_ID: `prj_${fake(AN, 28, 17)}`,
    VERCEL_SKEW_PROTECTION_ENABLED: "1",
    VERCEL_GIT_PROVIDER: "github",
    VERCEL_GIT_REPO_SLUG: "motebit",
    VERCEL_GIT_REPO_OWNER: "motebit",
    VERCEL_GIT_REPO_ID: "812345678",
    VERCEL_GIT_COMMIT_REF: "fix/no-browser-provider-keys-v2",
    VERCEL_GIT_COMMIT_SHA: SHA,
    VERCEL_GIT_PREVIOUS_SHA: fake("0123456789abcdef", 40, 4),
    VERCEL_GIT_COMMIT_MESSAGE: REAL_COMMIT_MESSAGES[0] ?? "",
    VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "hakimlabs",
    VERCEL_GIT_COMMIT_AUTHOR_NAME: "hakimlabs",
    VERCEL_GIT_PULL_REQUEST_ID: "1050",
  };
  const VERCEL_ENV: Record<string, string> = {
    VERCEL: "1",
    CI: "1",
    NODE_ENV: "production",
    NEXT_DEPLOYMENT_ID: DPL,
    VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS,
    VERCEL_OIDC_TOKEN: OIDC,
    ...RAW,
    // "Automatically expose System Environment Variables": the NEXT_PUBLIC_ twins.
    ...Object.fromEntries(Object.entries(RAW).map(([k, v]) => [`NEXT_PUBLIC_${k}`, v])),
  };

  /** The og:image origin Next itself computes for this env (its real resolver, executed). */
  function nextPreviewOrigin(): string {
    const req = createRequire(join(ROOT, "apps", "docs", "package.json"));
    const mod = req("next/dist/lib/metadata/resolvers/resolve-url") as {
      getSocialImageMetadataBaseFallback: (base: URL | null) => URL;
    };
    const saved = { ...process.env };
    Object.assign(process.env, VERCEL_ENV);
    try {
      return String(mod.getSocialImageMetadataBaseFallback(new URL("https://docs.motebit.com")));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }

  function stageNextOutput(name: string, extra = ""): string {
    const root = join(tmp, name);
    const origin = nextPreviewOrigin();
    const page =
      `<link rel="preload" href="/_next/static/chunks/x.js?dpl=${DPL}"/>` +
      `<meta property="og:image" content="${origin}opengraph-image.png"/>` +
      `<meta name="twitter:image" content="${origin}opengraph-image.png"/>` +
      `self.__next_f.push([1,${JSON.stringify(JSON.stringify({ dpl: DPL }))}]);${extra}`;
    for (const f of [
      ".next/server/pages/404.html",
      ".next/server/app/docs/security.rsc",
      ".next/static/chunks/main-app.js",
    ]) {
      const full = join(root, "apps", "docs", f);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, page);
    }
    return root;
  }

  it("Next's preview og:image origin is the branch URL, which the locator rule alone would scan", () => {
    expect(nextPreviewOrigin()).toBe(`https://${RAW.VERCEL_BRANCH_URL}/`);
    // Without the exact-name exclusion each would be scanned (and RED the docs build).
    for (const n of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_DEPLOYMENT_ID"]) {
      expect(outputScanExclusion(RAW[n] ?? "", new Set()), n).toBeNull();
    }
  });

  it("a Next-shaped docs output under the full Vercel preview env is GREEN", () => {
    const r = checkBuildOutput("docs", {
      repo: stageNextOutput("r6-green"),
      processEnv: VERCEL_ENV,
    });
    expect(r.files).toBe(3);
    expect(r.findings).toEqual([]);
    // Each exclusion was by exact name, never by the value's shape.
    for (const n of [
      "NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID",
      "VERCEL_URL",
      "VERCEL_BRANCH_URL",
      "NEXT_PUBLIC_VERCEL_URL",
      "NEXT_PUBLIC_VERCEL_BRANCH_URL",
    ]) {
      expect(outputScanExclusion(RAW[n.replace(/^NEXT_PUBLIC_/, "")] ?? "", new Set(), n), n).toBe(
        "platform metadata",
      );
    }
  });

  for (const [name, value] of [
    ["VERCEL_OIDC_TOKEN", OIDC],
    ["VERCEL_AUTOMATION_BYPASS_SECRET", BYPASS],
  ] as const) {
    it(`${name} is never excluded: planted raw or base64 in that output, the scan is RED and redacts`, () => {
      expect(OUTPUT_SCAN_EXCLUDED_ENV_NAMES.has(name)).toBe(false);
      expect(isSecretShapedEnvName(name)).toBe(true);
      for (const [label, planted] of [
        ["raw", value],
        ["base64", Buffer.from(value).toString("base64")],
      ] as const) {
        const root = stageNextOutput(
          `r6-red-${name}-${label}`,
          `const k=${JSON.stringify(planted)};`,
        );
        const r = checkBuildOutput("docs", { repo: root, processEnv: VERCEL_ENV });
        const msg = r.findings.join("\n");
        expect(msg, label).toMatch(new RegExp(`carries the value of ${name} \\(`));
        expect(msg, label).not.toMatch(/DEPLOYMENT_ID|BRANCH_URL|VERCEL_URL/);
        expect(msg, label).not.toContain(value);
      }
    });
  }
});

describe("LOCAL_OPERATOR_TOKEN premise (never deployed) is checked, not assumed", () => {
  function premiseRoot(name: string): string {
    const root = join(tmp, `premise-${name}`);
    mkdirSync(join(root, "apps", "operator"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(root, "apps", "operator", "package.json"),
      JSON.stringify({ name: "@motebit/operator" }),
    );
    writeFileSync(
      join(root, ".github", "workflows", "deploy-web.yml"),
      "jobs:\n  d:\n    steps:\n      - run: pnpm --filter @motebit/operator-ish build\n",
    );
    return root;
  }

  it("derives the local-only apps from the allowlist itself", () => {
    expect(localOnlyApps()).toEqual(["inspector", "operator"]);
  });

  it("GREEN when no hosting config or workflow names a local-only app", () => {
    expect(localOnlyPremiseViolations(premiseRoot("clean")).findings).toEqual([]);
  });

  it("RED on a hosting config in a local-only app", () => {
    for (const cf of ["vercel.json", "netlify.toml", "fly.toml"]) {
      const root = premiseRoot(`cfg-${cf}`);
      writeFileSync(join(root, "apps", "operator", cf), "{}\n");
      const f = localOnlyPremiseViolations(root).findings;
      expect(f.some((x) => x.startsWith(`apps/operator/${cf} — local-only app`))).toBe(true);
    }
  });

  it("RED on a workflow referencing a local-only app by path or by package name", () => {
    for (const ref of [
      "working-directory: apps/operator",
      "pnpm --filter @motebit/operator build",
    ]) {
      const root = premiseRoot(`wf-${ref.length}`);
      writeFileSync(
        join(root, ".github", "workflows", "deploy-x.yml"),
        `steps:\n  - run: ${ref}\n`,
      );
      const f = localOnlyPremiseViolations(root).findings;
      expect(
        f.some((x) =>
          x.startsWith(".github/workflows/deploy-x.yml — references local-only app `operator`"),
        ),
      ).toBe(true);
    }
  });

  it("RED on a repo-root hosting config naming a local-only app", () => {
    const root = premiseRoot("rootcfg");
    writeFileSync(join(root, "vercel.json"), JSON.stringify({ rootDirectory: "apps/operator" }));
    expect(
      localOnlyPremiseViolations(root).findings.some((x) => x.startsWith("vercel.json —")),
    ).toBe(true);
  });
});

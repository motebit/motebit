/**
 * The client-bundle secrets law — one source for every place that decides
 * whether a value may reach a browser.
 *
 * Law: a provider credential never reaches a browser, by construction.
 * Bundlers inline every public-prefixed env var (`VITE_*`, `NEXT_PUBLIC_*`,
 * `EXPO_PUBLIC_*`) into shipped JS as a string literal. Incident 2026-09-30:
 * `apps/web` read `VITE_SOLANA_RPC_URL`, a comment told deployers to set it to
 * a Helius endpoint, and `https://mainnet.helius-rpc.com/?api-key=<uuid>` shipped
 * in `https://motebit.com/assets/main-*.js`. Strangers spent the account's
 * credits to 1M/1M and the provider halted every key on it.
 *
 * Consumers, one module (zero imports so vite configs can load it):
 *   - `publicBuildEnvGuard` + `PUBLIC_BUILD_ENV` — a Vite plugin in apps/web +
 *     apps/verify `vite.config.ts` that judges Vite's OWN resolved env
 *     (`config.env` + `import.meta.env.*` defines) in `configResolved`; DENY BY
 *     DEFAULT: the build FAILS on any var not named for that surface, and every
 *     named var has a value validator (URL: https + host allowlist + no userinfo/
 *     query/key-in-path; Stripe: publishable only). `generateBundle` re-checks
 *     the emitted chunks for any refused value (defence in depth).
 *   - `publicEnvViolations` — the same law, reused by the gate's static arm (names
 *     referenced in a governed surface's source) and dist arm (the env literal a
 *     bundler emitted), so the build and the gate refuse exactly the same things.
 *   - `scanSourceForPublicEnvNames` + `PUBLIC_ENV_ALLOWLIST` — the static arm for
 *     every OTHER app (local-only surfaces), credential-shaped names.
 *   - `scanArtifactText` + `CREDENTIAL_RULES` — credential shapes in any dist.
 *
 * Doctrine: CLAUDE.md "Fail-closed privacy"; docs/doctrine/security-boundaries.md.
 */

/** Env prefixes a bundler inlines into client code. */
export const PUBLIC_ENV_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"] as const;

/** A public env NAME that smells like a credential or a credential-bearing URL. */
export const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PRIVATE|RPC_URL|API/;

/** Case-insensitive: vite inlines `VITE_helius_api_key` exactly like `VITE_HELIUS_API_KEY`. */
const PUBLIC_ENV_TOKEN = /\b(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_[A-Za-z0-9_]+\b/gi;

export interface PublicEnvAllowEntry {
  /** Repo-relative file the name may appear in. */
  readonly file: string;
  readonly name: string;
  /** Why this name is safe to inline into a client bundle. Required. */
  readonly why: string;
}

const LOCAL_DEV_KEY =
  "developer's OWN key for a local desktop (Tauri) build, read from their untracked .env; no deploy or release workflow sets it (release-desktop.yml passes no VITE_* env), so no shipped binary carries a motebit credential";
const LOCAL_OPERATOR_TOKEN =
  "local-only operator console (never deployed: no vercel.json, no deploy workflow) — the operator bakes their own relay bearer into a bundle served on their own machine";

/**
 * Every public env name matching `SECRET_ENV_NAME` that may appear in the source
 * of an app NOT governed by `PUBLIC_BUILD_ENV` (local-only surfaces), with its
 * justification. Deny by default: a name not listed here, or listed for a
 * different file, is RED. Governed surfaces (web, verify) answer to
 * `PUBLIC_BUILD_ENV` instead — every public name, not only credential-shaped ones.
 */
export const PUBLIC_ENV_ALLOWLIST: readonly PublicEnvAllowEntry[] = [
  {
    file: "apps/desktop/src/desktop-tools.ts",
    name: "VITE_BRAVE_SEARCH_API_KEY",
    why: LOCAL_DEV_KEY,
  },
  { file: "apps/desktop/src/ui/config.ts", name: "VITE_ANTHROPIC_API_KEY", why: LOCAL_DEV_KEY },
  {
    file: "apps/desktop/src/vite-env.d.ts",
    name: "VITE_ANTHROPIC_API_KEY",
    why: "type declaration only (no value)",
  },
  { file: "apps/inspector/src/api.ts", name: "VITE_API_TOKEN", why: LOCAL_OPERATOR_TOKEN },
  { file: "apps/operator/src/api.ts", name: "VITE_API_TOKEN", why: LOCAL_OPERATOR_TOKEN },
  {
    file: "apps/operator/src/index.ts",
    name: "VITE_API_TOKEN",
    why: "doc comment naming the operator auth model (no value)",
  },
  {
    file: "apps/inspector/src/api.ts",
    name: "VITE_API_URL",
    why: "a public relay base URL (no credential); the name matches /API/ only",
  },
  {
    file: "apps/inspector/src/vite-env.d.ts",
    name: "VITE_API_URL",
    why: "type declaration only (no value)",
  },
  {
    file: "apps/operator/src/api.ts",
    name: "VITE_API_URL",
    why: "a public relay base URL (no credential); the name matches /API/ only",
  },
];

/** Every public-prefixed env name referenced in `text` (code or comment). */
export function scanSourceForPublicEnvNames(text: string): { name: string; offset: number }[] {
  const out: { name: string; offset: number }[] = [];
  for (const m of text.matchAll(PUBLIC_ENV_TOKEN)) out.push({ name: m[0], offset: m.index ?? 0 });
  return out;
}

export function isSecretShapedEnvName(name: string): boolean {
  const bare = name.replace(/^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/i, "");
  return SECRET_ENV_NAME.test(bare.toUpperCase());
}

/** `abcd…(36)` — enough to locate, never enough to use. */
export function redactValue(value: string): string {
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

export interface CredentialRule {
  readonly id: string;
  readonly description: string;
  /** Offsets + the matched credential value (callers must redact before printing). */
  readonly find: (text: string) => { offset: number; value: string }[];
}

function regexRule(id: string, description: string, re: RegExp, group = 0): CredentialRule {
  return {
    id,
    description,
    find(text) {
      const out: { offset: number; value: string }[] = [];
      for (const m of text.matchAll(
        new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
      )) {
        out.push({ offset: m.index ?? 0, value: m[group] ?? m[0] });
      }
      return out;
    },
  };
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{16,}/g;
const KNOWN_JWT_ISSUER =
  /supabase|securetoken\.google\.com|accounts\.google\.com|auth0\.com|clerk\.|cognito-idp|motebit|firebase|okta\.com|login\.microsoftonline\.com/i;

function b64urlDecode(s: string): string {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch {
    return "";
  }
}

/**
 * Credential shapes that must never appear in a built client artifact. Each id
 * has a committed test in scripts/__tests__/check-no-secrets-in-client-bundles.test.ts;
 * deleting a rule turns that test red (the gate-mutation table).
 */
export const CREDENTIAL_RULES: readonly CredentialRule[] = [
  regexRule(
    "query-api-key",
    "an `api-key=` / `api_key=` / `apikey=` query parameter with a literal value (the 2026-09-30 Helius shape)",
    /[?&](?:api[-_]?key|apikey)=([A-Za-z0-9._~%-]{8,})/i,
    1,
  ),
  regexRule(
    "stripe-secret",
    "a Stripe secret or restricted key (`sk_live_` / `sk_test_` / `rk_live_`)",
    /\b(?:sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9]{10,}/,
  ),
  regexRule(
    "github-token",
    "a GitHub token (`ghp_…` / `github_pat_…`)",
    /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/,
  ),
  regexRule("aws-access-key", "an AWS access key id (`AKIA…`)", /\bAKIA[0-9A-Z]{16}\b/),
  regexRule(
    "pem-private-key",
    "a PEM private key block (header followed by key material)",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\\r|\s)*[A-Za-z0-9+/=]{40,}/,
  ),
  regexRule("slack-token", "a Slack token (`xox[baprs]-…`)", /\bxox[baprs]-[A-Za-z0-9-]{10,}/),
  regexRule(
    "llm-provider-key",
    "an LLM provider secret key (`sk-ant-…` / `sk-proj-…`)",
    /\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}/,
  ),
  {
    id: "jwt-known-issuer",
    description: "a JWT whose payload names a known identity issuer (or a service_role claim)",
    find(text) {
      const out: { offset: number; value: string }[] = [];
      for (const m of text.matchAll(JWT)) {
        const payload = b64urlDecode(m[1] ?? "");
        let iss = "";
        let role = "";
        try {
          const p = JSON.parse(payload) as { iss?: unknown; role?: unknown };
          iss = typeof p.iss === "string" ? p.iss : "";
          role = typeof p.role === "string" ? p.role : "";
        } catch {
          continue;
        }
        if (KNOWN_JWT_ISSUER.test(iss) || role === "service_role") {
          out.push({ offset: m.index ?? 0, value: m[0] });
        }
      }
      return out;
    },
  },
  regexRule(
    "hex-bearer",
    "a 64-hex token assigned to an auth-ish identifier (token/secret/bearer/authorization/apiKey/password)",
    /\b[A-Za-z_$]*(?:token|secret|bearer|authorization|api_?key|apikey|password)[A-Za-z_$]*["']?\s*[:=]\s*["'`](?:Bearer )?([0-9a-fA-F]{64})["'`]/i,
    1,
  ),
];

export interface ArtifactFinding {
  readonly rule: string;
  readonly offset: number;
  readonly redacted: string;
}

export function scanArtifactText(
  text: string,
  rules: readonly CredentialRule[] = CREDENTIAL_RULES,
): ArtifactFinding[] {
  const out: ArtifactFinding[] = [];
  for (const rule of rules) {
    for (const hit of rule.find(text)) {
      out.push({ rule: rule.id, offset: hit.offset, redacted: redactValue(hit.value) });
    }
  }
  return out;
}

// ── The public build env law (deny by default, per surface) ────────────────
//
// A shape denylist over VALUES missed the next leak before it happened: a key in
// a URL PATH (Alchemy `/v2/<key>`, QuickNode `/<40hex>/`, Triton `/<uuid>`),
// under a non-credential name (`VITE_RPC_ENDPOINT`), or under a lowercase name
// (`VITE_helius_api_key`) all shipped green. So the law is inverted: a deployed
// browser surface names EVERY public env var it may be built with, each with a
// value validator; anything else in the build env refuses the build.

/** How a public env value is validated. */
export type PublicValueRule =
  | {
      readonly kind: "url";
      /** Exact hostnames, or `*.example.com` (subdomains only — list the apex separately). */
      readonly hosts: readonly string[];
    }
  | { readonly kind: "stripe-publishable" }
  | { readonly kind: "enum"; readonly values: readonly string[] };

export interface PublicBuildEnvEntry {
  readonly name: string;
  readonly rule: PublicValueRule;
  /** Why this var may be inlined into public JS. Required. */
  readonly why: string;
}

/** Hosts every URL-valued var may point at during local development. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1"] as const;
const MOTEBIT_HOSTS = ["motebit.com", "*.motebit.com", ...LOCAL_HOSTS] as const;

/** Set by vite itself when a `.env` file carries NODE_ENV; public metadata only. */
const VITE_USER_NODE_ENV: PublicBuildEnvEntry = {
  name: "VITE_USER_NODE_ENV",
  rule: { kind: "enum", values: ["production", "development", "test"] },
  why: "written into process.env by vite's own loadEnv when a .env file sets NODE_ENV; a mode label, never a credential",
};

/**
 * Every public env var a deployed Vite surface may be built with — keyed by the
 * app directory under `apps/`. Deny by default: a public-prefixed name (any case)
 * not listed for that surface refuses the build (`enforcePublicBuildEnv`) and
 * turns `check-no-secrets-in-client-bundles` red (static + dist arms).
 */
export const PUBLIC_BUILD_ENV: Readonly<Record<string, readonly PublicBuildEnvEntry[]>> = {
  web: [
    {
      name: "VITE_PROXY_URL",
      rule: { kind: "url", hosts: MOTEBIT_HOSTS },
      why: "set in Vercel project motebit-web: the motebit relay/proxy base (deprecated alias of VITE_MOTEBIT_RELAY_URL); a public origin",
    },
    {
      name: "VITE_MOTEBIT_RELAY_URL",
      rule: { kind: "url", hosts: MOTEBIT_HOSTS },
      why: "canonical relay/proxy base URL (apps/web/src/providers.ts); a public origin",
    },
    {
      name: "VITE_RELAY_URL",
      rule: { kind: "url", hosts: MOTEBIT_HOSTS },
      why: "relay base URL override (apps/web/src/storage.ts); a public origin",
    },
    {
      name: "VITE_SEARCH_URL",
      rule: { kind: "url", hosts: [...MOTEBIT_HOSTS, "motebit-web-search.fly.dev"] },
      why: "web-search worker base URL (apps/web/src/web-app.ts); a public origin",
    },
    {
      name: "VITE_BROWSER_SANDBOX_URL",
      rule: { kind: "url", hosts: [...MOTEBIT_HOSTS, "motebit-browser-sandbox.fly.dev"] },
      why: "set in Vercel project motebit-web: the services/browser-sandbox origin (auth is a per-session relay grant, never a baked key)",
    },
    {
      name: "VITE_SOLANA_RPC_URL",
      rule: { kind: "url", hosts: MOTEBIT_HOSTS },
      why: "local-dev override of the server-side passthrough https://api.motebit.com/v1/solana-rpc; a provider host can never validate",
    },
    {
      name: "VITE_STRIPE_PUBLISHABLE_KEY",
      rule: { kind: "stripe-publishable" },
      why: "set in Vercel project motebit-web: a Stripe publishable key (pk_live_/pk_test_), public by design; secret/restricted keys cannot validate",
    },
    VITE_USER_NODE_ENV,
  ],
  verify: [
    {
      name: "VITE_RELAY_URL",
      rule: { kind: "url", hosts: [...MOTEBIT_HOSTS, "receipt.computer"] },
      why: "relay base URL override (apps/verify/src/main.ts); Vercel project receipt-computer sets no VITE_* var",
    },
    {
      name: "VITE_SOLANA_RPC_URL",
      rule: { kind: "url", hosts: [...MOTEBIT_HOSTS, "receipt.computer"] },
      why: "local-dev override of https://api.motebit.com/v1/solana-rpc (apps/verify/src/main.ts); a provider host can never validate",
    },
    VITE_USER_NODE_ENV,
  ],
};

/** A public-prefixed env name, case-insensitive (`vite_x` is refused too). */
export function isPublicEnvName(name: string): boolean {
  return /^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/i.test(name);
}

/**
 * Vercel's "automatically expose System Environment Variables" injects
 * `VITE_VERCEL_*` (commit sha/message/author, deployment urls) into every Vite
 * build. No source reads them; `publicBuildEnvGuard`'s `config` hook deletes
 * them from process.env before Vite reads it, so they never ship. Dropping is the safe
 * direction: a dropped var is never inlined. Only process.env is dropped from —
 * the same name in a `.env` file is an unknown var and refuses.
 */
export const PLATFORM_DROPPED_PUBLIC_ENV = /^VITE_VERCEL_[A-Z0-9_]*$/;

function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return hosts.some((p) =>
    p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p,
  );
}

/**
 * A path segment ≥ 20 chars is refused unless it is a plain hyphenated word
 * slug (`solana-rpc`, `browser-sandbox`): a key, hex id or uuid never is one.
 */
const WORD_SLUG = /^[a-z]{1,15}(?:-[a-z]{1,15})*$/;

/** Why a URL-valued public env value is refused, or null when acceptable. */
export function publicUrlViolation(raw: string, hosts: readonly string[]): string | null {
  const v = raw.trim();
  if (v !== raw) return "has surrounding whitespace";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "is not a parseable URL";
  }
  const local = (LOCAL_HOSTS as readonly string[]).includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return `uses ${u.protocol} (only https:, or http: for localhost/127.0.0.1)`;
  }
  if (u.username !== "" || u.password !== "" || /\/\/[^/]*@/.test(v)) {
    return "carries userinfo";
  }
  if (u.search !== "" || v.includes("?")) return "carries a query string";
  if (u.hash !== "" || v.includes("#")) return "carries a fragment";
  if (!hostAllowed(u.hostname, hosts)) {
    return `host ${u.hostname} is not in its host allowlist (${hosts.join(", ")})`;
  }
  for (const seg of u.pathname.split("/")) {
    let s = seg;
    try {
      s = decodeURIComponent(seg);
    } catch {
      return "has an undecodable path segment";
    }
    if (s.length >= 20 && !WORD_SLUG.test(s)) {
      return `has a ${s.length}-char high-entropy path segment (a key-in-path shape)`;
    }
  }
  return null;
}

/** Why `value` is refused for a named entry, or null when acceptable. */
export function publicValueViolation(value: string, rule: PublicValueRule): string | null {
  if (value === "") return null;
  switch (rule.kind) {
    case "url":
      return publicUrlViolation(value, rule.hosts);
    case "stripe-publishable":
      return /^pk_(?:live|test)_[A-Za-z0-9]+$/.test(value)
        ? null
        : "is not a Stripe publishable key (^pk_(live|test)_[A-Za-z0-9]+$)";
    case "enum":
      return rule.values.includes(value) ? null : `is not one of ${rule.values.join(" | ")}`;
  }
}

/**
 * The one law, applied to a set of public env entries for a surface. Returns
 * every violation (values redacted). Used by the build guard AND by the gate's
 * static + dist arms, so all three refuse exactly the same things.
 */
export function publicEnvViolations(
  app: string,
  entries: readonly { name: string; value?: string }[],
  spec: Readonly<Record<string, readonly PublicBuildEnvEntry[]>> = PUBLIC_BUILD_ENV,
): string[] {
  const allowed = spec[app];
  if (allowed == null)
    return [`apps/${app} has no PUBLIC_BUILD_ENV entry — every surface must name its public env`];
  const byName = new Map(allowed.map((e) => [e.name, e]));
  const problems: string[] = [];
  for (const { name, value } of entries) {
    if (!isPublicEnvName(name)) continue;
    const shown = value == null ? "" : ` (value ${redactValue(value)})`;
    const entry = byName.get(name);
    if (entry == null) {
      problems.push(
        `${name} is not in PUBLIC_BUILD_ENV.${app} — an unlisted public env var is inlined into client JS${shown}`,
      );
      continue;
    }
    if (value == null) continue;
    const why = publicValueViolation(value, entry.rule);
    if (why) problems.push(`${name} ${why}${shown}`);
  }
  return problems;
}

/** Keys Vite itself puts in `import.meta.env` (never a user var). */
export const VITE_BUILTIN_ENV: ReadonlySet<string> = new Set([
  "BASE_URL",
  "MODE",
  "DEV",
  "PROD",
  "SSR",
]);

function envValueString(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
}

/** A `define` value is a JS expression; a JSON string literal is judged as its string. */
function defineValueString(v: unknown): string {
  if (typeof v !== "string") return envValueString(v);
  try {
    const parsed: unknown = JSON.parse(v);
    return typeof parsed === "string" ? parsed : v;
  } catch {
    return v;
  }
}

/**
 * The law applied to what Vite will ACTUALLY inline: its resolved `config.env`
 * (every var loaded from `envDir` — which defaults to `root`, not the cwd — for
 * the build's `mode`, plus matching process.env vars) and every `define` key
 * under `import.meta.env.`. Deny by default: every non-builtin key must be named
 * in `PUBLIC_BUILD_ENV[app]` — a key Vite resolved under a custom `envPrefix`
 * is judged too — and its value must pass that entry's validator.
 */
export function resolvedEnvViolations(
  app: string,
  env: Readonly<Record<string, unknown>>,
  define: Readonly<Record<string, unknown>> = {},
  spec: Readonly<Record<string, readonly PublicBuildEnvEntry[]>> = PUBLIC_BUILD_ENV,
): string[] {
  const allowed = spec[app];
  if (allowed == null)
    return [`apps/${app} has no PUBLIC_BUILD_ENV entry — every surface must name its public env`];
  const byName = new Map(allowed.map((e) => [e.name, e]));
  const entries: { name: string; value: string; via: string }[] = [];
  for (const [name, v] of Object.entries(env)) {
    if (VITE_BUILTIN_ENV.has(name)) continue;
    entries.push({ name, value: envValueString(v), via: "" });
  }
  for (const [key, v] of Object.entries(define)) {
    if (!key.startsWith("import.meta.env.")) continue;
    const name = key.slice("import.meta.env.".length);
    if (VITE_BUILTIN_ENV.has(name)) continue;
    entries.push({ name, value: defineValueString(v), via: " (via define)" });
  }
  const problems: string[] = [];
  for (const { name, value, via } of entries) {
    const shown = ` (value ${redactValue(value)})`;
    const entry = byName.get(name);
    if (entry == null) {
      problems.push(
        `${name}${via} is not in PUBLIC_BUILD_ENV.${app} — an unlisted var in Vite's resolved env is inlined into client JS${shown}`,
      );
      continue;
    }
    const why = publicValueViolation(value, entry.rule);
    if (why) problems.push(`${name}${via} ${why}${shown}`);
  }
  return problems;
}

function refusalMessage(app: string, problems: readonly string[], where: string): string {
  return (
    `[apps/${app}] refusing to build: ${where}.\n` +
    problems.map((p) => `  - ${p}`).join("\n") +
    `\n  Fix: unset it from the build environment (Vercel project env / .env* in the app's envDir), or — only if it is genuinely public — ` +
    `add it to PUBLIC_BUILD_ENV.${app} with a value validator and a why. Browser Solana RPC goes through ` +
    "https://api.motebit.com/v1/solana-rpc (services/proxy), which holds the provider key as the server secret " +
    "SOLANA_RPC_UPSTREAM_URL. Law: scripts/lib/client-bundle-secrets.ts."
  );
}

/**
 * Throws when Vite's resolved env (+ `import.meta.env.*` defines) breaks the
 * law. Pure: the plugin passes `config.env` / `config.define`.
 *
 * Why every var, not just the ones source reads: vite replaces whole-object
 * `import.meta.env` access (the `env?.VITE_X` shape apps/web uses) with a literal
 * of EVERY var in its resolved env, so an unused var still ships.
 */
export function enforcePublicBuildEnv(
  app: string,
  env: Readonly<Record<string, unknown>>,
  define: Readonly<Record<string, unknown>> = {},
): void {
  const problems = resolvedEnvViolations(app, env, define);
  if (problems.length > 0) {
    throw new Error(
      refusalMessage(
        app,
        problems,
        "Vite's resolved env carries a var that would ship in client JS unvalidated",
      ),
    );
  }
}

/** Values shorter than this are not scanned for in the output (too collision-prone). */
const MIN_SCANNED_VALUE = 8;

/**
 * Every value that must NOT appear in emitted output: any public-prefixed var
 * (any case) in `processEnv`, and any key in the resolved env / defines, whose
 * name is unlisted for `app` or whose value fails its validator.
 */
export function forbiddenEnvValues(
  app: string,
  env: Readonly<Record<string, unknown>>,
  define: Readonly<Record<string, unknown>>,
  processEnv: Readonly<Record<string, string | undefined>>,
): { name: string; value: string }[] {
  const byName = new Map((PUBLIC_BUILD_ENV[app] ?? []).map((e) => [e.name, e]));
  const candidates: { name: string; value: string }[] = [];
  for (const [name, v] of Object.entries(processEnv)) {
    if (isPublicEnvName(name) && v != null) candidates.push({ name, value: v });
  }
  for (const [name, v] of Object.entries(env)) {
    if (!VITE_BUILTIN_ENV.has(name)) candidates.push({ name, value: envValueString(v) });
  }
  for (const [key, v] of Object.entries(define)) {
    if (key.startsWith("import.meta.env.")) {
      candidates.push({ name: key.slice(16), value: defineValueString(v) });
    }
  }
  return candidates.filter(({ name, value }) => {
    if (value.length < MIN_SCANNED_VALUE) return false;
    const entry = byName.get(name);
    return entry == null || publicValueViolation(value, entry.rule) != null;
  });
}

/** The structural slice of a Vite plugin this guard implements (zero imports). */
export interface PublicBuildEnvGuardPlugin {
  readonly name: string;
  readonly enforce: "pre";
  config(): void;
  configResolved(config: { env: Record<string, unknown>; define?: Record<string, unknown> }): void;
  generateBundle(
    this: { error(message: string): never },
    options: unknown,
    bundle: Record<
      string,
      { type: "chunk"; code: string } | { type: "asset"; source: string | Uint8Array }
    >,
  ): void;
}

/**
 * The build guard for a deployed Vite surface: a Vite plugin, so it judges the
 * env Vite RESOLVED (root/envDir/mode/.env.local, whatever the invocation) —
 * never a re-derivation of it from the cwd (cold review R2: `vite build
 * apps/verify` from the repo root shipped a key from apps/verify/.env.production
 * while a `loadEnv(mode, process.cwd())` guard saw nothing).
 *
 *   - `config` (runs before Vite loads env): drops Vercel's injected
 *     `VITE_VERCEL_*` from process.env, so they are never resolved or inlined.
 *   - `configResolved`: `enforcePublicBuildEnv(app, config.env, config.define)` —
 *     the build (and dev server) refuses on any violation.
 *   - `generateBundle` (defence in depth): re-judges the final config (a later
 *     plugin may mutate it), then refuses if any forbidden value
 *     (`forbiddenEnvValues`) appears in any emitted chunk or asset.
 */
export function publicBuildEnvGuard(
  app: string,
  processEnv: Record<string, string | undefined> = process.env,
): PublicBuildEnvGuardPlugin {
  let resolved: { env: Record<string, unknown>; define: Record<string, unknown> } | null = null;
  return {
    name: "motebit:public-build-env-guard",
    enforce: "pre",
    config() {
      for (const k of Object.keys(processEnv)) {
        if (PLATFORM_DROPPED_PUBLIC_ENV.test(k)) delete processEnv[k];
      }
    },
    configResolved(config) {
      resolved = { env: config.env, define: config.define ?? {} };
      enforcePublicBuildEnv(app, resolved.env, resolved.define);
    },
    generateBundle(_options, bundle) {
      if (resolved == null) {
        this.error(
          refusalMessage(
            app,
            ["configResolved never ran"],
            "the env guard did not see the resolved config",
          ),
        );
      }
      const problems = resolvedEnvViolations(app, resolved.env, resolved.define);
      if (problems.length > 0) {
        this.error(
          refusalMessage(app, problems, "Vite's resolved env changed after configResolved"),
        );
      }
      const forbidden = forbiddenEnvValues(app, resolved.env, resolved.define, processEnv);
      const hits: string[] = [];
      for (const [file, out] of Object.entries(bundle)) {
        const text =
          out.type === "chunk"
            ? out.code
            : typeof out.source === "string"
              ? out.source
              : new TextDecoder().decode(out.source);
        for (const { name, value } of forbidden) {
          if (text.includes(value))
            hits.push(`${file} contains the value of ${name} (${redactValue(value)})`);
        }
      }
      if (hits.length > 0) {
        this.error(
          refusalMessage(app, hits, "an emitted file carries an env value the law refuses"),
        );
      }
    },
  };
}

/**
 * Every `NAME: "value"` pair a bundler emitted for a public-prefixed name (the
 * whole-object `import.meta.env` literal, quoted with `"`, `'` or backticks).
 * Object-literal keys only (preceded by `{` or `,`), so a minified ternary
 * `c.VITE_X!==``?c.VITE_X:`…`` is not mistaken for a pair.
 */
export function scanArtifactForPublicEnvPairs(
  text: string,
): { name: string; value: string; offset: number }[] {
  const re =
    /(?<=[{,]\s*)["'`]?((?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_[A-Za-z0-9_]*)["'`]?\s*:\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/gi;
  const out: { name: string; value: string; offset: number }[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ name: m[1] ?? "", value: m[3] ?? "", offset: m.index ?? 0 });
  }
  return out;
}

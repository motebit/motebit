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
 * Consumers, one module:
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
 * The guarantee — the browser never holds a provider key — rests on (1) the
 * server-side passthrough (services/proxy `/v1/solana-rpc` holds the key) and
 * (2) the deny-by-default per-var allowlist + value validators above (the
 * PRIMARY control: the build refuses before emitting anything).
 *
 * SECOND NET (cold review R3): `scanOutputForEnvValues` — after every client
 * build, no value of any env var the build could see (process.env + every
 * `.env*` in its env dirs), minus the exclusion rule `outputScanExclusion`,
 * may appear in ANY emitted file: the full value raw / URL-encoded /
 * JSON-escaped once or twice / base64 (std + url, all alignments); fragments
 * too for secret-named and public-prefixed vars (`fragmentNeedlesApply`).
 * Declared limit: hex, reversed, char-code arrays and split strings are NOT
 * searched for (see "THE LAW's second net" below). Run by the Vite guard's
 * `closeBundle` (web, verify), by scripts/check-client-build-output.ts after
 * `vite build` / `next build` in each surface's package.json build script,
 * and on the Expo public config + native bundles (mobile, EAS
 * `eas-build-on-success`). The static arms are early warnings.
 *
 * Imports node builtins only (vite configs load this file directly).
 *
 * Doctrine: CLAUDE.md "Fail-closed privacy"; docs/doctrine/security-boundaries.md.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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
      /** Exact hostnames only (no wildcard: a subdomain label can carry a key). */
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
/**
 * EXACT hosts per var — never a wildcard (cold review R3: `*.motebit.com`
 * accepted a key smuggled into a subdomain label). These are the origins the
 * operator actually uses (Vercel project env + the code's own defaults).
 */
const PROXY_HOSTS = ["api.motebit.com", ...LOCAL_HOSTS] as const;
const RELAY_HOSTS = ["relay.motebit.com", ...LOCAL_HOSTS] as const;

/** Set by vite itself when a `.env` file carries NODE_ENV; public metadata only. */
const VITE_USER_NODE_ENV: PublicBuildEnvEntry = {
  name: "VITE_USER_NODE_ENV",
  rule: { kind: "enum", values: ["production", "development", "test"] },
  why: "written into process.env by vite's own loadEnv when a .env file sets NODE_ENV; a mode label, never a credential",
};

/**
 * Every public env var a deployed surface may be built with — keyed by the app
 * directory under `apps/` (how each surface's bundler inlines env:
 * `PUBLIC_ENV_SURFACES`). Deny by default: a name not listed for that surface
 * refuses a Vite build (`publicBuildEnvGuard`) and turns
 * `check-no-secrets-in-client-bundles` red (static + dist arms).
 */
export const PUBLIC_BUILD_ENV: Readonly<Record<string, readonly PublicBuildEnvEntry[]>> = {
  web: [
    {
      name: "VITE_PROXY_URL",
      rule: { kind: "url", hosts: PROXY_HOSTS },
      why: "set in Vercel project motebit-web: the motebit relay/proxy base (deprecated alias of VITE_MOTEBIT_RELAY_URL); a public origin",
    },
    {
      name: "VITE_MOTEBIT_RELAY_URL",
      rule: { kind: "url", hosts: PROXY_HOSTS },
      why: "canonical relay/proxy base URL (apps/web/src/providers.ts); a public origin",
    },
    {
      name: "VITE_RELAY_URL",
      rule: { kind: "url", hosts: RELAY_HOSTS },
      why: "relay base URL override (apps/web/src/storage.ts); a public origin",
    },
    {
      name: "VITE_SEARCH_URL",
      rule: { kind: "url", hosts: ["motebit-web-search.fly.dev", ...LOCAL_HOSTS] },
      why: "web-search worker base URL (apps/web/src/web-app.ts); a public origin",
    },
    {
      name: "VITE_BROWSER_SANDBOX_URL",
      rule: { kind: "url", hosts: ["motebit-browser-sandbox.fly.dev", ...LOCAL_HOSTS] },
      why: "set in Vercel project motebit-web: the services/browser-sandbox origin (auth is a per-session relay grant, never a baked key)",
    },
    {
      name: "VITE_SOLANA_RPC_URL",
      rule: { kind: "url", hosts: PROXY_HOSTS },
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
      rule: { kind: "url", hosts: RELAY_HOSTS },
      why: "relay base URL override (apps/verify/src/main.ts); Vercel project receipt-computer sets no VITE_* var",
    },
    {
      name: "VITE_SOLANA_RPC_URL",
      rule: { kind: "url", hosts: PROXY_HOSTS },
      why: "local-dev override of https://api.motebit.com/v1/solana-rpc (apps/verify/src/main.ts); a provider host can never validate",
    },
    VITE_USER_NODE_ENV,
  ],
  mobile: [
    {
      name: "EXPO_PUBLIC_MOTEBIT_RELAY_URL",
      rule: { kind: "url", hosts: PROXY_HOSTS },
      why: "relay base URL fallback (apps/mobile/src/mobile-app.ts, after session state + AsyncStorage); a public origin. eas.json sets no env",
    },
  ],
  // apps/docs (Vercel, Next) reads NO NEXT_PUBLIC_* var today: deny by default.
  docs: [],
};

/**
 * How each deployed surface's bundler inlines public env, and which committed
 * config files can carry it. Every surface here is governed by PUBLIC_BUILD_ENV.
 *   - vite (web, verify): the whole-object `import.meta.env` literal inlines
 *     EVERY resolved var, so the build itself is guarded (`publicBuildEnvGuard`)
 *     and every public prefix is judged in source.
 *   - expo (mobile, EAS) / next (docs, Vercel): no in-bundler hook; the law
 *     (the output scan) runs from the build script / EAS hook. The gate's
 *     static arm is an early warning over their source (incl. .mdx) and the
 *     listed config files (names; eas.json `env` values; credential shapes;
 *     next.config `env` / `publicRuntimeConfig` / `define`, any spelling).
 */
export interface PublicEnvSurface {
  readonly bundler: "vite" | "expo" | "next";
  /** Names this surface's bundler inlines (any case is judged). */
  readonly inlines: RegExp;
  /** App-relative config files the static arm reads (when present). */
  readonly configFiles: readonly string[];
}

export const PUBLIC_ENV_SURFACES: Readonly<Record<string, PublicEnvSurface>> = {
  web: {
    bundler: "vite",
    inlines: /^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/i,
    configFiles: ["vite.config.ts", "vercel.json"],
  },
  verify: {
    bundler: "vite",
    inlines: /^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/i,
    configFiles: ["vite.config.ts", "vercel.json"],
  },
  mobile: {
    bundler: "expo",
    inlines: /^EXPO_PUBLIC_/i,
    configFiles: [
      "app.json",
      "app.config.js",
      "app.config.ts",
      "eas.json",
      "babel.config.js",
      "metro.config.js",
      "package.json",
    ],
  },
  docs: {
    bundler: "next",
    inlines: /^NEXT_PUBLIC_/i,
    configFiles: [
      "next.config.mjs",
      "next.config.js",
      "next.config.ts",
      "source.config.ts",
      "vercel.json",
      "package.json",
    ],
  },
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
  return hosts.some((p) => h === p);
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

/**
 * A Stripe publishable key: `pk_live_` / `pk_test_` + 24 (legacy) up to 247
 * (Stripe's 255-char key ceiling) alphanumerics.
 */
const STRIPE_PUBLISHABLE = /^pk_(?:live|test)_[A-Za-z0-9]{24,247}$/;

/** Why `value` is refused for a named entry, or null when acceptable. */
export function publicValueViolation(value: string, rule: PublicValueRule): string | null {
  if (value === "") return null;
  switch (rule.kind) {
    case "url":
      return publicUrlViolation(value, rule.hosts);
    case "stripe-publishable":
      return STRIPE_PUBLISHABLE.test(value)
        ? null
        : "is not a Stripe publishable key (^pk_(live|test)_[A-Za-z0-9]{24,247}$)";
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
export interface GuardResolvedConfig {
  env: Record<string, unknown>;
  define?: Record<string, unknown>;
  root?: string;
  envDir?: string | false;
  build?: { outDir?: string; write?: boolean };
}

export interface PublicBuildEnvGuardPlugin {
  readonly name: string;
  readonly enforce: "pre";
  config(): void;
  configResolved(config: GuardResolvedConfig): void;
  closeBundle(error?: unknown): void;
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
 *   - `closeBundle` — THE LAW: `scanOutputForEnvValues` over every file written
 *     to outDir (chunks, html, maps, the copied publicDir) against every env
 *     value the build could see (process.env + `.env*` in envDir and root).
 * A sibling config that drops this plugin is caught by the same scan run from
 * the surface's package.json `build` (scripts/check-client-build-output.ts).
 */
export function publicBuildEnvGuard(
  app: string,
  processEnv: Record<string, string | undefined> = process.env,
): PublicBuildEnvGuardPlugin {
  let resolved: { env: Record<string, unknown>; define: Record<string, unknown> } | null = null;
  let out: { root: string; envDirs: string[]; outDir: string | null } | null = null;
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
      const root = resolve(config.root ?? process.cwd());
      const envDir =
        typeof config.envDir === "string"
          ? isAbsolute(config.envDir)
            ? config.envDir
            : resolve(root, config.envDir)
          : root;
      const outDirRaw = config.build?.outDir ?? "dist";
      out = {
        root,
        envDirs: [envDir, root],
        outDir:
          config.build?.write === false
            ? null
            : isAbsolute(outDirRaw)
              ? outDirRaw
              : resolve(root, outDirRaw),
      };
      enforcePublicBuildEnv(app, resolved.env, resolved.define);
    },
    // THE LAW, on what was written: every emitted file in outDir (chunks,
    // assets, copied publicDir, html, source maps) is searched for every env
    // value the build could see. Runs after the bundle is on disk.
    closeBundle(error) {
      if (error != null || out == null || out.outDir == null) return;
      const vars = collectBuildEnv(processEnv, out.envDirs);
      const outDir = out.outDir;
      const r = scanOutputForEnvValues(
        app,
        vars,
        readOutputFiles(listOutputFiles(outDir), (p) => relative(outDir, p)),
      );
      if (r.findings.length > 0) throw new Error(outputScanRefusal(app, r.findings));
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

// ── THE LAW's second net: the ground-truth output scan ─────────────────────
//
// The guarantee is "the browser never holds a provider key". It rests on (1)
// the server-side passthrough (services/proxy /v1/solana-rpc holds the key) and
// (2) the deny-by-default per-var public-env allowlist + value validators
// (`PUBLIC_BUILD_ENV`, `publicBuildEnvGuard`) — the PRIMARY control: an
// unlisted or invalid public var refuses the build before anything is emitted.
//
// This scan is the SECOND NET, judging what actually shipped (three cold-review
// rounds found pre-build checks judging something other than the output).
// After a client build, it searches EVERY emitted file for every env value the
// build could see (process.env + every `.env*` in the env dirs), minus the
// exclusion rule (`outputScanExclusion`). It claims exactly this
// (`valueNeedles`):
//   - every scanned var, its FULL value: raw, URL-encoded (encodeURIComponent),
//     JSON-escaped once and twice, and base64 / base64url of each of those at
//     all three byte alignments;
//   - additionally, for vars whose NAME is secret-shaped (`SECRET_ENV_NAME`) and
//     for any public-prefixed var that is unlisted or fails its validator
//     (`fragmentNeedlesApply`): every key-shaped run of escape-stable chars
//     (>= 16, letters + digits) of the value, in the same encodings.
// Platform metadata (`OUTPUT_SCAN_EXCLUDED_ENV_NAMES`, exact names: commit
// message/author/ref, deployment id, the deployment's own preview hostnames)
// is never scanned.
// Declared limit — NOT caught: hex, reversed, char-code arrays, split or
// concatenated strings, any other encoding. Each needs code that deliberately
// transforms the value; for a public var the per-var allowlist guard already
// refuses it at build time, and a non-public var never reaches client code
// without such a deliberate route. A hit fails the build, naming the var,
// never printing the value.
/** Values shorter than this are never scanned for (collision-prone). */
export const OUTPUT_SCAN_MIN_LENGTH = 16;

/** Segments shorter than this are low-entropy whatever they hold. */
const LOCATOR_SEGMENT_MIN_KEY_LENGTH = 8;

/**
 * A path segment / host label that cannot be a key: shorter than 8 chars, or
 * single-case letter words (`motebit-browser-sandbox`, `Services`, `API`) —
 * mixed-case letter runs (`AbCdEfGhIj`) are key-shaped and do not qualify.
 */
function lowEntropySegment(seg: string): boolean {
  return (
    seg.length < LOCATOR_SEGMENT_MIN_KEY_LENGTH ||
    seg.split(/[-_.]/).every((w) => /^(?:[a-z]+|[A-Z][a-z]*|[A-Z]+)$/.test(w))
  );
}

/**
 * Public CI/build metadata whose values are long all-digit ids. An all-digit
 * value of 16+ digits under any other name is scanned (a PIN, an account
 * number, a numeric token).
 */
export const PUBLIC_NUMERIC_ENV_NAMES: ReadonlySet<string> = new Set([
  "SOURCE_DATE_EPOCH",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_ACTOR_ID",
  "GITHUB_TRIGGERING_ACTOR_ID",
]);

/** Digit runs of this length or more are never a scalar (unless a public numeric name). */
const SCALAR_MAX_DIGITS = 15;

/** `true`/`false`, or a plain decimal number of at most 15 digits (any length under a public numeric name). */
function isScalar(v: string, name?: string): boolean {
  if (/^(?:true|false)$/i.test(v)) return true;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(v)) return false;
  return (
    v.replace(/\D/g, "").length <= SCALAR_MAX_DIGITS ||
    (name != null && PUBLIC_NUMERIC_ENV_NAMES.has(name))
  );
}

/** A base64/base64url/hex run long enough to be key material inside one path segment. */
const PATH_SEGMENT_KEY_RUN = /[A-Za-z0-9+=_-]{16,}/;
/** A whole entry (slashes included) that is 24+ chars of the standard base64 alphabet. */
const PATH_ENTRY_KEY_SHAPED = /^[A-Za-z0-9+/=]{24,}$/;

/**
 * One absolute POSIX path entry with the real shape of a path (deny by
 * default — a `/`-leading base64 key is ~1 in 64 `openssl rand -base64 32`):
 *   (i)  it exists on disk at build time (PWD, HOME, an existing PATH dir), or
 *   (ii) it has ≥ 2 `/`-separated segments, NO segment contains a
 *        base64/base64url/hex run of 16+ chars, AND the whole entry is not
 *        24+ chars of the standard base64 alphabet (`/` included).
 * Existence wins over (ii)'s entropy test: a random key never names an
 * existing path, and real dirs (PWD) do land in output (Next's
 * required-server-files.json embeds the app dir).
 */
function isRealPathEntry(e: string): boolean {
  if (existsSync(e)) return true;
  const segs = e.split("/").filter((s) => s !== "");
  return (
    segs.length >= 2 &&
    segs.every((s) => !PATH_SEGMENT_KEY_RUN.test(s)) &&
    !PATH_ENTRY_KEY_SHAPED.test(e)
  );
}

/** One or more absolute POSIX paths joined by `:` (PATH, HOME, PWD, …), each a real path (`isRealPathEntry`). */
function isAbsolutePathList(v: string): boolean {
  return /^\/[^:\s]*(?::\/[^:\s]*)*$/.test(v) && v.split(":").every(isRealPathEntry);
}

/**
 * A URL (http/https) or bare DNS name that cannot carry a credential: no
 * userinfo, query or fragment, and every host label and path segment is
 * low-entropy (`lowEntropySegment`). A key in a label/segment, a query or
 * userinfo makes it NOT credential-free, so it is scanned for.
 */
function isCredentialFreeLocator(v: string): boolean {
  if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(v)) {
    return v.split(".").every(lowEntropySegment);
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username !== "" || u.password !== "" || v.includes("@")) return false;
  if (u.search !== "" || v.includes("?") || u.hash !== "" || v.includes("#")) return false;
  if (!u.hostname.split(".").every(lowEntropySegment)) return false;
  return u.pathname.split("/").every((seg) => {
    try {
      return lowEntropySegment(decodeURIComponent(seg));
    } catch {
      return false;
    }
  });
}

/**
 * Platform metadata, by EXACT name (never a pattern): free text a deployer
 * does not choose (commit message, author, branch) that legitimately overlaps
 * docs content (a commit message naming `claude-sonnet-4-6` matched 17 docs
 * files), and the deployment id. Vercel injects `VERCEL_GIT_*` and, with
 * "automatically expose System Environment Variables", the `VITE_` /
 * `NEXT_PUBLIC_` copies of them; GitHub Actions injects the ref/actor names.
 * With Skew Protection on, Vercel sets `NEXT_DEPLOYMENT_ID` /
 * `VERCEL_DEPLOYMENT_ID` (`dpl_…`) and Next inlines it into every page and
 * chunk (`?dpl=`) — a routing id, not a credential; with "automatically
 * expose" its `NEXT_PUBLIC_` twin carries the same id. On a preview build Next
 * overrides `metadataBase` with `VERCEL_BRANCH_URL || VERCEL_URL`
 * (next/dist/lib/metadata/resolvers/resolve-url.js) and writes it into every
 * og:image / twitter:image — the deployment's own public hostname, served to
 * every visitor, but its labels (`…-keys-v2-motebit`, `…-k3j9x2abq-…`) fail
 * the low-entropy locator rule, so they are named here (with their
 * `NEXT_PUBLIC_` twins). Never scanned. Every entry is a non-secret-shaped
 * name (`isSecretShapedEnvName` false — asserted); `VERCEL_OIDC_TOKEN` and
 * `VERCEL_AUTOMATION_BYPASS_SECRET` are never listed and are always scanned.
 */
export const OUTPUT_SCAN_EXCLUDED_ENV_NAMES: ReadonlySet<string> = new Set([
  "VERCEL_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_COMMIT_AUTHOR_NAME",
  "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "VERCEL_GIT_COMMIT_REF",
  "VITE_VERCEL_GIT_COMMIT_MESSAGE",
  "VITE_VERCEL_GIT_COMMIT_AUTHOR_NAME",
  "VITE_VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "VITE_VERCEL_GIT_COMMIT_REF",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_NAME",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF",
  "GITHUB_BASE_REF",
  "GITHUB_ACTOR",
  "GITHUB_TRIGGERING_ACTOR",
  "NEXT_DEPLOYMENT_ID",
  "VERCEL_DEPLOYMENT_ID",
  "NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "NEXT_PUBLIC_VERCEL_URL",
  "NEXT_PUBLIC_VERCEL_BRANCH_URL",
]);

/**
 * Whether a scanned var's key-shaped FRAGMENTS are needles too (not only its
 * full value): its name is secret-shaped (`SECRET_ENV_NAME`), or it is
 * public-prefixed — a public var reaching the scan is unlisted or failed its
 * validator (a listed, valid one is excluded by value first). Any other var's
 * value is free text as often as a key (a commit message, a description), and
 * its fragments would collide with ordinary output.
 */
export function fragmentNeedlesApply(name: string): boolean {
  return isSecretShapedEnvName(name) || isPublicEnvName(name);
}

/**
 * The exclusion rule, exactly. A value is NOT scanned for iff ANY of:
 *   (0) its var is named in `OUTPUT_SCAN_EXCLUDED_ENV_NAMES` (exact name);
 *   (a) it is the value of a var named in PUBLIC_BUILD_ENV[app] that passes
 *       that entry's validator (a value-level allowlist: the same value under
 *       another name is excluded too);
 *   (b) it is shorter than OUTPUT_SCAN_MIN_LENGTH (16) characters;
 *   (c) it is `true`/`false` (any case) or a plain decimal number of at most
 *       15 digits (any length only under a `PUBLIC_NUMERIC_ENV_NAMES` name);
 *   (d) it is one or more absolute POSIX paths joined by `:`, EACH existing on
 *       disk at build time or multi-segment with no key-shaped run
 *       (`isRealPathEntry` — deny by default);
 *   (e) it is a credential-free locator: an http(s) URL or bare DNS name with no
 *       userinfo/query/fragment whose every host label and path segment is
 *       shorter than 8 chars or single-case letter words (`isCredentialFreeLocator`).
 * Everything else — every other value of every var — is searched for.
 */
export function outputScanExclusion(
  value: string,
  allowedValues: ReadonlySet<string>,
  name?: string,
): string | null {
  if (name != null && OUTPUT_SCAN_EXCLUDED_ENV_NAMES.has(name)) return "platform metadata";
  if (allowedValues.has(value)) return "public (PUBLIC_BUILD_ENV)";
  if (value.length < OUTPUT_SCAN_MIN_LENGTH) return "short";
  if (isScalar(value, name)) return "scalar";
  if (isAbsolutePathList(value)) return "path";
  if (isCredentialFreeLocator(value)) return "credential-free locator";
  return null;
}

/** The values a surface publishes on purpose: named vars whose value validates. */
export function publicValuesFor(
  app: string,
  vars: readonly { name: string; value: string }[],
): Set<string> {
  const byName = new Map((PUBLIC_BUILD_ENV[app] ?? []).map((e) => [e.name, e]));
  const out = new Set<string>();
  for (const { name, value } of vars) {
    const entry = byName.get(name);
    if (entry != null && value !== "" && publicValueViolation(value, entry.rule) == null) {
      out.add(value);
    }
  }
  return out;
}

function toLatin1(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

/**
 * The needles for one value, as latin1 byte-strings (files are read as latin1
 * so non-UTF-8 output is searched byte-for-byte): raw, encodeURIComponent,
 * JSON-escaped (once and twice), and — only when `fragments` (see
 * `fragmentNeedlesApply`) — every key-shaped escape-stable run ≥ 16 chars;
 * plus base64 / base64url of each at all three byte alignments (only the
 * characters fully determined by the value). Nothing else (declared limit:
 * hex, reversed, char codes, split strings are not searched for).
 */
export function valueNeedles(
  value: string,
  opts: { fragments: boolean } = { fragments: true },
): { encoding: string; needle: string }[] {
  const out = new Map<string, string>();
  const add = (encoding: string, s: string): void => {
    if (s.length >= OUTPUT_SCAN_MIN_LENGTH && !out.has(s)) out.set(s, encoding);
  };
  const forms: [string, string][] = [
    ["raw", value],
    ["url-encoded", encodeURIComponent(value)],
    ["json-escaped", JSON.stringify(value).slice(1, -1)],
    ["json-escaped twice", JSON.stringify(JSON.stringify(value)).slice(3, -3)],
    // For secret-named / public-prefixed vars only: every run of
    // escape-stable characters (≥ 16) is itself a needle — an escaping layer
    // we did not model (a template literal, a third JSON level) leaves it intact.
    ...(opts.fragments
      ? value
          .split(/[^A-Za-z0-9_.~-]+/)
          .filter((p) => p !== value && isKeyShapedFragment(p))
          .map((p): [string, string] => ["fragment", p])
      : []),
  ];
  for (const [encoding, form] of forms) {
    add(encoding, toLatin1(form));
    const bytes = Buffer.from(form, "utf8");
    for (let k = 0; k < 3; k++) {
      const full = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
      const start = Math.ceil((k * 4) / 3);
      const end = Math.floor(((k + bytes.length) * 8) / 6);
      const b64 = full.slice(start, end);
      add(`base64 of ${encoding}`, b64);
      add(`base64url of ${encoding}`, b64.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...out].map(([needle, encoding]) => ({ encoding, needle }));
}

/**
 * A fragment is a needle only when it could be key material on its own: it is
 * not itself excluded by the rule (short / scalar / path / credential-free
 * locator) and mixes letters with digits. Keeps hostname lists (NO_PROXY) and
 * flag words (JAVA_TOOL_OPTIONS) from matching public strings.
 */
function isKeyShapedFragment(p: string): boolean {
  return outputScanExclusion(p, new Set()) == null && /[0-9]/.test(p) && /[A-Za-z]/.test(p);
}

/** Minimal `.env` parser (KEY=VALUE, `export`, quotes, `#` comments). */
export function parseDotenv(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (m == null) continue;
    let v = (m[2] ?? "").trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.lastIndexOf(q) > 0) {
      v = v.slice(1, v.lastIndexOf(q));
      if (q === '"') v = v.replace(/\\n/g, "\n");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out.push({ name: m[1] ?? "", value: v });
  }
  return out;
}

/**
 * Every env var visible to a build: `processEnv` plus every `.env*` file in
 * each of `envDirs` (a superset of what any bundler loads from there — Vite's
 * `.env[.mode][.local]`, Next's `.env*`, Expo's `.env*`).
 */
export function collectBuildEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  envDirs: readonly string[],
): { name: string; value: string; source: string }[] {
  const out: { name: string; value: string; source: string }[] = [];
  for (const [name, value] of Object.entries(processEnv)) {
    if (value != null) out.push({ name, value, source: "process.env" });
  }
  for (const dir of new Set(envDirs.map((d) => resolve(d)))) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names.filter((n) => n.startsWith(".env")).sort()) {
      const full = join(dir, f);
      try {
        if (!statSync(full).isFile()) continue;
        for (const v of parseDotenv(readFileSync(full, "utf8"))) {
          out.push({ ...v, source: f });
        }
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** Every file under `dir` (recursively), skipping directories whose name OR absolute path is in `skip`. */
export function listOutputFiles(dir: string, skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const walkDir = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skip.has(e) && !skip.has(full)) walkDir(full);
      } else if (st.isFile()) out.push(full);
    }
  };
  walkDir(dir);
  return out;
}

export interface OutputScanResult {
  /** `file carries the value of NAME (encoding; source; N chars)` — never the value. */
  readonly findings: string[];
  readonly files: number;
  readonly scannedVars: number;
  readonly excluded: Readonly<Record<string, number>>;
}

/**
 * THE LAW. Searches every file for every non-excluded env value (all
 * encodings). `files` yields `{ label, bytes }` so the same law runs over a
 * Vite bundle in memory, a dist dir on disk, or an Expo public config.
 */
export function scanOutputForEnvValues(
  app: string,
  vars: readonly { name: string; value: string; source?: string }[],
  files: Iterable<{ label: string; text: string }>,
): OutputScanResult {
  const allowed = publicValuesFor(app, vars);
  const excluded: Record<string, number> = {};
  const needles: {
    name: string;
    source: string;
    length: number;
    encoding: string;
    needle: string;
  }[] = [];
  const seenValue = new Set<string>();
  const scannedNames = new Set<string>();
  for (const { name, value, source } of vars) {
    const why = outputScanExclusion(value, allowed, name);
    if (why != null) {
      excluded[why] = (excluded[why] ?? 0) + 1;
      continue;
    }
    scannedNames.add(name);
    const key = `${name}\u0000${value}`;
    if (seenValue.has(key)) continue;
    seenValue.add(key);
    for (const n of valueNeedles(value, { fragments: fragmentNeedlesApply(name) })) {
      needles.push({ name, source: source ?? "env", length: value.length, ...n });
    }
  }
  const findings: string[] = [];
  let count = 0;
  for (const { label, text } of files) {
    count++;
    const reported = new Set<string>();
    for (const n of needles) {
      if (reported.has(n.name) || !text.includes(n.needle)) continue;
      reported.add(n.name);
      findings.push(
        `${label} carries the value of ${n.name} (${n.encoding}; from ${n.source}; value redacted, ${n.length} chars)`,
      );
    }
  }
  return { findings, files: count, scannedVars: scannedNames.size, excluded };
}

/** Reads each path as latin1 (byte-exact) for `scanOutputForEnvValues`. */
export function* readOutputFiles(
  paths: readonly string[],
  labelOf: (p: string) => string = (p) => p,
): Generator<{ label: string; text: string }> {
  for (const p of paths) {
    let text: string;
    try {
      text = readFileSync(p, "latin1");
    } catch {
      continue;
    }
    yield { label: labelOf(p), text };
  }
}

/**
 * The refusal message for an output-scan failure. Its repair hint never tells
 * you to allowlist a non-public var: only a public-prefixed var can ever be
 * added to PUBLIC_BUILD_ENV, and a secret is never renamed into one.
 */
export function outputScanRefusal(app: string, findings: readonly string[]): string {
  return (
    `[apps/${app}] refusing to build: an emitted file carries the value of a build env var ` +
    "(ground-truth output scan — the second net).\n" +
    findings.map((p) => `  - ${p}`).join("\n") +
    "\n  Fix: find the route that inlined the value (a vite `define`, next.config `env` / " +
    "`compiler.define`, Expo `extra`, a `process.env.X` read in client code) and remove it; a " +
    "server credential belongs behind a server route (browser Solana RPC: " +
    "https://api.motebit.com/v1/solana-rpc, key held as SOLANA_RPC_UPSTREAM_URL in services/proxy). " +
    "Or unset the var from this build's environment (Vercel project env / .env* in the app dir). " +
    "Never rename a non-public var to a VITE_ / NEXT_PUBLIC_ / EXPO_PUBLIC_ name to pass. Only a " +
    `var that ALREADY carries a public prefix and is genuinely public may be added to PUBLIC_BUILD_ENV.${app} ` +
    "(with a value validator and a why). Law: scripts/lib/client-bundle-secrets.ts."
  );
}

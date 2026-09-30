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
 * Three consumers, one module (zero imports so vite configs can load it):
 *   - `assertPublicBuildEnv` — called by apps/web + apps/verify `vite.config.ts`;
 *     the build FAILS when a resolved public env value is credential-shaped, and
 *     `VITE_SOLANA_RPC_URL` may carry no query string or userinfo at all.
 *   - `scanSourceForPublicEnvNames` + `PUBLIC_ENV_ALLOWLIST` — the static half
 *     of `scripts/check-no-secrets-in-client-bundles.ts`.
 *   - `scanArtifactText` + `CREDENTIAL_RULES` — the built-artifact half.
 *
 * Doctrine: CLAUDE.md "Fail-closed privacy"; docs/doctrine/security-boundaries.md.
 */

/** Env prefixes a bundler inlines into client code. */
export const PUBLIC_ENV_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"] as const;

/** A public env NAME that smells like a credential or a credential-bearing URL. */
export const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PRIVATE|RPC_URL|API/;

const PUBLIC_ENV_TOKEN = /\b(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_[A-Z0-9_]+\b/g;

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
 * Every public env name matching `SECRET_ENV_NAME` that may appear in app
 * source, with its justification. Deny by default: a name not listed here, or
 * listed for a different file, is RED.
 */
export const PUBLIC_ENV_ALLOWLIST: readonly PublicEnvAllowEntry[] = [
  {
    file: "apps/web/src/web-app.ts",
    name: "VITE_SOLANA_RPC_URL",
    why: "local-dev override of the server-side passthrough (api.motebit.com/v1/solana-rpc); apps/web/vite.config.ts refuses any value with a query string, userinfo or key-shaped token (assertPublicBuildEnv)",
  },
  {
    file: "apps/verify/src/main.ts",
    name: "VITE_SOLANA_RPC_URL",
    why: "same law as apps/web: local-dev override only, guarded by assertPublicBuildEnv in apps/verify/vite.config.ts",
  },
  {
    file: "apps/verify/src/vite-env.d.ts",
    name: "VITE_SOLANA_RPC_URL",
    why: "type declaration only (no value)",
  },
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
  const bare = name.replace(/^(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_/, "");
  return SECRET_ENV_NAME.test(bare);
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

/**
 * Why a browser Solana RPC URL is refused, or null when it is acceptable. The
 * value is public by construction, so it may carry NO query string, NO
 * userinfo, and no key-shaped path/query fragment.
 */
export function publicRpcUrlViolation(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (/api-?key|apikey|token=|key=/i.test(v)) return "contains a key/token parameter";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "is not a parseable URL";
  }
  if (u.username !== "" || u.password !== "") return "carries basic-auth userinfo";
  if (u.search !== "" || v.includes("?")) return "carries a query string";
  if (u.protocol !== "https:" && u.protocol !== "http:") return "is not http(s)";
  return null;
}

/**
 * Build-time guard for a Vite browser surface. Throws — failing the build — when
 * a resolved public env value would inline a credential. `env` is vite's
 * `loadEnv(mode, cwd, "VITE_")` (includes process.env VITE_* vars).
 *
 * Vite replaces whole-object `import.meta.env` access (the `env?.VITE_X` shape
 * apps/web uses) with a literal of EVERY `VITE_*` var in the build environment,
 * so a var ships whether or not the source names it. Hence two refusals: any
 * credential-shaped VALUE, and any credential-shaped NAME not in `allowedNames`
 * (a stale `VITE_*_TOKEN` in a Vercel project is published even if unused).
 */
export function assertPublicBuildEnv(
  env: Record<string, string | undefined>,
  surface: string,
  allowedNames: readonly string[] = ["VITE_SOLANA_RPC_URL"],
): void {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value == null || value === "") continue;
    if (isSecretShapedEnvName(name) && !allowedNames.includes(name)) {
      problems.push(
        `${name} has a credential-shaped name and would be inlined into every chunk (value ${redactValue(value)})`,
      );
      continue;
    }
    if (name === "VITE_SOLANA_RPC_URL") {
      const why = publicRpcUrlViolation(value);
      if (why) problems.push(`${name} ${why} (value ${redactValue(value)})`);
      continue;
    }
    for (const f of scanArtifactText(value)) {
      problems.push(`${name} matches credential shape ${f.rule} (value ${f.redacted})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[${surface}] refusing to build: a public env value would ship a credential in client JS.\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n  Fix: unset it from the build environment (Vercel project env / .env*). Browser Solana RPC goes through " +
        "https://api.motebit.com/v1/solana-rpc (services/proxy), which holds the provider key as the server secret " +
        "SOLANA_RPC_UPSTREAM_URL. Law: scripts/lib/client-bundle-secrets.ts.",
    );
  }
}

/**
 * Env policy for cached test tasks — the one table the runtime input tracer
 * (input-tracer.ts) and the static gate (scripts/check-turbo-test-inputs.ts)
 * both read.
 *
 * Turbo runs test tasks in STRICT env mode: an undeclared var is stripped, so a
 * test can only ever see (a) the vars declared in the task's `env` / `globalEnv`
 * — hashed — and (b) the vars turbo passes through UNHASHED. Which vars (b)
 * contains is not something this file asserts: the static gate derives it
 * empirically from the installed turbo binary on every run and requires every
 * observed pass-through var to be classified here.
 *
 *   hash     the var changes outcomes WITHOUT a JS read (the runtime, the
 *            dynamic loader or ICU consumes it), so the tracer cannot see it:
 *            it must be in `env` of both test tasks.
 *   benign   a JS read of it is allowed, with the reason it cannot change an
 *            outcome that the hash does not already carry.
 *   guarded  it passes through unhashed and nothing consumes it except a JS
 *            read — which the tracer fails. Classifying a var `guarded` is the
 *            reviewed claim "no runtime/loader consumes this".
 */

export type EnvClass = "hash" | "benign" | "guarded";

export interface EnvRule {
  /** Exact name, or a prefix ending in `*`. */
  pattern: string;
  class: EnvClass;
  reason: string;
}

/**
 * Hashed on both test tasks, required by the gate. MOTEBIT_TEST_RUNTIME is
 * not a pass-through var: scripts/turbo-run.mjs sets it (C1).
 */
export const REQUIRED_TEST_ENV = [
  "CI",
  "TZ",
  "LANG",
  "NODE_OPTIONS",
  "LD_LIBRARY_PATH",
  "GITHUB_PAT",
  "MOTEBIT_TEST_RUNTIME",
] as const;

export const ENV_POLICY: EnvRule[] = [
  // ── hash: consumed without a JS read ────────────────────────────────────
  {
    pattern: "CI",
    class: "hash",
    reason: "vitest snapshot mode (CI never writes a missing snapshot)",
  },
  { pattern: "TZ", class: "hash", reason: "every local-time Date conversion" },
  { pattern: "LANG", class: "hash", reason: "ICU default locale for Intl / toLocaleString" },
  {
    pattern: "NODE_OPTIONS",
    class: "hash",
    reason: "Node consumes it at startup (--conditions, --require, --disable-proto, …)",
  },
  {
    pattern: "LD_LIBRARY_PATH",
    class: "hash",
    reason: "the dynamic loader resolves native addons (better-sqlite3, sharp) through it",
  },
  {
    pattern: "GITHUB_PAT",
    class: "hash",
    reason:
      "mcp-client's github-integration test runs only when it is set — its presence changes the outcome",
  },
  // ── benign: a read cannot change an outcome the hash does not carry ─────
  {
    pattern: "PATH",
    class: "benign",
    reason: "process lookup; tool versions are pinned by the lockfile",
  },
  {
    pattern: "HOME",
    class: "benign",
    reason: "a LOCATION; the tracer fails any read of content under it outside tmp",
  },
  {
    pattern: "USERPROFILE",
    class: "benign",
    reason: "Windows HOME — a location; the tracer fails any read of content under it",
  },
  { pattern: "TMP", class: "benign", reason: "temp-dir location only" },
  { pattern: "TEMP", class: "benign", reason: "temp-dir location only" },
  { pattern: "TMPDIR", class: "benign", reason: "temp-dir location only" },
  { pattern: "PWD", class: "benign", reason: "equals the package dir under turbo" },
  { pattern: "INIT_CWD", class: "benign", reason: "pnpm plumbing: the package dir" },
  { pattern: "SHELL", class: "benign", reason: "process plumbing" },
  { pattern: "USER", class: "benign", reason: "identity of the runner, never content" },
  { pattern: "TERM", class: "benign", reason: "output formatting only" },
  { pattern: "TERM_PROGRAM", class: "benign", reason: "output formatting only" },
  { pattern: "COLORTERM", class: "benign", reason: "output formatting only" },
  { pattern: "FORCE_COLOR", class: "benign", reason: "output formatting only" },
  { pattern: "NO_COLOR", class: "benign", reason: "output formatting only" },
  {
    pattern: "NODE",
    class: "benign",
    reason: "pnpm sets it to the running node (runtime is hashed)",
  },
  {
    pattern: "PNPM_SCRIPT_SRC_DIR",
    class: "benign",
    reason: "pnpm sets it to the package dir",
  },
  { pattern: "TURBO_HASH", class: "benign", reason: "the task hash itself" },
  {
    pattern: "TURBO_INVOCATION_DIR",
    class: "benign",
    reason: "where turbo was invoked — a location, not content",
  },
  {
    pattern: "npm_package_*",
    class: "benign",
    reason: "pnpm derives them from the package's own package.json (hashed)",
  },
  { pattern: "npm_lifecycle_*", class: "benign", reason: "the script name/body from package.json" },
  { pattern: "npm_command", class: "benign", reason: "pnpm plumbing (`run-script`)" },
  { pattern: "npm_execpath", class: "benign", reason: "pnpm plumbing" },
  { pattern: "npm_node_execpath", class: "benign", reason: "the running node (runtime is hashed)" },
  {
    pattern: "VITEST*",
    class: "benign",
    reason: "set by vitest itself from its (hashed) config",
  },
  { pattern: "TEST", class: "benign", reason: "set by vitest itself" },
  // vite's `import.meta.env` mirror, set in the worker from the (hashed) config.
  { pattern: "MODE", class: "benign", reason: "set by vitest from its config" },
  { pattern: "PROD", class: "benign", reason: "set by vitest from its config" },
  { pattern: "DEV", class: "benign", reason: "set by vitest from its config" },
  { pattern: "SSR", class: "benign", reason: "set by vitest from its config" },
  { pattern: "BASE_URL", class: "benign", reason: "set by vitest from its config" },
  { pattern: "FORCE_TTY", class: "benign", reason: "set by vitest for its own reporter" },
  { pattern: "NODE_ENV", class: "benign", reason: "stripped by turbo; vitest sets it to `test`" },
  {
    pattern: "MOTEBIT_TEST_RUNTIME",
    class: "benign",
    reason: "hashed, and asserted equal to the running runtime at setup",
  },
  // ── guarded: only observable through a JS read, which the tracer fails ──
  { pattern: "GITHUB_*", class: "guarded", reason: "CI metadata; nothing consumes it natively" },
  { pattern: "RUNNER_*", class: "guarded", reason: "CI metadata; nothing consumes it natively" },
  { pattern: "VERCEL*", class: "guarded", reason: "deploy metadata" },
  {
    pattern: "TURBO_*",
    class: "guarded",
    reason: "turbo's own config vars; consumed by turbo, not the test",
  },
  {
    pattern: "XDG_*",
    class: "guarded",
    reason: "desktop-session locations; nothing in Node consumes them",
  },
  { pattern: "DISPLAY", class: "guarded", reason: "X11; no test here opens a display" },
  { pattern: "XAUTHORITY", class: "guarded", reason: "X11" },
  { pattern: "DBUS_SESSION_BUS_ADDRESS", class: "guarded", reason: "desktop session bus" },
  {
    pattern: "COREPACK_*",
    class: "guarded",
    reason: "consumed by corepack before the task, not by it",
  },
  {
    pattern: "npm_config_*",
    class: "guarded",
    reason: "pnpm/npm config; a read would bake in user config",
  },
  {
    pattern: "ELECTRON_RUN_AS_NODE",
    class: "guarded",
    reason: "only consumed by an electron binary",
  },
  { pattern: "JB_*", class: "guarded", reason: "JetBrains IDE runner metadata" },
  { pattern: "JETBRAINS_*", class: "guarded", reason: "JetBrains IDE runner metadata" },
  { pattern: "NIX_*", class: "guarded", reason: "nix build metadata" },
  { pattern: "NIXOS_*", class: "guarded", reason: "nix build metadata" },
  { pattern: "DOCKER_*", class: "guarded", reason: "docker client config" },
  { pattern: "BUILDKIT_*", class: "guarded", reason: "docker build metadata" },
  { pattern: "COMPOSE_*", class: "guarded", reason: "docker compose config" },
  { pattern: "CARGO_*", class: "guarded", reason: "rust build config" },
  {
    pattern: "AR*",
    class: "guarded",
    reason:
      "C toolchain vars (AR, ARFLAGS, …) — consumed by node-gyp at INSTALL, never at test time",
  },
  { pattern: "CC*", class: "guarded", reason: "C toolchain (install-time only)" },
  { pattern: "CFLAGS*", class: "guarded", reason: "C toolchain (install-time only)" },
  { pattern: "CXX*", class: "guarded", reason: "C++ toolchain (install-time only)" },
  { pattern: "HOST_*", class: "guarded", reason: "cross-compile toolchain (install-time only)" },
  { pattern: "TARGET_*", class: "guarded", reason: "cross-compile toolchain (install-time only)" },
  { pattern: "RANLIB*", class: "guarded", reason: "C toolchain (install-time only)" },
  { pattern: "NVCC*", class: "guarded", reason: "CUDA toolchain (install-time only)" },
  { pattern: "NOW_BUILDER*", class: "guarded", reason: "vercel build metadata" },
  {
    pattern: "USE_OUTPUT_FOR_EDGE_FUNCTIONS",
    class: "guarded",
    reason: "vercel build metadata",
  },
  { pattern: "NEXT_*", class: "guarded", reason: "framework public-env prefix; read only by code" },
  { pattern: "EXPO_PUBLIC_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "GATSBY_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "NITRO_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "NUXT_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "PUBLIC_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "REACT_APP_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "REDWOOD_ENV_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "SANITY_STUDIO_*", class: "guarded", reason: "framework public-env prefix" },
  { pattern: "SERVER_*", class: "guarded", reason: "framework public-env prefix" },
  {
    pattern: "VITE_*",
    class: "guarded",
    reason: "framework public-env prefix (vite reads it at build)",
  },
  { pattern: "VUE_APP_*", class: "guarded", reason: "framework public-env prefix" },
  {
    pattern: "OTEL_*",
    class: "guarded",
    reason: "telemetry config; no test here loads an OTel SDK",
  },
  {
    pattern: "COREPACK_ENABLE_AUTO_PIN",
    class: "guarded",
    reason: "consumed by corepack before the task",
  },
  // Windows process plumbing: consumed by the OS/CRT for process creation.
  { pattern: "SYSTEMROOT", class: "guarded", reason: "Windows plumbing" },
  { pattern: "WINDIR", class: "guarded", reason: "Windows plumbing" },
  { pattern: "COMSPEC", class: "guarded", reason: "Windows plumbing" },
  { pattern: "PATHEXT", class: "guarded", reason: "Windows plumbing" },
  { pattern: "APPDATA", class: "guarded", reason: "Windows per-user location" },
  { pattern: "LOCALAPPDATA", class: "guarded", reason: "Windows per-user location" },
  { pattern: "PROGRAMDATA", class: "guarded", reason: "Windows location" },
  { pattern: "PROGRAMFILES*", class: "guarded", reason: "Windows location" },
  { pattern: "HOMEDRIVE", class: "guarded", reason: "Windows per-user location" },
  { pattern: "HOMEPATH", class: "guarded", reason: "Windows per-user location" },
  { pattern: "SYSTEMDRIVE", class: "guarded", reason: "Windows location" },
  {
    pattern: "LIBPATH",
    class: "guarded",
    reason:
      "the AIX loader path — no machine that runs these tests (Linux/macOS/Windows) consumes it",
  },
  { pattern: "VC_*", class: "guarded", reason: "vercel build metadata" },
  { pattern: "VSCODE_*", class: "guarded", reason: "editor session metadata" },
];

/** Does `pattern` (exact, or a `*`-suffixed prefix) match `name`? */
export function envPatternMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** The most specific rule for `name` (longest pattern wins), or null. */
export function classifyEnv(name: string, rules: EnvRule[] = ENV_POLICY): EnvRule | null {
  let best: EnvRule | null = null;
  for (const r of rules) {
    if (!envPatternMatches(r.pattern, name)) continue;
    if (!best || r.pattern.replace("*", "").length > best.pattern.replace("*", "").length) best = r;
  }
  return best;
}

/** The runtime identity a cached test result is valid for (C1). */
export function runtimeId(): string {
  return `node-${process.version}-${process.platform}-${process.arch}`;
}

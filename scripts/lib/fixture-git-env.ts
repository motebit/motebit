/**
 * The environment for any process that runs git (or a tool that runs git:
 * pnpm, turbo, a build script) against a repository a script CREATED — a temp
 * dir, a fixture, a copied tree — rather than the real repository.
 *
 * Why: a git hook exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (from a
 * linked worktree, a GIT_DIR that points into the SHARED repository) to every
 * process it spawns. Any child that inherits them acts on THAT repository,
 * whatever its `cwd`: on 2026-10-01 (and in #835) a fixture's `git init` wrote
 * `core.worktree=<fixture>` into the real `.git/config` and a fixture `git
 * commit` landed on a real branch. GIT_CONFIG_* (`-c` as environment) and
 * credential variables are dropped too: a fixture needs neither, and neither
 * should reach a repository a test made.
 *
 * Every fixture spawn under `scripts/` routes through this one function;
 * `scripts/check-fixture-git-env.ts` fails on a new git spawn aimed away from
 * the repo root that does not. Shell twin: `scripts/lib/fixture-git-env.sh`.
 * Spawns that INTENTIONALLY target the real repository (cwd = repo root) keep
 * the caller's environment and do not use this.
 */

/**
 * Non-`GIT_*` variables that carry git/forge credentials or a credential
 * prompt. Every `GIT_*` (GIT_ASKPASS, GIT_SSH_COMMAND, GIT_CONFIG_* …) is
 * dropped by prefix.
 */
export const FIXTURE_DROPPED_CREDENTIAL_VARS: readonly string[] = [
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/** True for a variable `fixtureGitEnv` removes. */
export function isFixtureDroppedVar(name: string): boolean {
  return name.startsWith("GIT_") || FIXTURE_DROPPED_CREDENTIAL_VARS.includes(name);
}

/**
 * `base` (default `process.env`) with every `GIT_*` and credential variable
 * removed, then `extra` applied — `extra` is the caller's explicit choice
 * (e.g. GIT_CEILING_DIRECTORIES fencing discovery at a fixture's temp dir).
 */
export function fixtureGitEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!isFixtureDroppedVar(k)) env[k] = v;
  return { ...env, ...extra };
}

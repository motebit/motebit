/**
 * The environment an approved skill script runs with.
 *
 * Approval authorizes the DISPLAYED action — this script, these args. It
 * does not authorize disclosure of every credential the operator's shell
 * happens to carry (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, relay tokens,
 * wallet RPC URLs, passphrases). Inheriting `process.env` wholesale made
 * every approved script a credential reader by default. This is the
 * allowlist: enough to run an interpreter and print in colour, nothing that
 * names a secret. Secret access for skills is a future explicit manifest
 * capability, granted per name and recorded in the approval receipt — never
 * ambient.
 */

const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "LANG",
  "LANGUAGE",
  // Windows needs these to locate the interpreter + temp dir at all.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

/** `LC_ALL`, `LC_CTYPE`, … — locale only, never a secret. */
const SAFE_ENV_PREFIXES = ["LC_"];

/** Build the scrubbed environment for a skill script from the parent env. */
export function skillScriptEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value == null) continue;
    const upper = key.toUpperCase();
    if (SAFE_ENV_KEYS.has(upper) || SAFE_ENV_PREFIXES.some((p) => upper.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}

/** Human line for the approval prompt — says what the script will and won't see. */
export const SKILL_ENV_DISCLOSURE =
  "scrubbed — PATH, HOME, locale and terminal vars only; no API keys, tokens or motebit config";

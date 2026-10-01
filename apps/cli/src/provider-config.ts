/**
 * Apply the persisted `default_provider` / `default_model` to a parsed
 * `CliConfig` — the ONE place both the interactive CLI (`index.ts`) and the
 * daemon (`daemon.ts`) do it (#654 cold review).
 *
 * The two entry points used to carry their own copies. The interactive copy
 * re-derived the model on a provider flip; the daemon's did not, so a daemon
 * launched with `default_provider: proxy` kept the parse-time Anthropic BYOK
 * default (DEFAULT_ANTHROPIC_MODEL) and Motebit Cloud refused every turn (451).
 * Sibling-boundary rule: one function, so a fix to one is a fix to both.
 *
 *   - An implicit model FOLLOWS the provider (2026-07-31 live find): the
 *     parse-time default was derived from the parse-time provider, so a
 *     persisted provider flip left the OLD provider's default on
 *     `config.model`. An explicit `--model` is the user's word and stays.
 *   - Config residue yields politely: a `default_model` from another
 *     provider era must not ride along onto a different provider (pre-flight
 *     admission per intelligence-pluggability-contract). The yield target is
 *     DERIVED, never trusted, so the fallback is admissible by construction.
 */
import type { CliConfig } from "./args.js";
import { defaultModelForProvider } from "./args.js";
import { admitModelForProvider } from "./model-admission.js";

/**
 * Was `--flag` given on the command line, in either spelling `parseArgs`
 * accepts (`--model x` or `--model=x`)? A bare `includes("--model")` missed
 * the `=` form, so `--provider=proxy` lost to a persisted provider.
 */
export function argvHasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/** Providers a persisted `default_provider` may switch the CLI to. */
const CONFIG_PROVIDERS = ["anthropic", "openai", "google", "local-server", "proxy"] as const;

export interface PersistedProviderChoice {
  readonly default_provider?: string | null;
  readonly default_model?: string | null;
}

/**
 * Mutates `config` in place. `argv` decides whether `--provider` / `--model`
 * were explicit; `notice` receives the one-line "config default_model yielded"
 * message (the CLI dims it; the daemon logs it).
 */
export function applyConfiguredProvider(
  config: CliConfig,
  persisted: PersistedProviderChoice,
  argv: readonly string[],
  notice: (line: string) => void = () => {},
): void {
  const provider = persisted.default_provider;
  if (provider != null && provider !== "" && !argvHasFlag(argv, "--provider")) {
    if ((CONFIG_PROVIDERS as readonly string[]).includes(provider)) {
      config.provider = provider as CliConfig["provider"];
      if (!config.modelExplicit) {
        config.model = defaultModelForProvider(config.provider);
      }
    }
  }
  const model = persisted.default_model;
  if (model != null && model !== "" && !argvHasFlag(argv, "--model")) {
    // The CLI-strict check also refuses a hosted-vendor id on local-server
    // (#471); on proxy it is Motebit Cloud's own admission (#654 R2), so a
    // stored id the proxy serves — alias or not — is never rewritten.
    if (admitModelForProvider(config.provider, model).admissible) {
      config.model = model;
    } else {
      config.model = defaultModelForProvider(config.provider);
      notice(
        config.provider === "proxy"
          ? `[config default_model "${model}" is not served by Motebit Cloud; using ${config.model}]`
          : `[config default_model "${model}" belongs to another provider; using ${config.model} for ${config.provider}]`,
      );
    }
  }
}

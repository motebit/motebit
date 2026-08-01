/**
 * CLI-side pre-flight admission for a provider+model pair (#471).
 *
 * `@motebit/sdk`'s `providerAcceptsModel` is deliberately permissive for
 * local-server — "hosts whatever the user's server hosts" is correct at the
 * protocol layer. But the CLI affordance KNOWS that a `claude-*` / `gpt-*` /
 * `gemini-*` id names a hosted vendor's model: selecting one against a local
 * server is the witnessed 404 footgun (both live directions on the issue).
 * The affordance refuses the known mismatch and teaches the pair repair
 * (gate-repair-instructions applied to the product); unknown ids stay
 * admissible — registry lag must never brick a switch.
 */

import { DEFAULT_LOCAL_SERVER_MODEL, modelVendorHint, providerAcceptsModel } from "@motebit/sdk";

/** Vendors whose models are served by a hosted API, never a local server. */
const HOSTED_VENDORS = new Set(["anthropic", "openai", "google", "deepseek"]);

/** Vendor hint → the CLI `--provider` flag that serves it, when one exists. */
const VENDOR_PROVIDER_FLAG: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
};

export interface ModelAdmission {
  admissible: boolean;
  /** One-line repair when refused: what to run instead, never just "no". */
  teach?: string;
}

export function admitModelForProvider(provider: string, model: string): ModelAdmission {
  const hint = modelVendorHint(model);

  if ((provider === "local-server" || provider === "ollama") && HOSTED_VENDORS.has(hint)) {
    const flag = VENDOR_PROVIDER_FLAG[hint];
    return {
      admissible: false,
      teach:
        `${model} is a hosted ${hint} model — a local server can't serve it. ` +
        (flag != null
          ? `Restart with --provider ${flag}, or pick a local model (e.g. /model ${DEFAULT_LOCAL_SERVER_MODEL}).`
          : `Pick a local model instead (e.g. /model ${DEFAULT_LOCAL_SERVER_MODEL}).`),
    };
  }

  if (!providerAcceptsModel(provider, model)) {
    const flag = VENDOR_PROVIDER_FLAG[hint];
    return {
      admissible: false,
      teach:
        `${model} belongs to ${hint === "unknown" ? "another provider" : hint} — the active provider is ${provider}. ` +
        (flag != null
          ? `Restart with --provider ${flag} to use it.`
          : `Pick a ${provider} model instead.`),
    };
  }

  return { admissible: true };
}

/**
 * The one calm line rendered when capability tiering withholds money
 * tools from the selected model (#501). Shared by launch (index.ts) and
 * the /model switch so the wording can never drift between the two.
 */
export const MONEY_TOOLS_WITHHELD_NOTICE =
  "money tools withheld from this model (minimal tier) — set offer_money_tools_to_minimal_models in ~/.motebit/config.json if you mean it";

/**
 * Live-catalog membership with ollama tag normalization (#513-class,
 * witnessed 2026-08-01 on the 1.12.0 live pass): ollama's /api/tags
 * returns TAGGED ids (`llama3.2:latest`) but resolves bare family names
 * to `:latest` server-side — so `/model llama3.2` (and even the shipped
 * default `qwen3`) was refused as "not served" while the server happily
 * served it. Membership must accept exactly what the server accepts:
 * the id verbatim, or its `:latest` form.
 */
export function liveCatalogServes(liveIds: ReadonlySet<string>, modelId: string): boolean {
  return liveIds.has(modelId) || liveIds.has(`${modelId}:latest`);
}

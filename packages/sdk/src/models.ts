// === AI Model Constants ===
//
// Single source of truth for model identifiers across all surfaces.
// SDK is Layer 0 (Apache-2.0 permissive floor, no deps beyond protocol) — only string constants here.
// Pricing, routing, and alias resolution live in their respective packages.
//
// 3 tiers per provider: strongest, default, fast.
// When a new model ships, update the arrays — every surface picks it up.

/** Anthropic Claude models: opus (strongest), sonnet (default), haiku (fast).
 * Every id verified against the live GET /v1/models catalog (2026-07-30);
 * `check-model-catalog-drift` (scheduled, weekly) goes red when this
 * snapshot drifts from what the provider serves. Never construct an id. */
export const ANTHROPIC_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
] as const;

/** OpenAI models: gpt-5.4 (strongest), gpt-5.4-mini (default), gpt-5.4-nano (fast). */
export const OPENAI_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"] as const;

/** Google models: 2.5 pro (strongest), 2.5 flash (default), 2.5 flash-lite (fast). */
export const GOOGLE_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

/**
 * DeepSeek models served via DeepSeek's OpenAI-compatible hosted API
 * (`https://api.deepseek.com`). The API-facing identifier `deepseek-chat`
 * routes to DeepSeek V3 — the workhorse, tool-use-capable model at
 * roughly Claude-Sonnet-class capability and ~10× cheaper pricing
 * ($0.27/M input · $1.10/M output). DeepSeek-R1 (`deepseek-reasoner`)
 * is reasoning-class but tool-use support is uncertain at the Jan 2026
 * cutoff; deferred to a sibling slice once verified.
 *
 * Single-entry registry today; expandable. The list shape stays
 * symmetric with the other per-vendor `*_MODELS` constants so the
 * settings UIs across surfaces consume them identically.
 */
export const DEEPSEEK_MODELS = ["deepseek-chat"] as const;

/**
 * Groq-hosted models served via Groq's OpenAI-compatible API
 * (`https://api.groq.com/openai/v1`). Groq's pitch is speed + price —
 * the LPU inference hardware delivers ~280 tokens/second on Llama 3.3
 * 70B (roughly 5× faster than typical GPU-served Llama) at $0.59/M
 * input · $0.79/M output (~5× cheaper than Claude Sonnet, ~5× more
 * expensive than DeepSeek). Independent American option in the BYOK
 * registry — post-NVIDIA-licensing-deal (December 2025) Groq remains
 * an independent company under CEO Simon Edwards; the API service
 * continues. Default `llama-3.3-70b-versatile` is the tool-use-
 * capable workhorse; `openai/gpt-oss-120b` is OpenAI's open-weights
 * release (only hosted competitively via Groq, MoE architecture
 * comparable to GPT-4 class on tool benchmarks).
 *
 * The list shape stays symmetric with the other per-vendor
 * `*_MODELS` constants so the settings UIs across surfaces consume
 * them identically.
 */
/**
 * How far each provider has actually been PROVEN, as opposed to wired.
 *
 * Two wire adapters cover the whole matrix — `AnthropicProvider` (native) and
 * `OpenAIProvider` (the compat shape that google / groq / deepseek /
 * local-server all ride via `base_url`). Both ADAPTERS are live-proven. Per
 * VENDOR the picture is different, and the surfaces were implying a parity that
 * does not exist (#518):
 *
 *   - `anthropic` — live-proven across every real session, and its model ids are
 *     re-checked weekly against the vendor's own listing endpoint by
 *     `check-model-catalog-drift`.
 *   - `local-server` — live-proven (chat, streaming, tool use).
 *   - everything else — resolver, defaults, admission and footer all exist, but
 *     NO LIVE TURN HAS EVER RUN. Their model ids came from training-prior
 *     knowledge and are not covered by the drift gate. That is the exact class
 *     that already bit the Anthropic table (#474: ids that 404 at runtime), plus
 *     the vendor request-shape quirks the shared compat adapter papers over
 *     (#476: Google's OpenAI-compat gaps, DeepSeek reasoner param rejections).
 *
 * This is the honest half of #518 — the half that needs no API keys. The other
 * half is the probe itself: a streamed turn plus one tool call per vendor, which
 * is what would move a row from `available` to `verified`.
 *
 * `available` is not a warning. Every one of these is wired, resolvable, and
 * expected to work. It states what has been WITNESSED, which is a different
 * claim from what is supported — and conflating the two is how a catalog of
 * fabricated ids ships.
 */
export type ProviderVerification =
  /** A real turn has run through this vendor and is expected to keep working. */
  | "verified"
  /** Wired and resolvable; no live turn has been witnessed yet. */
  | "available";

/** Vendors the verification record covers — the BYOK/cloud selectable set. */
export type VerifiableProvider =
  "anthropic" | "openai" | "google" | "groq" | "deepseek" | "local-server";

export const PROVIDER_VERIFICATION: Readonly<Record<VerifiableProvider, ProviderVerification>> = {
  anthropic: "verified",
  "local-server": "verified",
  openai: "verified",
  google: "available",
  groq: "available",
  deepseek: "available",
} as const;

/**
 * One-line disambiguation shown wherever a vendor is offered.
 *
 * `groq` carries an explicit "not Grok" because the names differ by one letter
 * and denote unrelated things: Groq is inference HARDWARE (LPU) hosting other
 * labs' open weights; Grok is xAI's frontier model, which motebit does not
 * support. A picker that says only "Groq" will be misread, permanently.
 */
export const PROVIDER_NOTE: Readonly<Record<VerifiableProvider, string>> = {
  anthropic: "Claude — verified live.",
  "local-server": "Your own machine (Ollama, LM Studio, llama.cpp) — verified live.",
  openai: "GPT — verified live.",
  google: "Gemini via OpenAI-compat — wired, no live turn witnessed yet.",
  groq: "Fast hosting for open models (Llama, gpt-oss). Not xAI's Grok. Wired, no live turn witnessed yet.",
  deepseek: "Open-weight, low cost — wired, no live turn witnessed yet.",
} as const;

export const GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] as const;

/**
 * Common open-weights models that any local inference server can run.
 *
 * These identifiers are the model FAMILIES supported by every major local
 * inference server (Ollama, LM Studio, llama.cpp, Jan, vLLM). The names are
 * not Ollama-specific — Llama is Meta's, Mistral is Mistral AI's, Gemma is
 * Google's, Phi is Microsoft's, Qwen is Alibaba's, Codellama is Meta's. Each
 * server pulls them from its own catalog (Ollama from its registry, LM Studio
 * from HuggingFace, llama.cpp from GGUF files, etc.).
 *
 * Use this as the dropdown source for "what model do you want to run" in
 * any on-device / local-server UI. The user can pull any model; these are
 * the safe defaults to surface first.
 */
export const LOCAL_SERVER_SUGGESTED_MODELS = [
  "qwen3", // balanced all-rounder, tool-capable — the first-run default
  "gpt-oss", // OpenAI open-weights — best small tool-use class (~16GB)
  "gemma3", // Google open family
  "llama4", // Meta current family
  "phi4-mini", // minimal-hardware tier (entry laptops, iGPU)
  "deepseek-r1", // reasoning-class open weights
  "mistral-small3.2", // Mistral current small
] as const;

/**
 * @deprecated since 1.0.0, removed in 3.0.0. Use {@link LOCAL_SERVER_SUGGESTED_MODELS} instead.
 *
 * Reason: the old name implied the list was Ollama-specific, but every
 * entry runs on every supported local inference server (Ollama, LM Studio,
 * llama.cpp, vLLM). Vendor-neutral naming matches the runtime's
 * `"local-server"` provider discriminator.
 */
export const OLLAMA_SUGGESTED_MODELS = LOCAL_SERVER_SUGGESTED_MODELS;

/** Models available through the Motebit proxy (all cloud providers). */
export const PROXY_MODELS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

// === Default Models ===

/** Default Anthropic model — the picker's `recommended` row (#654). */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** Default OpenAI model. */
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

/** Default Google model. */
export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";

/**
 * Default DeepSeek model — V3 via the `deepseek-chat` API identifier.
 * The tool-use-capable workhorse; matches the per-vendor "default tier"
 * convention used by `DEFAULT_ANTHROPIC_MODEL` / `DEFAULT_OPENAI_MODEL` /
 * `DEFAULT_GOOGLE_MODEL`.
 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

/**
 * Default Groq model — Llama 3.3 70B served at ~280 tok/sec via the
 * Groq LPU inference stack. Tool-use-capable; matches the per-vendor
 * "default tier" convention used by the other `DEFAULT_*_MODEL`
 * constants.
 */
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

/** Default Ollama model — used as the `local-server` default too.
 * 2026-07-31 refresh: `llama3.2` (Sept 2024, 3B) was the witnessed weak-model
 * floor — safe under the governance stack but not useful (fabricated a money
 * proposal from noise). `qwen3` is the current balanced, tool-capable local
 * family. A default can be old; it can never be UNEXAMINED — see
 * MODEL_DEFAULT_REVIEW_BY below. */
export const DEFAULT_OLLAMA_MODEL = "qwen3";

/**
 * Canonical default model for the on-device `local-server` backend.
 * Currently aliased to `DEFAULT_OLLAMA_MODEL` — Ollama's `llama3.2` is
 * the sensible first-run default even for users who end up running
 * LM Studio / llama.cpp / vLLM. Prefer this name in new code; the
 * Ollama-specific alias is retained for places that genuinely mean
 * the Ollama model identifier.
 */
export const DEFAULT_LOCAL_SERVER_MODEL = DEFAULT_OLLAMA_MODEL;

/** Default proxy model (used when no model is specified). */
export const DEFAULT_PROXY_MODEL = "claude-sonnet-4-6";

/**
 * The model ids Motebit Cloud (`services/proxy`) admits on the metered
 * proxy-token path — the exact set its `isModelAllowedInMotebitCloud`
 * accepts (a `MODEL_CONFIG` row in an allowed jurisdiction). Born #654 cold
 * review: a surface that fell through to `DEFAULT_ANTHROPIC_MODEL` on the
 * Cloud path sent `claude-sonnet-5`, which the proxy refuses (451) — the
 * BYOK default and the Cloud catalog are different lanes. The proxy CONSUMES
 * this list (its admission requires membership) and its tests pin the list
 * to `MODEL_CONFIG` both ways, so the surfaces and the proxy share one set.
 *
 * Distinct from {@link PROXY_MODELS} (the Cloud PICKER's display list, which
 * is a UI concern). Changing this list is a Cloud catalog change.
 */
export const MOTEBIT_CLOUD_ACCEPTED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
] as const;

/** The Cloud router sentinel: the proxy classifies the turn and picks a model. */
export const MOTEBIT_CLOUD_AUTO_MODEL = "auto";

/**
 * Legacy and class-level model aliases Motebit Cloud resolves to a current
 * accepted id. Frontends send whatever model string they were built with;
 * the proxy resolves it here, so when a model version ships, updating the
 * right-hand side upgrades every deployed client without a redeploy.
 *
 * Lifted from `services/proxy` (#654 cold review R2): a client pre-flight
 * that checked only {@link MOTEBIT_CLOUD_ACCEPTED_MODELS} skipped this step
 * and refused `claude-opus`, `gpt-4o`, a stored `claude-opus-4-20250115` —
 * ids the proxy serves. The table lives here so the proxy and every client
 * run {@link motebitCloudAdmission}, one function, never a copy.
 */
export const MOTEBIT_CLOUD_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Class aliases — "give me the best Sonnet" without caring about the version
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-6",
  "claude-haiku": "claude-haiku-4-5-20251001",

  // Legacy dated versions → current
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-opus-4-20250115": "claude-opus-4-6",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001",
  "claude-3-opus-20240229": "claude-opus-4-6",

  // OpenAI aliases
  "gpt-5": "gpt-5.4",
  "gpt-4o": "gpt-5.4-mini",
  "gpt-4o-mini": "gpt-5.4-nano",
  "gpt-4o-2024-11-20": "gpt-5.4-mini",
  "gpt-4o-mini-2024-07-18": "gpt-5.4-nano",

  // Google aliases
  "gemini-pro": "gemini-2.5-pro",
  "gemini-flash": "gemini-2.5-flash",
  "gemini-flash-lite": "gemini-2.5-flash-lite",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-flash": "gemini-2.5-flash",
};

/**
 * The model list a relay-minted proxy token carries once the account has
 * REAL funding (a deposit, settlement earnings — anything that is not the
 * welcome credit). The relay MINTS from this list and the proxy refuses (400)
 * any id outside the token's list, so it is the second half of Cloud
 * admission (#654 cold review R3): an id in
 * {@link MOTEBIT_CLOUD_ACCEPTED_MODELS} but not here (the Groq rows) is never
 * served to a paying account. Every id here must be accepted.
 */
export const MOTEBIT_CLOUD_DEPOSIT_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

/**
 * The model list a token carries while the account holds ONLY the welcome
 * credit. The frontier tier is excluded: a $0.10 free identity naming Opus at
 * 16k output tokens in parallel is the overspend shape the 2026-09-12 audit
 * named. A subset of {@link MOTEBIT_CLOUD_DEPOSIT_MODELS}.
 */
export const MOTEBIT_CLOUD_FREE_CREDIT_MODELS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

/** How an account is funded — the relay picks the token's model list by it. */
export type MotebitCloudFundingTier = "deposit" | "free-credit";

/** The list the relay mints into a proxy token, per funding tier. */
export const MOTEBIT_CLOUD_TOKEN_MODELS: Readonly<
  Record<MotebitCloudFundingTier, readonly string[]>
> = {
  deposit: MOTEBIT_CLOUD_DEPOSIT_MODELS,
  "free-credit": MOTEBIT_CLOUD_FREE_CREDIT_MODELS,
};

/** Why {@link motebitCloudAdmission} refused: the proxy's 400 vs its 451. */
export type MotebitCloudRefusal = "token_model" | "not_in_catalog";

/** The verdict of {@link motebitCloudAdmission}. */
export interface MotebitCloudAdmission {
  /** Would Motebit Cloud's metered (proxy-token) path admit the id as sent? */
  readonly admitted: boolean;
  /** The id the proxy routes after alias resolution (`""` for a non-string). */
  readonly resolved: string;
  /** Set when refused: outside the token's list (400) or the catalog (451). */
  readonly refusal?: MotebitCloudRefusal;
}

/** The two tables an admission is computed over. */
export interface MotebitCloudCatalog {
  readonly aliases: Readonly<Record<string, string>>;
  readonly accepted: readonly string[];
}

/** The shipped catalog. */
export const MOTEBIT_CLOUD_CATALOG: MotebitCloudCatalog = {
  aliases: MOTEBIT_CLOUD_MODEL_ALIASES,
  accepted: MOTEBIT_CLOUD_ACCEPTED_MODELS,
};

/** Which token the admission is asked about. */
export interface MotebitCloudAdmissionOptions {
  /**
   * The model list the token carries. The proxy passes the presented token's
   * list; an empty list means "no per-token list" (the catalog alone
   * decides), exactly as the route treats it. Overrides `tier`.
   */
  readonly tokenModels?: readonly string[];
  /**
   * A client that does not hold the token names the funding tier instead;
   * default `"deposit"` — the ceiling the relay mints for a paying account.
   */
  readonly tier?: MotebitCloudFundingTier;
  /** Test seam: prove the catalog checks are load-bearing. */
  readonly catalog?: MotebitCloudCatalog;
}

/**
 * Motebit Cloud's model admission — THE rule. `services/proxy` calls it on
 * every request with the presented token's model list (it holds no private
 * copy) and every client pre-flight or stored-setting sanitizer calls it with
 * the funding tier, so a client can never refuse or rewrite a model the proxy
 * would serve, nor admit one it would refuse (#654 cold review R2, R3). The
 * relay mints the token's list from {@link MOTEBIT_CLOUD_TOKEN_MODELS}, so
 * the relay, the proxy and every client read one table. Pure, no I/O.
 *
 *   - a non-string or empty id → refused;
 *   - `"auto"` → admitted (the proxy routes it server-side);
 *   - otherwise the id is alias-resolved, then refused with `token_model`
 *     when a non-empty token list does not name the resolved id (the route's
 *     400), else with `not_in_catalog` when the accepted set does not (its
 *     451). Exact match: no trimming, no case folding — the proxy does
 *     neither.
 */
export function motebitCloudAdmission(
  model: unknown,
  options: MotebitCloudAdmissionOptions = {},
): MotebitCloudAdmission {
  const catalog = options.catalog ?? MOTEBIT_CLOUD_CATALOG;
  const tokenModels = options.tokenModels ?? MOTEBIT_CLOUD_TOKEN_MODELS[options.tier ?? "deposit"];
  if (typeof model !== "string" || model.length === 0) {
    return { admitted: false, resolved: "", refusal: "not_in_catalog" };
  }
  if (model === MOTEBIT_CLOUD_AUTO_MODEL) return { admitted: true, resolved: model };
  const resolved = Object.prototype.hasOwnProperty.call(catalog.aliases, model)
    ? (catalog.aliases[model] as string)
    : model;
  if (tokenModels.length > 0 && !tokenModels.includes(resolved)) {
    return { admitted: false, resolved, refusal: "token_model" };
  }
  if (!catalog.accepted.includes(resolved)) {
    return { admitted: false, resolved, refusal: "not_in_catalog" };
  }
  return { admitted: true, resolved };
}

/** Would Motebit Cloud admit `model` as sent, for a paying (deposit-funded) account? */
export function motebitCloudAdmitsModel(model: string): boolean {
  return motebitCloudAdmission(model).admitted;
}

/**
 * The Motebit Cloud picker's rows: {@link PROXY_MODELS} filtered by
 * {@link motebitCloudAdmission} for `tier` (default `"deposit"`). Every
 * surface renders its Cloud `<select>` from this one function (#654 cold
 * review) — never a hand-copied list. The `"auto"` row is the surface's own.
 */
export function motebitCloudPickerModels(
  tier: MotebitCloudFundingTier = "deposit",
): readonly string[] {
  return PROXY_MODELS.filter((m) => motebitCloudAdmission(m, { tier }).admitted);
}

/** Every provider a surface can switch to, under any of its spellings. */
export type ModelDefaultProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "groq"
  | "deepseek"
  | "local-server"
  | "ollama"
  | "proxy"
  | "motebit-cloud";

/**
 * The model a surface uses when the provider changes (or is first chosen)
 * and the user named no model. The ONE derivation every surface's
 * provider-switch / default path calls (#654 cold review): each surface used
 * to hand-roll a ternary chain whose fall-through arm was
 * `DEFAULT_ANTHROPIC_MODEL`, so a provider the chain forgot — `proxy` —
 * silently got the BYOK Anthropic default, which Motebit Cloud refuses.
 * Exhaustive by construction: a new provider is a compile error here, never
 * a silent fall-through.
 */
export function defaultModelForProvider(provider: ModelDefaultProvider): string {
  switch (provider) {
    case "anthropic":
      return DEFAULT_ANTHROPIC_MODEL;
    case "openai":
      return DEFAULT_OPENAI_MODEL;
    case "google":
      return DEFAULT_GOOGLE_MODEL;
    case "groq":
      return DEFAULT_GROQ_MODEL;
    case "deepseek":
      return DEFAULT_DEEPSEEK_MODEL;
    case "local-server":
    case "ollama":
      return DEFAULT_LOCAL_SERVER_MODEL;
    case "proxy":
    case "motebit-cloud":
      return DEFAULT_PROXY_MODEL;
  }
}

/**
 * Review-by dates for the DEFAULT_*_MODEL constants — defaults as
 * perishable inventory with a printed expiry. Model half-life is months
 * now; a default frozen at authoring time ships an old brain in a new
 * body without anyone deciding that. The rule (coverage-graduation's
 * shape applied to intelligence): a default can be old — behind-on-purpose
 * is a product choice — but it can never be UNEXAMINED. The scheduled
 * external gate (`check-model-catalog-drift`) goes red past a date with a
 * repair naming this table; the fix is a DELIBERATE human review — bump
 * the date with or without a model change. The gate never bumps a model.
 */
export const MODEL_DEFAULT_REVIEW_BY: Record<string, string> = {
  anthropic: "2026-12-31",
  openai: "2026-10-31",
  google: "2026-10-31",
  deepseek: "2026-10-31",
  groq: "2026-10-31",
  "local-server": "2026-10-31",
  proxy: "2026-10-31",
};

// === Anthropic picker (#654) ===
//
// The curated rows every surface's Anthropic model picker renders. Born
// because each surface had hand-copied its own option list, and they drifted
// independently (web offered Opus 4.7 / Sonnet 4.6 after Opus 5.5 / Sonnet 5
// shipped; desktop dumped all of ANTHROPIC_MODELS; the CLI's `/model haiku`
// alias named an id the registry does not carry). One table here, rendered
// everywhere; `check-model-picker-canonical` refuses a hand-copied list.
//
// Three tiers, one row each. Every other ANTHROPIC_MODELS id (Fable 5.1
// included) stays selectable by typing its id — the picker is curation, not
// an allowlist. A stored non-picker id is shown and kept selected, never
// migrated (`pickerOptionsWithStored`): changing the default must not
// silently change a model the user chose.

/** A picker tier — strongest, recommended default, fastest. */
export type AnthropicPickerTier = "strongest" | "default" | "fast";

export interface AnthropicPickerOption {
  readonly id: AnthropicModel;
  readonly label: string;
  readonly tier: AnthropicPickerTier;
}

/** Rows in display order. The `default` row's id IS `DEFAULT_ANTHROPIC_MODEL`
 *  (asserted in tests). */
export const ANTHROPIC_PICKER: readonly AnthropicPickerOption[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — most capable", tier: "strongest" },
  { id: DEFAULT_ANTHROPIC_MODEL, label: "Claude Sonnet 5 — recommended", tier: "default" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — fastest", tier: "fast" },
] as const;

/** The picker's model id for a tier. */
export function pickerModelForTier(tier: AnthropicPickerTier): AnthropicModel {
  const row = ANTHROPIC_PICKER.find((o) => o.tier === tier);
  // Unreachable by construction (one row per tier); fail loud, not silent.
  if (row == null) throw new Error(`ANTHROPIC_PICKER has no row for tier "${tier}"`);
  return row.id;
}

/** A rendered picker row: `selected` marks the one to pre-select. */
export interface PickerRenderOption {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
}

/**
 * The rows a surface renders, given the user's stored model (if any).
 *
 *   - no stored model → the picker rows, the default row selected;
 *   - a stored picker id → that row selected;
 *   - a stored NON-picker id (e.g. `claude-sonnet-4-6` from before #654, or a
 *     typed `claude-fable-5-1`) → prepended as its own row and selected. Never
 *     migrated to the new default: the user's choice outranks the curation.
 */
export function pickerOptionsWithStored(stored?: string | null): PickerRenderOption[] {
  const s = stored?.trim() ?? "";
  const inPicker = s !== "" && ANTHROPIC_PICKER.some((o) => o.id === s);
  const selectedId = s === "" ? DEFAULT_ANTHROPIC_MODEL : s;
  const rows: PickerRenderOption[] = ANTHROPIC_PICKER.map((o) => ({
    id: o.id,
    label: o.label,
    selected: o.id === selectedId,
  }));
  if (s !== "" && !inPicker) rows.unshift({ id: s, label: s, selected: true });
  return rows;
}

// === Type Helpers ===

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];
export type OpenAIModel = (typeof OPENAI_MODELS)[number];
export type GoogleModel = (typeof GOOGLE_MODELS)[number];
export type LocalServerSuggestedModel = (typeof LOCAL_SERVER_SUGGESTED_MODELS)[number];
/**
 * @deprecated since 1.0.0, removed in 3.0.0. Use {@link LocalServerSuggestedModel} instead.
 *
 * Reason: paired with {@link OLLAMA_SUGGESTED_MODELS}. Vendor-neutral
 * naming for the same underlying model set.
 */
export type OllamaSuggestedModel = LocalServerSuggestedModel;
export type ProxyModel = (typeof PROXY_MODELS)[number];

// === Provider ↔ model coherence ===
//
// Born live, 2026-07-06: `--provider anthropic` with a config-resident
// `default_model: llama3.2:latest` composed an Anthropic provider around
// an Ollama model id — the banner printed the illegal pairing and the
// failure deferred to the first API call. The intelligence-pluggability
// contract's first commitment is PRE-FLIGHT admission: the selected
// model must fit the selected provider BEFORE any turn runs. These two
// helpers are that check's canonical home (the registry already knows
// the vendors).

/** Best-effort vendor attribution for a model id. Registry membership
 *  first, then naming-signature heuristics for ids the registry hasn't
 *  caught up to (new dated releases must not brick startup — an
 *  `"unknown"` verdict is deliberately permissive). */
export function modelVendorHint(
  model: string,
): "anthropic" | "openai" | "google" | "deepseek" | "groq" | "local" | "unknown" {
  const m = model.trim().toLowerCase();
  if ((ANTHROPIC_MODELS as readonly string[]).includes(m)) return "anthropic";
  if ((OPENAI_MODELS as readonly string[]).includes(m)) return "openai";
  if ((GOOGLE_MODELS as readonly string[]).includes(m)) return "google";
  if ((DEEPSEEK_MODELS as readonly string[]).includes(m)) return "deepseek";
  if ((GROQ_MODELS as readonly string[]).includes(m)) return "groq";
  if (m.startsWith("claude")) return "anthropic";
  // gpt-oss is OpenAI's OPEN-WEIGHTS family — local-served (ollama/LM
  // Studio/Groq), never the hosted API. Must precede the `gpt-` branch or
  // the local-server admission gate refuses its own suggested model.
  if (m.startsWith("gpt-oss")) return "local";
  if (m.startsWith("gpt-") || /^o[0-9]/.test(m)) return "openai";
  if (m.startsWith("gemini")) return "google";
  // deepseek-r1 is the OPEN-WEIGHTS reasoning family (ollama tag) — the
  // hosted API ids are deepseek-chat / deepseek-reasoner. Caught by the
  // suggested-table admissibility invariant on its first run (2026-07-31).
  if (m.startsWith("deepseek-r1")) return "local";
  if (m.startsWith("deepseek")) return "deepseek";
  // Ollama-style tags and the common local families.
  if (m.includes(":") || /^(llama|mistral|qwen|phi|gemma|smollm)/.test(m)) return "local";
  return "unknown";
}

/**
 * Pre-flight admission: may `model` be served by `provider`?
 * Permissive where honesty demands it — `local-server` runs whatever the
 * user's server hosts, and an `"unknown"` vendor hint never blocks a BYOK
 * vendor (the registry lags new releases). Motebit Cloud (`proxy`) is the
 * exception: its catalog ships with this package, so it answers exactly
 * {@link motebitCloudAdmission}.
 * It answers `false` only for a KNOWN cross-vendor mismatch — exactly
 * the class that fails opaquely at the API otherwise.
 */
export function providerAcceptsModel(provider: string, model: string): boolean {
  if (provider === "local-server" || provider === "ollama") return true;
  // Motebit Cloud is a fixed catalog with an alias step, so it answers by
  // its own rule, not a vendor-family guess (#654 cold review R2): the guess
  // both over-admitted (`claude-sonnet-5`, which Cloud refuses) and
  // under-admitted (`llama-3.3-70b-versatile`, which Cloud serves).
  if (provider === "proxy" || provider === "motebit-cloud") return motebitCloudAdmitsModel(model);
  const hint = modelVendorHint(model);
  if (hint === "unknown") return true;
  if (provider === "groq") return hint === "groq" || hint === "local"; // groq serves open models
  return hint === provider;
}

// === Capability tiers ===
//
// Born live, 2026-07-31 (#501): `llama3.2` (3B, 2024) was offered
// `delegate_to_agent` — a real-money tool — and fabricated a hire proposal
// from noise. The governance stack held (approval gate, money band, denial
// brake; $0 moved), which proved the SAFETY floor. The tier axis is the
// CAPABILITY floor: intelligence-pluggability commitment #3 — tools adapt
// to the selected model — needs a registry answer to "what class of model
// is this?". The runtime keys money-tool exposure on it; nothing here
// gates admission (a minimal model is a legitimate sovereign choice).

/** Capability class of a model id. `unknown → "capable"` — permissive,
 *  like admission: registry lag must never lobotomize a good new model. */
export type ModelCapabilityTier = "frontier" | "capable" | "minimal";

/** Model families known to be small (≤~4B): useful for chat, memory, and
 *  local tools; not reliable instrument-holders. Matched on the id's base
 *  name (before any `:tag`). */
const MINIMAL_FAMILIES = [
  "llama3.2", // 1B/3B family — the witnessed weak-model floor
  "phi4-mini",
  "phi-3",
  "phi3",
  "smollm",
  "tinyllama",
  "gpt-5.4-nano",
] as const;

/** Frontier prefixes — the strongest hosted classes. Haiku is deliberately
 *  absent (capable); so are minis/flashes. */
const FRONTIER_PREFIXES = [
  "claude-fable",
  "claude-mythos",
  "claude-opus",
  "claude-sonnet",
  "gpt-5.4", // bare flagship; -mini/-nano handled before this check
  "gemini-2.5-pro",
] as const;

/**
 * Best-effort capability tier for a model id.
 *
 * Resolution order:
 *   1. Ollama-style size tag (`model:NNb`) — the honest parameter signal
 *      for local pulls: under 7B → `minimal`, otherwise `capable` (a size
 *      tag never claims frontier).
 *   2. Known-small families → `minimal`.
 *   3. Frontier prefixes (with mini/nano demoted first) → `frontier`.
 *   4. Everything else — including unknown ids — → `capable`.
 *
 * Like the defaults table, this is perishable knowledge: it rides the
 * same review discipline (`MODEL_DEFAULT_REVIEW_BY`) rather than
 * pretending to be timeless.
 */
export function modelCapabilityTier(model: string): ModelCapabilityTier {
  const m = model.trim().toLowerCase();
  if (m === "") return "capable";

  // 1. Embedded parameter size — ollama tags (`qwen3:0.6b`, `gemma3:4b`)
  // and dash-form ids (`Llama-3.2-3B-Instruct…`, `gpt-oss-120b`,
  // `llama-3.3-70b-versatile`). The honest signal wherever it appears.
  const sizeTag = /[:\-_](\d+(?:\.\d+)?)b(?:[-_.:]|$)/.exec(m);
  if (sizeTag != null) {
    return parseFloat(sizeTag[1]!) < 7 ? "minimal" : "capable";
  }

  const base = m.split(":")[0]!;

  // 2. Known-small families — prefix match so version suffixes stay in
  // the family (`smollm2`, `phi3.5`).
  if (MINIMAL_FAMILIES.some((f) => base.startsWith(f))) {
    return "minimal";
  }

  // 3. Frontier — demote the small variants of flagship names first.
  if (base.endsWith("-mini") || base.endsWith("-nano") || base.includes("flash")) {
    return "capable";
  }
  if (FRONTIER_PREFIXES.some((p) => base.startsWith(p))) {
    return "frontier";
  }

  // 4. Permissive default.
  return "capable";
}

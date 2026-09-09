/**
 * check-model-catalog-drift — the first EXTERNAL drift gate (#475).
 *
 * Every other drift defense points inward; this one points at a canonical
 * source OUTSIDE the repo: the provider's live models endpoint. The
 * 2026-07-29 night found three layers of provider drift live (fabricated
 * ids #474, removed sampling params #476, removed budget_tokens) — all
 * with the same root: the committed snapshot tables and shaping regexes
 * drift against a truth the repo cannot see. This gate makes that drift a
 * red check within a week instead of a user-facing 404 months later.
 *
 * NOT in the `pnpm check` GATES array by design: it needs network + a live
 * API key, so it runs from the scheduled workflow
 * (.github/workflows/model-catalog-drift.yml), the sibling of the
 * archetype-conformance probe. Inventory row #150 in docs/drift-defenses.md.
 *
 * Checks (Anthropic — the provider whose catalog is richest):
 *   1. SNAPSHOT ROWS STILL SERVED — every id in @motebit/sdk's
 *      ANTHROPIC_MODELS exists in the live catalog. A retired row is the
 *      #474 class (stale ids that 404).
 *   2. SNAPSHOT COMPLETE — every live id exists in ANTHROPIC_MODELS.
 *      Behind-on-purpose is a product choice (defaults stay human — this
 *      gate NEVER bumps a default); behind-unknowingly is the defect.
 *   3. SHAPING FAMILY RECOGNIZED — every live id is classified by the
 *      request-shape families (rejects-sampling vs legacy-sampling). An
 *      unrecognized NEW family would silently get the old request shape
 *      and 400 on its first turn (the #476 class).
 *
 * Key handling: this gate is meaningless without live access. With
 * --require-key (the workflow) a missing ANTHROPIC_API_KEY is RED — a
 * skipped external gate is a dormant one (composition-preserves-
 * enforcement). Without the flag (local `pnpm check-model-catalog-drift`)
 * it skips politely.
 */

import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_LOCAL_SERVER_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_PROXY_MODEL,
  MODEL_DEFAULT_REVIEW_BY,
} from "@motebit/sdk";
import { modelRejectsSamplingParams } from "@motebit/ai-core/browser";
import { failWithRepair } from "./lib/gate-report.js";

const DEFAULTS_BY_PROVIDER: Record<string, string> = {
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  google: DEFAULT_GOOGLE_MODEL,
  deepseek: DEFAULT_DEEPSEEK_MODEL,
  groq: DEFAULT_GROQ_MODEL,
  "local-server": DEFAULT_LOCAL_SERVER_MODEL,
  proxy: DEFAULT_PROXY_MODEL,
};

/**
 * Defaults as perishable inventory: every DEFAULT_*_MODEL carries a
 * review-by date (MODEL_DEFAULT_REVIEW_BY). Past the date the gate goes
 * red — the repair is a DELIBERATE human review, never an auto-bump
 * (behind-on-purpose is a product choice; behind-unknowingly is the
 * defect). Runs KEYLESS — this half needs no network, so a local
 * `pnpm check-model-catalog-drift` exercises it too.
 */
function checkDefaultReviewDates(): void {
  const today = new Date().toISOString().slice(0, 10);
  const lapsed: string[] = [];
  for (const [provider, reviewBy] of Object.entries(MODEL_DEFAULT_REVIEW_BY)) {
    const current = DEFAULTS_BY_PROVIDER[provider] ?? "?";
    if (today > reviewBy) {
      lapsed.push(`${provider} — default "${current}" unreviewed since ${reviewBy}`);
    } else {
      console.log(
        `check-model-catalog-drift: default ${provider}=${current} reviewed through ${reviewBy}`,
      );
    }
  }
  if (lapsed.length > 0) {
    failWithRepair({
      invariant:
        "Every DEFAULT_*_MODEL carries an unexpired review-by date — a default can be old, never UNEXAMINED (model half-life is months).",
      sites: lapsed,
      canonical: "packages/sdk/src/models.ts",
      fix:
        "Review each lapsed DEFAULT_*_MODEL against the current model landscape, then bump its MODEL_DEFAULT_REVIEW_BY date in packages/sdk/src/models.ts deliberately — with or without a model change. " +
        "Never auto-bump the model itself; behind-on-purpose is a product choice (#475).",
      doctrine: "docs/doctrine/intelligence-pluggability-contract.md",
    });
  }
}

/** Families whose request shape is the LEGACY one (sampling params
 * accepted, budget_tokens thinking). A live id matching neither this nor
 * `modelRejectsSamplingParams` is an unclassified NEW family. */
const LEGACY_FAMILY = /^claude-(?:2|3|opus-4-[0-6]|sonnet-4-[0-6]|haiku-[0-9])/i;

async function fetchLiveIds(apiKey: string): Promise<string[]> {
  const resp = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!resp.ok) throw new Error(`GET /v1/models returned ${resp.status}`);
  const body = (await resp.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

async function fetchOpenAiLiveIds(apiKey: string): Promise<string[]> {
  const resp = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`GET /v1/models returned ${resp.status}`);
  const body = (await resp.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

/**
 * One provider's catalog check (#518 — extending the gate past Anthropic).
 *
 * `bidirectional` is the load-bearing field, and the asymmetry is deliberate
 * rather than an omission. Anthropic serves a small curated catalog (11 ids
 * live today), so a live id ABSENT from the snapshot is real drift — we are
 * behind unknowingly. OpenAI serves hundreds across every modality (chat,
 * images, audio, embeddings, moderation), and motebit deliberately curates
 * three of them. Reporting the other ~hundreds as "missing from the snapshot"
 * would be noise wearing the costume of a finding, and a gate that cries drift
 * on every run is one nobody reads.
 *
 * So for OpenAI only the snapshot → live direction is checked: every id we
 * SHIP must still be served. That is the #474 class — the one that 404s a real
 * user — and it is the half that actually applies.
 */
interface ProviderCatalog {
  readonly provider: string;
  readonly envVar: string;
  readonly snapshot: readonly string[];
  /** Where the snapshot lives, for the repair instruction. */
  readonly snapshotSymbol: string;
  readonly fetchLiveIds: (apiKey: string) => Promise<string[]>;
  /** See the docblock above — false means snapshot→live only. */
  readonly bidirectional: boolean;
  /**
   * Whether a missing key is RED under `--require-key`. True once the secret
   * exists in CI: from then on, a REMOVED secret must fail rather than quietly
   * skip, or the gate silently stops defending (composition-preserves-enforcement).
   */
  readonly requiredInCi: boolean;
}

const CATALOGS: readonly ProviderCatalog[] = [
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    snapshot: ANTHROPIC_MODELS as readonly string[],
    snapshotSymbol: "ANTHROPIC_MODELS in packages/sdk/src/models.ts",
    fetchLiveIds,
    bidirectional: true,
    requiredInCi: true,
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    snapshot: OPENAI_MODELS as readonly string[],
    snapshotSymbol: "OPENAI_MODELS in packages/sdk/src/models.ts",
    fetchLiveIds: fetchOpenAiLiveIds,
    bidirectional: false,
    requiredInCi: true,
  },
];

async function main(): Promise<void> {
  // Keyless half first: default review-by dates (fails fast when lapsed).
  checkDefaultReviewDates();

  const requireKey = process.argv.includes("--require-key");
  const sites: string[] = [];
  const summaries: string[] = [];
  const skipped: string[] = [];

  for (const catalog of CATALOGS) {
    const apiKey = process.env[catalog.envVar];

    if (apiKey == null || apiKey === "") {
      // A skipped external gate is a dormant one, so absence is never silent.
      if (requireKey && catalog.requiredInCi) {
        failWithRepair({
          invariant: `check-model-catalog-drift: ${catalog.envVar} is not set, so ${catalog.provider}'s external catalog cannot be read — a skipped external gate is a dormant one.`,
          canonical: ".github/workflows/model-catalog-drift.yml",
          fix: `Set the ${catalog.envVar} repository secret for the scheduled workflow, or run locally without --require-key to skip.`,
          doctrine: "docs/doctrine/composition-preserves-enforcement.md",
        });
      }
      skipped.push(`${catalog.provider} (no ${catalog.envVar})`);
      continue;
    }

    const live = await catalog.fetchLiveIds(apiKey);
    const liveSet = new Set(live);
    const snapshotSet = new Set(catalog.snapshot);

    // Every id we SHIP must still be served — the #474 class, the one that
    // 404s a real user. Checked for every provider.
    for (const id of catalog.snapshot.filter((id) => !liveSet.has(id))) {
      sites.push(
        `[${catalog.provider}] ${id} — snapshot row NO LONGER SERVED by the live API (the #474 stale-id class)`,
      );
    }

    if (catalog.bidirectional) {
      for (const id of live.filter((id) => !snapshotSet.has(id))) {
        sites.push(
          `[${catalog.provider}] ${id} — live id MISSING from the snapshot (behind-unknowingly)`,
        );
      }
      // Request-shape classification is Anthropic-specific: it is the axis on
      // which that provider's families diverge (#476). The OpenAI-compat shape
      // is uniform across its catalog, so there is nothing to classify.
      for (const id of live.filter(
        (id) => !modelRejectsSamplingParams(id) && !LEGACY_FAMILY.test(id),
      )) {
        sites.push(
          `[${catalog.provider}] ${id} — live id not classified by any request-shape family (the #476 class: a new family silently gets the legacy shape and 400s)`,
        );
      }
    }

    summaries.push(
      `${catalog.provider}: ${catalog.snapshot.length} snapshot row(s) checked against ${live.length} live id(s)` +
        (catalog.bidirectional
          ? ""
          : " (snapshot→live only — the provider serves hundreds across modalities; see ProviderCatalog.bidirectional)"),
    );
  }

  if (sites.length === 0) {
    // State the aperture with the verdict: which providers were actually read,
    // and which were not assessed at all. "OK" over an unread provider is the
    // failure this gate exists to prevent, one level up.
    console.log(`check-model-catalog-drift: OK — ${summaries.join("; ")}`);
    if (skipped.length > 0) {
      console.log(
        `  NOTE: ${skipped.length} provider(s) NOT ASSESSED (not proven clean): ${skipped.join(", ")}`,
      );
    }
    return;
  }

  failWithRepair({
    invariant:
      "The committed model snapshot and request-shape families must track the provider's LIVE catalog — the canonical truth lives outside the repo.",
    sites,
    canonical: "packages/sdk/src/models.ts",
    fix:
      "Update the offending provider's snapshot in packages/sdk/src/models.ts to match its live catalog (verify every id against the provider's GET /v1/models — never construct one, never add a date suffix). " +
      "For an unclassified new Anthropic family, verify its request shape against the provider docs, then extend modelRejectsSamplingParams in packages/ai-core/src/core.ts and LEGACY_FAMILY in scripts/check-model-catalog-drift.ts. " +
      "Do NOT bump any DEFAULT_*_MODEL as part of this fix — defaults stay human (#475).",
    doctrine: "docs/doctrine/intelligence-pluggability-contract.md",
  });
}

main().catch((err) => {
  console.error(
    `check-model-catalog-drift: transient failure (${err instanceof Error ? err.message : String(err)})`,
  );
  process.exit(1);
});

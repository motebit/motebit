---
"@motebit/sdk": patch
---

Slice 2i — model registry drift fix. Caught during the live smoke
of the slab arc: the Settings dropdown advertised
`claude-opus-4-6 — most capable`, a model that doesn't exist
(current Opus is 4.7).

**Root cause** — single source of truth was already in
`packages/sdk/src/models.ts` (`ANTHROPIC_MODELS`), but
`apps/web/src/ui/settings.ts` had a duplicate literal list with the
stale entry. Two files, two truths; sdk's was a version behind.

**Fix:**

- `ANTHROPIC_MODELS` and `PROXY_MODELS` updated to `claude-opus-4-7`
  (matches the canonical Claude 4.X family — Opus 4.7 / Sonnet 4.6
  / Haiku 4.5).
- `apps/web/src/ui/settings.ts` no longer redeclares the Anthropic
  list — imports `ANTHROPIC_MODELS` from `@motebit/sdk` and maps to
  UI labels via a local `ANTHROPIC_MODEL_LABELS` lookup. Single
  source of truth for the IDs; surface owns the human-readable
  copy.
- OpenAI / Google dropdowns intentionally diverge from sdk's
  `OPENAI_MODELS` / `GOOGLE_MODELS` — sdk's lists are the
  proxy-routed gpt-5.4 / gemini-2.5 cost tiers; the BYOK dropdown
  shows older models users may already pay for. Different intent,
  not a shadow. Only Anthropic is unified because only Anthropic
  has aligned intent.
- `check-preset-imports` (drift gate #40) gains an entry for
  `ANTHROPIC_MODELS` — future surfaces that try to redeclare it
  fail CI before merge. Same lock as `APPROVAL_PRESET_CONFIGS` /
  `COLOR_PRESETS` / etc.

Doctrine: `packages/sdk/CLAUDE.md` § "Model registry" + Rule 4
("Surfaces must not shadow canonical identifiers").

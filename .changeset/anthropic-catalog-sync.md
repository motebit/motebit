---
"@motebit/sdk": minor
---

`ANTHROPIC_MODELS` re-synced to the live catalog: adds `claude-fable-5-1`, removes `claude-opus-4-1-20250805`.

Both ids copied verbatim from `GET /v1/models` — never constructed, no date suffix invented. That discipline is the point: fabricated ids are what #474 shipped.

The removed row is the one that matters. `claude-opus-4-1-20250805` was in the shipped snapshot and **the provider no longer serves it** — a surface offering it would 404 a real user. The added row is the inverse: a live model we were behind on.

Found by `check-model-catalog-drift`, which had been reporting exactly this **red every week since 2026-08-10** — five consecutive scheduled runs — with nothing surfacing it, because the workflow had no failure alert. Fixed in the same change.

**Note on the bump.** This narrows an exported `readonly [...]` tuple, which is a type-level removal. Called minor rather than major deliberately: the removed literal names a model that no longer exists, so any consumer referencing it is already broken at runtime, and no consumer in the repo derives a type from `ANTHROPIC_MODELS[number]`. A major saying "nothing you use changed" teaches people to ignore majors. Overrule this before release if you read the tuple contract more strictly.

Worth flagging separately: encoding a _churning provider catalog_ as a literal tuple makes every model retirement a potential semver event. `readonly string[]` would make catalog syncs non-breaking by construction — a one-time change, not urgent.

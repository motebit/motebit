---
"@motebit/tools": minor
"motebit": patch
---

Add Tavily as an agent-tuned primary search provider in `@motebit/tools`
and slot it at the head of the `services/web-search` fallback chain.

Motivation: generic open-web indexes (Brave, DuckDuckGo) rank by
backlink density and ad-supported signals. For niche or new domains —
like first-party content on motebit.com today — recall is
disproportionately poor. The three-tier answer engine already biases
self-queries via `BiasedSearchProvider`, but the underlying index
matters once the query escapes first-party domains. Tavily is tuned
for agent RAG: structured JSON response, no HTML to parse, ranking
designed around what an agent actually reads.

Provider chain after this change, in `services/web-search`:

BiasedSearchProvider
└─ FallbackSearchProvider
├─ Tavily (if TAVILY_API_KEY set — primary)
├─ Brave (if BRAVE_SEARCH_API_KEY set — fallback)
└─ DuckDuckGo (always — last resort)

Each tier is opt-in via env var; a deploy with neither paid key runs
on DuckDuckGo alone. No interface change on `SearchProvider`, so the
relay's browser-side `ProxySearchProvider` sees the upgrade transparently.

Package surface:

- `TavilySearchProvider` + `TavilySearchProviderOptions` exported from
  `@motebit/tools` root and `@motebit/tools/web-safe`.
- Constructor accepts an injected `fetch` for tests; defaults to
  `globalThis.fetch`.
- Constructor accepts `searchDepth: "basic" | "advanced"` (default
  "basic"). `include_answer` is forced off — synthesis happens in
  `services/research`, not in the provider.

Tests: 9 in `packages/tools/src/providers/__tests__/tavily-search.test.ts`
covering wire shape (POST + body fields), searchDepth override,
content→snippet mapping, defensive filtering of incomplete results,
empty responses, HTTP error propagation (401 / 429 / large-body
truncation), and fetch-level network errors. Service wiring in
`services/web-search/src/index.ts` reorders the chain Tavily →
Brave → DuckDuckGo, `.env.example` documents the new var.

All 151 @motebit/tools tests + 15 drift gates pass.

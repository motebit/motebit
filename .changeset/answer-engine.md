---
"@motebit/protocol": minor
"@motebit/tools": minor
"motebit": minor
---

Ship the three-tier answer engine.

Every query now routes through a knowledge hierarchy with one shared
citation shape: **interior → (federation) → public web**. The motebit's
own answer to "what is Motebit?" now comes from the corpus it ships with,
not from a Brave index that returns Motobilt (Jeep parts) because
open-web signal for a new product is near-zero.

### Ship-today scope

- **Interior tier:** new `@motebit/self-knowledge` package — a committed
  BM25 index over `README.md`, `DROPLET.md`, `THE_SOVEREIGN_INTERIOR.md`,
  `THE_METABOLIC_PRINCIPLE.md`. Zero runtime dependencies, zero network,
  zero tokens. Build script `scripts/build-self-knowledge.ts` regenerates
  the corpus deterministically; source hash is deterministic so the file
  is diff-stable when sources don't change.
- **`recall_self` builtin tool** in `@motebit/tools` (web-safe), mirroring
  `recall_memories` shape. Registered alongside existing builtins in
  `apps/web` and `apps/cli`. (Spatial surface intentionally deferred — it
  doesn't register builtin tools today; `recall_self` would be ahead of
  the parity line.)
- **Site biasing:** new `BiasedSearchProvider` wrapper in `@motebit/tools`
  composes with `FallbackSearchProvider`. `services/web-search` wraps its
  Brave→DuckDuckGo chain with the default motebit bias rule —
  `"motebit"` queries are rewritten to include
  `site:motebit.com OR site:docs.motebit.com OR site:github.com/motebit`.
  Word-boundary matching prevents "Motobilt" from tripping the rule.
- **`CitedAnswer` + `Citation` wire types** in `@motebit/protocol`
  (Apache-2.0 permissive floor). Universal shape for grounded answers
  across tiers: interior citations are self-attested (corpus locator,
  no receipt); web and federation citations bind to a signed
  `ExecutionReceipt.task_id` in the outer receipt's `delegation_receipts`
  chain. A new step in `permissive-client-only-e2e.test.ts` proves an
  auditor with only the permissive-floor surface (`@motebit/protocol` +
  `@motebit/crypto`) can verify the chain.
- **`services/research` extended with the interior tier.** New
  `motebit_recall_self` tool runs locally inside the Claude tool-use
  loop (no MCP atom, no delegation receipt — interior is self-attested).
  System prompt instructs recall-self-first for motebit-related
  questions. `ResearchResult` adds `citations` and `recall_self_count`
  fields alongside existing `delegation_receipts` / `search_count` /
  `fetch_count`.
- **`IDENTITY` prompt augmented** in `@motebit/ai-core` with one concrete
  sentence about Motebit-the-platform. New `KNOWLEDGE_DOCTRINE` constant
  in the static prefix instructs: "try recall_self first for self-queries;
  never fabricate; say you don't know when sources come up empty."

### Deferred

- **Agent-native search provider** — a follow-up PR adds an adapter for
  a search index with long-tail recall better suited to niche / new
  domains than the current generic web index. Slots into
  `FallbackSearchProvider` as the primary; current chain stays as
  fallback. Separate from this change so the biasing-wrapper impact is
  measurable in isolation.
- **Federation tier** (`answerViaFederation`): blocked on peer density.
- **Multi-step synthesis loop** (fact-check pass over draft answers):
  orthogonal quality improvement.
- **`recall_self` on spatial surface:** comes when spatial's builtin-tool
  suite lands; today it has no `web_search` / `recall_memories` parity
  either.

### Drift-gate infrastructure

`scripts/check-deps.ts` gains an `AUTO-GENERATED`/`@generated` banner
exception to its license-in-source rule — the committed
`packages/self-knowledge/src/corpus-data.ts` carries verbatim doc content
that incidentally includes BSL/Apache license tokens (from README badges).
Banner skip is the generic pattern; future generated modules benefit.

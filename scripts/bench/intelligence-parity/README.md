# Intelligence-parity bench

Does routing a turn through motebit make the **same model** slower or worse than
calling the provider API directly? This is a measurement tool: it changes no
prompt, context-window policy, routing or model default. It runs the product as
shipped and reports what it saw.

## Routes

Route A is the product. Every direct route is **derived from A's request as
captured at the transport seam** ([`wire-tap.ts`](wire-tap.ts) records the exact
body string and headers the provider adapter handed to `fetch`), never rebuilt
from config. Each route differs from its neighbour in one ingredient:

| route                   | what runs                                                                                                                                                                                                                                                                                          | contrast                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **A**                   | `MotebitRuntime.sendMessageStreaming` over the provider adapter built as the CLI builds it (`AnthropicProvider` or `OpenAIProvider` by wire protocol); fresh in-memory identity and store per run; seeded memories go through `formMemoriesFromCandidates`, prior turns through `loadConversation` | the product                     |
| **B′** (`Bp`)           | A's captured requests **replayed byte for byte** — same URL, body bytes and headers (only the redacted credential is re-supplied), every round in order. If the replayed model leaves A's trajectory (answers where A called a tool, or vice versa), replay stops and the divergence is recorded   | A ↔ B′: runtime / pipeline cost |
| **B″** (`Bpp`)          | A's round-1 request with only the system prompt replaced by a neutral one-liner: A's **trimmed** messages (trim note included), parameters, tools, `cache_control`, thinking/effort, `max_tokens`, temperature                                                                                     | B′ ↔ B″: system-prompt effect   |
| **B**                   | neutral system prompt + the **full untrimmed** conversation + A's parameters and tools                                                                                                                                                                                                             | B″ ↔ B: context-trimming effect |
| **B′ᶠ** (`Bpf`, opt-in) | A's system prompt + the full untrimmed conversation + A's parameters and tools — the fourth cell of the 2×2 {system prompt} × {trimming}, run on the quality subset only                                                                                                                           | separability check              |
| **C**                   | vendor product answers (claude.ai, ChatGPT…) collected by hand in the [`route-c.example.json`](route-c.example.json) format, passed with `--route-c=`                                                                                                                                              | A ↔ C: user gap                 |

Parameter freezing ([`params.ts`](params.ts)) works by exclusion: every
top-level key except the content keys (`system`, `messages`, `stream` on the
Anthropic wire; `messages`, `stream` on the OpenAI wire) is copied, so a
parameter the runtime adds in future is frozen automatically. On the OpenAI wire
motebit's system prompt is its `system`-role messages, and that is what B″
replaces.

Tools on A are the deterministic CLI builtins (`current_time`,
`recall_memories`, `recall_self`). B′ replays A's own later rounds (carrying A's
tool results); B, B″ and B′ᶠ answer a tool call by replaying A's recorded result
for an identical call, and refuse (and count) anything else.

## Providers

`--provider` (workflow input `provider`) is `anthropic` (default), `openai`,
`google`, `groq` or `deepseek` — the product's BYOK vendor registry, resolved
through the product's own `resolveProviderSpec`. Each reads its own secret
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`,
`DEEPSEEK_API_KEY`); a missing one fails the run naming it. The judge's provider
and model are set separately (`--judge-provider`, `--judge-model`).

## Quality: repetitions, not verdicts

Latency uses **every** prompt (once each). Quality uses a designated subset —
by default 6 prompts (`fact-tcp-handshake`, `explain-cap-theorem`,
`code-lru-cache`, `write-decline-email`, `longctx-turn1-recall`,
`mem-dietary`) × `--repetitions` (default 3) samples, each sample run on every
route and judged. [`judge.ts`](judge.ts) shuffles answers per sample with a
seeded RNG, labels them `Response 1…N`, masks self-identification in every
answer, and asks the judge (it must differ from the model under test) for 1–10
scores on correctness, completeness, depth-appropriateness and clarity, plus
pairwise preferences ([`rubric.md`](rubric.md)).

## Report

`report.md` / `report.json` give **pairwise effects only**:

- **Runtime (A ↔ B′)** — paired per-sample latency deltas (TTFT, total; median
  with CI, p90), motebit's pre-model breakdown (`TurnLatency`: event query,
  embed, pinned, retrieve), replay divergence, and quality (expected: noise).
- **System prompt (B′ ↔ B″)** — quality and output length.
- **Context trimming (B″ ↔ B)** — quality, output length, history retained.
- **User gap (A ↔ C)** — quality.

Each quality contrast reports the mean score difference with a 95%
cluster-bootstrap CI (prompts resampled, samples of a prompt kept together),
the per-sample difference distribution, the win rate with CI, and a per-prompt
table. The contrasts are **not** summed into a percentage attribution of A ↔ B
unless the 2×2 interaction check — `(B′ − B″) − (B′ᶠ − B)`, needing `Bpf` —
spans 0 with enough samples; otherwise the report states the interaction, or
that it was not tested.

## Running

```bash
npx tsx scripts/bench/intelligence-parity/run.ts estimate               # no key, no spend
ANTHROPIC_API_KEY=… npx tsx scripts/bench/intelligence-parity/run.ts all \
  --model=claude-sonnet-5 --subset=long-context,memory --max-usd=2
OPENAI_API_KEY=… ANTHROPIC_API_KEY=… npx tsx scripts/bench/intelligence-parity/run.ts all \
  --provider=openai --model=gpt-5.4-mini --prices=gpt-5.4-mini=<in>:<out>:<cache_read> \
  --routes=A,B,Bp,Bpp,Bpf
```

In CI: **Actions → Intelligence-parity bench → Run workflow**
([`.github/workflows/intelligence-parity-bench.yml`](../../../.github/workflows/intelligence-parity-bench.yml)).
The results, judgments and report are uploaded as an artifact, and the report
is also written to the job summary.

**Spend guard.** The run is refused when its pre-flight estimate — every live
route × its samples, plus the judge, tokens × the list prices in
[`spend.ts`](spend.ts) — exceeds `--max-usd` (default 5); the estimate and its
per-route breakdown are printed first. A live meter stops the run before the
next call once actual spend reaches the limit. An unpriced model is refused,
never priced at zero: models not tabled in `spend.ts` take their published
price via `--prices=<model>=<in>:<out>[:<cache_read>]` (USD per MTok). The full
default set (25 prompts, 6 × 3 quality samples, A/B/B′/B″, Opus judge) on
`claude-sonnet-5` estimates above $5, so narrow `--subset` or raise `--max-usd`
deliberately.

Self-tests (no network, fake transports under the real runtime):
`npx vitest run scripts/__tests__/intelligence-parity-bench.test.ts`.

# Intelligence-parity bench

Does routing a turn through motebit make the **same model** slower or worse than
calling the provider API directly? This is a measurement tool: it changes no
prompt, context-window policy, routing or model default. It runs the product as
shipped and reports what it saw.

## Routes

| route                      | what runs                                                                                                                                                                                                                                                             | isolates                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **A**                      | `MotebitRuntime.sendMessageStreaming` over `AnthropicProvider` built as the CLI builds it; fresh in-memory identity and store per run; seeded memories go through `formMemoriesFromCandidates`, prior turns through a `ConversationStoreAdapter` + `loadConversation` | the product                                             |
| **B**                      | direct `/v1/messages` with **A's parameters copied off the wire**, a neutral one-line system prompt and the full untrimmed conversation                                                                                                                               | A − B = the motebit tax                                 |
| **B′** (`--routes=A,B,Bp`) | A's exact round-1 request replayed directly                                                                                                                                                                                                                           | A − B′ = pipeline time; B′ vs B = prompt/context effect |
| **C**                      | vendor product answers (claude.ai, ChatGPT…) collected by hand in the [`route-c.example.json`](route-c.example.json) format, passed with `--route-c=`                                                                                                                 | vendor product layer                                    |

Every route's `/v1/messages` traffic goes through one fetch-level wire tap
([`wire-tap.ts`](wire-tap.ts)), so TTFT and token counts come from one
instrument, and A's parameters are what was actually sent, not what config claims.
Parameter freezing ([`params.ts`](params.ts)) works by exclusion: every
top-level key except `system`, `messages` and `stream` is copied, so any
parameter the runtime adds in future is frozen automatically.

Tools on A are the deterministic CLI builtins (`current_time`,
`recall_memories`, `recall_self`). B and B′ answer a tool call by replaying A's
recorded result for an identical call, and refuse (and count) anything else.

## Judge

[`judge.ts`](judge.ts) shuffles answers per prompt with a seeded RNG, labels them
`Response 1…N`, masks self-identification (motebit / Claude / ChatGPT /
vendor names, runtime-only markup) in every answer, and asks a judge model
(default `claude-opus-5-5`; it must differ from the model under test) for 1–10
scores on correctness, completeness, depth-appropriateness and clarity, plus
pairwise preferences. The rubric is [`rubric.md`](rubric.md).

## Report

`report.md` / `report.json`: per-category win rates; median and p90 TTFT and
total per route; motebit's pre-model overhead (`TurnLatency`: event query,
embed, pinned, retrieve); output-length ratio A/B; history retained by A vs.
dropped by trimming; and the three gap sections: **Motebit tax** (A vs B),
**Vendor product advantage** (C vs B), **User gap** (A vs C).

## Running

```bash
npx tsx scripts/bench/intelligence-parity/run.ts estimate               # no key, no spend
ANTHROPIC_API_KEY=… npx tsx scripts/bench/intelligence-parity/run.ts all \
  --model=claude-sonnet-5 --subset=long-context,memory --max-usd=2
```

In CI: **Actions → Intelligence-parity bench → Run workflow**
([`.github/workflows/intelligence-parity-bench.yml`](../../../.github/workflows/intelligence-parity-bench.yml)).
The results, judgments and report are uploaded as an artifact, and the report
is also written to the job summary.

**Spend guard.** The run is refused when its pre-flight estimate (tokens ×
the list prices in [`spend.ts`](spend.ts)) exceeds `--max-usd` (default 5),
and a live meter stops it before the next call once actual spend reaches it.
An unpriced model is refused, never priced at zero.

Self-tests (no network, fake transport under the real runtime):
`pnpm test:gates -- intelligence-parity`.

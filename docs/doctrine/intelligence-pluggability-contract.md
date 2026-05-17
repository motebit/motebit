# Intelligence pluggability contract

> **Intelligence is pluggable only when motebit's runtime invariants remain constant while prompt, tools, and context budgets adapt to the selected model. The runtime does not become smaller for smaller models. The prompt does.**

This is the connective doctrine between [`protocol-primacy.md`](protocol-primacy.md) (the WHAT: identity / governance / trust / receipts are protocol-level across all tiers) and [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md) (the discipline: runtime enforces, prompt teaches). Without this clause both doctrines hold individually and still admit the failure mode named below.

## The witnessed failure (2026-05-17)

A user on the On-Device tab with the shipped default `Llama-3.2-3B-Instruct-q4f16_1-MLC` (WebLLM, 4096-token context budget) sent `hello motebit`. WebLLM returned:

> `Something went wrong: Prompt tokens exceed context window size: number of prompt tokens: 8484; context window size: 4096`

The runtime assembled the same ~40KB system prompt path it sends to Sonnet (`packages/ai-core/src/prompt.ts`, 40,543 bytes). Sonnet's 200k window absorbs it invisibly; the 4k-window local model overflows by ~2×. Identical code path; identical prompt; different outcome only because cloud-class context budgets concealed the assumption that the prompt could be Sonnet-shaped.

The three settings tabs (Motebit Cloud / API Key / On-Device) sold pluggability as a primitive. The runtime confessed it isn't one. That dissonance is the marketing-vs-protocol drift `protocol-primacy.md` exists to catch.

## The principle

Intelligence is the parameter the user selects. Identity, governance, policy, receipts, sensitivity rules, tool dispatch, audit, and state are the **runtime invariants** that hold regardless of selection. Prompt verbosity, tool schema exposure, rendered state, rendered memory, and output reserve are the **adaptive surfaces** that the runtime tailors to the model the user picked.

Two failure shapes the doctrine forbids:

1. **Same prompt to every model.** A 40KB prompt sent to a 4k-window model. The runtime assumes Sonnet-class context and overflows on anything smaller. Witnessed 2026-05-17.
2. **A "lite motebit" for small models.** Tiering the runtime by model class — "small models get reduced governance / fewer invariants / weaker identity." Violates `protocol-primacy.md` (the protocol functions identically regardless of tier) and the **Capability rings** doctrine in [`CLAUDE.md`](../../CLAUDE.md) (Ring 1 is identical everywhere — runtime is Ring 1). A tiered runtime is two products masquerading as one.

The doctrinally clean response sits between them: **shrink the prompt, not motebit.** Same runtime invariants on every model; the prompt and rendered context adapt; the auto-router denies honestly when no adaptation fits.

## What is invariant; what is adaptive

| Invariant (runtime-enforced, constant across models)                                          | Adaptive (rendered, tailored per model)                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Sovereign identity ([`hardware-attestation.md`](hardware-attestation.md))                     | `promptVerbosity` (doctrine teaching density)           |
| Policy gates ([`security-boundaries.md`](security-boundaries.md))                             | `toolSchemaBudget` (schemas + descriptions exposed)     |
| Receipt signing ([`receipts-unified.md`](receipts-unified.md))                                | `renderedStateBudget` (state representation in context) |
| Sensitivity ceilings ([`retention-policy.md`](retention-policy.md))                           | `renderedMemoryBudget` (memory packing)                 |
| Tool dispatch + typed-truth fields ([`typed-truth-perception.md`](typed-truth-perception.md)) | `outputReserve` (max_tokens reserved for completion)    |
| Auditability + state ownership                                                                | Reasoning/CoT enablement (model-shape predicate)        |

The right-hand column is **representation**, not substance. The user's state is sovereign — what motebit packs into the prompt for the model's working memory is a presentation concern. Phrase as `renderedStateBudget`, never "compressed state" — state is identity-adjacent and a small-model motebit does not forget more than a large-model motebit. It renders less to the model per turn.

## The three commitments

### 1. Pre-flight admission (honest deny)

Before invoking a provider, the consumer measures the assembled prompt against the model's declared `contextWindow`. If the floor is unmet:

```
systemPromptBudget + toolSchemaBudget + renderedStateBudget + userMessageReserve + outputReserve > model.contextWindow
  → ContextWindowTooSmallError (typed-failure, calm-software surface)
```

This is a **new gate**, distinct from the auto-router's deny channel ([`auto-routing-as-protocol-primitive.md`](auto-routing-as-protocol-primitive.md)). Auto-routing deny answers "I cannot pick among catalog entries." Admission answers "the picked or configured model cannot carry the assembled prompt." Today's WebLLM path receives auto-router deny (single-model backend → empty catalog → deny), and the consumer **falls through to the configured model** anyway — that fall-through is the bug surface; admission closes it.

The deny is honest, not silent. The chrome surfaces "this model's context window is too small for the full motebit runtime — choose a larger model or switch to Motebit Cloud" via the existing `routingNarration` slot.

### 2. Model-aware prompt assembly

System prompt assembly takes the provider's capability profile as input:

- Doctrine teaching blocks (PERCEPTION_DOCTRINE et al.) can compress under a declared `promptVerbosity` budget without dropping wire-field semantics.
- Tool schemas can prune to the consumer's active tier set when total budget pressure demands it.
- `trimConversation` in `packages/ai-core/src/context-window.ts` reserves the system-prompt + tool budget instead of treating them as free.

The shape of "compression" is not arbitrary truncation — it is removing rule-shaped conformance clauses (per `runtime-invariants-over-prompt-rules.md`) while preserving the typed-truth wire-field teachings that the runtime cannot enforce. This is the same five-question audit, parameterized by model.

### 3. Move invariants out of the prompt (the standing fix)

The current `PERCEPTION_DOCTRINE` block is ~2,750 tokens. It is a `runtime-invariants-over-prompt-rules.md` violation independent of model size — Sonnet absorbs it invisibly; Llama-3.2-3B exposes it. The small-model failure is the **forcing function** that makes a long-standing prompt-density slip legible.

This commitment is **not deferred** as "future deep work" — it is the standing direction every prompt-clause audit moves toward. Each new typed-truth wire field + dispatch enforcement subtracts prose from the prompt. The eventual end state is a prompt that fits a 4k-window model with the full runtime intact, because the runtime carries what the prompt previously enumerated.

## Composition with sibling doctrines

This doctrine does not replace; it composes.

- **[`protocol-primacy.md`](protocol-primacy.md)** lists "On-device inference (WebLLM, Apple FM, MLX, local-server)" as a protocol-level property. This doctrine names the **how** that makes that listing structurally true rather than aspirational. Protocol-primacy says "it works for non-subscribers." This doctrine says "it works _identically_ for non-subscribers, including on a 3B model."
- **[`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md)** says the runtime should enforce; the prompt should teach. This doctrine adds: the prompt's _teaching density_ is an adaptive surface, not a constant. The runtime is constant; the teaching scales to what the model needs taught.
- **[`auto-routing-as-protocol-primitive.md`](auto-routing-as-protocol-primitive.md)** defines the dispatcher's deny channel for "no catalog entry satisfies constraints." This doctrine adds the **admission** deny for "the chosen model cannot carry the assembled prompt." Two deny semantics; one calm-software surface (the chrome's `routingNarration` slot).
- **Capability rings** in [`CLAUDE.md`](../../CLAUDE.md): "Ring 1 is about capability, not form — a surface may express the same capability through a different medium-native form." This doctrine extends: the same runtime expresses its invariants through a _differently-budgeted_ prompt without becoming a different runtime.
- **[`agility-as-role.md`](agility-as-role.md)**: model selection is the 8th instance of agility-as-role (after cryptosuite, license-floor, settlement-rail, inference-host, model-lab, jurisdiction, TaskShape). The intelligence is the parameter; the runtime is the role.

## Drift defense

Two complementary gates, sibling not collision:

| Gate                         | Lens                     | What it counts                               | Fires on                                           |
| ---------------------------- | ------------------------ | -------------------------------------------- | -------------------------------------------------- |
| `check-prompt-density` (#81) | Rule-clause accumulation | Bullet + numbered RULES lines in `prompt.ts` | Growth above measured BASELINE                     |
| `check-prompt-budget` (new)  | Byte/token weight        | Static prefix size of `prompt.ts`            | Growth above declared `SYSTEM_PROMPT_BUDGET_BYTES` |

Density catches conformance-shape drift (the runtime-invariants violation). Budget catches absolute-size drift (the pluggability violation). A prompt that adds three new bullets within the existing token budget trips density only. A prompt that adds 1,200 tokens of non-bullet prose trips budget only. Both gates are needed because both failure modes exist.

The gate is a smoke alarm in the same shape as `check-prompt-density` — bumping the baseline IS the doctrine moment. The commit that bumps it names what crossed the threshold and why.

## Worked example — the WebLLM Llama-3.2-3B path

Pre-doctrine (witnessed 2026-05-17):

1. User opens On-Device tab, default selection `Llama-3.2-3B-Instruct-q4f16_1-MLC` (WebLLM ships a `context_window_size: 4096` default).
2. User sends `hello motebit`.
3. `WebApp.sendMessageStreaming` constructs the full `ContextPack` and forwards to runtime.
4. `buildSystemPrompt` assembles ~6.5k tokens of static prefix + ~2k tokens of tools + ~1k tokens of packed context.
5. WebLLM rejects at 8,484 tokens vs 4,096 window. User sees a developer-shaped error message.

Post-doctrine:

1. Same selection. The WebLLM engine is initialized with `context_window_size: 16384` (model supports up to 128K; WebLLM's default was the cap, not the model's).
2. `ProviderCapability.contextWindowTokens: 16384` declared on the capability profile.
3. WebApp performs admission: assembled prompt + reserve ≤ 16384 → admitted.
4. The runtime proceeds. Same invariants as Sonnet — identity, policy, receipts, sensitivity, tool dispatch are byte-identical. The model has less doctrine-prose to absorb, but the runtime is constant.
5. If a future model declares `contextWindowTokens: 4096` and the floor isn't met, admission emits typed-failure → chrome renders calm-software message → user picks a larger model.

## What this doctrine deliberately does NOT specify

- **The minimum context-window floor.** Today's floor is a function of `prompt.ts` size + tool count + state pack. As `PERCEPTION_DOCTRINE` shrinks (commitment 3), the floor drops. Naming a fixed number here would ossify a soft-decay target.
- **Per-model prompt variants.** Compression is not "different prompts per model." It is **one prompt assembly function** parameterized by model capability. Variants would re-introduce the lite-motebit trap.
- **Routing-policy for admission failure.** Whether the consumer should fall back to a different provider when admission fails (e.g., automatically swap to Cloud) is a consumer-side policy decision, not a doctrine-level law. The doctrine guarantees the typed-failure exists; what to do with it belongs to the consumer.

## Cross-cuts

- [`protocol-primacy.md`](protocol-primacy.md) — the constitutional invariant. This doctrine is the structural floor under its on-device claim.
- [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md) — the discipline. This doctrine parameterizes the discipline by model.
- [`auto-routing-as-protocol-primitive.md`](auto-routing-as-protocol-primitive.md) — the deny channel. Admission is a sibling deny semantic.
- [`agility-as-role.md`](agility-as-role.md) — model selection as the 8th role-instance.
- [`hardware-attestation.md`](hardware-attestation.md) — same shape at the identity layer (hardware capability is additive; software identity is the floor).
- _feedback_sovereignty_orthogonal_ — tier and provider mode are orthogonal. This doctrine extends: tier and **model size** are orthogonal too.
- _feedback_intelligence_commodity_ — don't sell intelligence as the product. The runtime is the product; intelligence is the parameter.

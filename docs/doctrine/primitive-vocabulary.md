# Primitive vocabulary

Motebit's doctrine corpus uses different primitive vocabularies in different documents — by design. Each vocabulary serves a distinct communicative purpose: external positioning, architectural enumeration, comparative explanation, hero compression, and metabolic distillation. The vocabularies coexist legitimately; the drift problem is not their existence but their lack of cross-reference.

This memo names the vocabularies, locks the cross-translations, and identifies the unresolved taxonomy questions for future arcs to settle. It is the discoverability anchor a contributor reads first when asking "what are motebit's primitives?"

## Why this memo exists

Without an explicit vocabulary map, every reader reconstructs the cross-translations from scratch. The 2026-05-17 founder-site session is the witnessed cost: multiple hours adjudicating "which primitive list is canonical" because three different external reviewers each pattern-matched a different motebit vocabulary and proposed a different count (5 / 6 / 7). The doctrine had already answered the count question — at `delegation.md` line 73 — but the answer was discoverable only by reading that one line in that one doc.

The motebit corpus has at least eight enumerated primitive lists across CLAUDE.md, README.md, `delegation.md`, `the-stack-one-layer-up.md`, `apps/docs/content/docs/operator/architecture.mdx`, and the cross-references that thread between them. They do not contradict each other — they serve different purposes. But the relationship was implicit, and implicit relationships drift under enough editorial pressure.

This memo makes the relationship explicit. When a future contributor (or external reviewer, or future founder-surface artifact) asks "what are motebit's primitives?", they read this first, then follow links to the purpose-shaped vocabulary they need.

## The five vocabularies, by purpose

### 1. Public positioning (5 — canonical for external surface)

> **identity, trust, delegation, receipts, settlement**

The five primitives motebit publicly positions itself around. Established in [`delegation.md`](delegation.md) § "Why 'delegation' is the right tagline word" and locked by line 73: _"not because the positioning sentence has six concepts, but because delegation is the architectural relationship the other five primitives instantiate."_ This is the vocabulary that ships in:

- Public taglines, pitches, and external founder-surface artifacts
- Investor materials, NIST submissions, talks, podcasts
- The README hero positioning sentence (when next updated)

Use this vocabulary when answering: _"What does motebit let an agent do?"_

### 2. Architectural enumeration (5 static + 1 dynamic = 6 — for internal contributor-facing)

> **identity, trust, receipts, settlement, policy** (5 static surfaces)
> **delegation** (1 dynamic connector)

The full architectural inventory of motebit's primitives, established in [`delegation.md`](delegation.md) § "The spine" and again at line 73. The five static surfaces compose into a system via delegation, the relationship that runs through them. Policy is a static surface — its package, `@motebit/policy`, exists — but it is the scope-of-delegation, not a peer to delegation. The doctrine is explicit at `delegation.md` line 21: _"Policy is one slice of what delegation authorizes — policy is the scope of a delegation, not the delegation itself."_

Use this vocabulary when answering: _"What surfaces does the motebit protocol expose?"_

The difference between vocabulary 1 and vocabulary 2 is not a contradiction — it is a register transition from internal architecture to external communication. Policy is named in vocabulary 2; in vocabulary 1, policy is folded into delegation's scope-bounded language. Both are correct in their context.

### 3. Comparative — "the stack, one layer up" (5)

> **identity, memory, capability, autonomous execution, governance**

Established in [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md). The vocabulary motebit uses to compare itself against hosted agent platforms — Claude Code, Cursor, Replit Agent, ChatGPT tasks, OpenAI Operator. Each entry maps to "the same primitive every agent host eventually exposes," with motebit's implementation differing on who owns the identity layer (vendor account vs cryptographic keypair).

Use this vocabulary when answering: _"How is motebit different from a hosted agent platform?"_

The comparative vocabulary contains primitives (memory, capability, autonomous execution) that do NOT appear in vocabularies 1 or 2. Those primitives exist in motebit's implementation — memory in `@motebit/persistence`, capabilities in `@motebit/skills` and tool definitions, autonomous execution in `runtime.consolidationCycle()` — but they sit in a different doctrinal register than the positioning primitives. See § "Unresolved questions" below.

### 4. Hero compression (3 — the deepest single-line summary)

> **identity, trust, governance**

Established in [CLAUDE.md](../../CLAUDE.md) "The three things no one else is building together" and the [`apps/docs` operator-canonical caption](../../apps/docs/content/docs/operator/architecture.mdx) (the architecture.mdx hero). The most compressed motebit positioning — when only three nouns fit, these are the three.

Use this vocabulary when answering: _"What's the one-breath pitch?"_

The hero compression uses `governance` (not `policy`, not `delegation`) because at this compression rate the membrane concept is the load-bearing word. Translation to vocabulary 1 or 2 is provided in the translation table below.

### 5. Metabolic enzymes (4 — for the metabolic-principle expression)

> **identity, memory, trust, governance**

Established in [CLAUDE.md](../../CLAUDE.md) § "Metabolic" principle and `architecture.mdx` line 252. The four "enzymes" motebit builds (versus the "glucose" of solved-problem adapters like VAD, STT, embeddings, inference). This vocabulary lives inside the metabolic-principle doctrine and is not a public positioning shape — it answers a build-vs-absorb question, not a "what does motebit do" question.

Use this vocabulary when answering: _"What does motebit build, and what does it absorb from the ecosystem?"_

## Translation table

The corpus uses different words for the same concept across documents. Translation is canonical when crossing doctrinal layers; preserve the source-doc's word within a single document for register consistency. Do not "fix" one document to match another — they serve different purposes.

| Concept                                     | Canonical variants                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy (the membrane / scope-of-delegation) | `policy` (delegation.md, CLAUDE.md droplet) ≡ `governance` (architecture.mdx, README table, CLAUDE.md three-things) ≡ `policy gate` (CLAUDE.md droplet) ≡ `boundary policy gate` (architecture.mdx)                  |
| Receipts (the signed record)                | `receipts` (delegation.md, the-stack-one-layer-up.md) ≡ `proof` (README table) ≡ `signed-receipt trust ledger` ≡ `verifiable credentials` (architecture.mdx)                                                         |
| Delegation (the authority relationship)     | `delegation` is canonical per [`delegation.md`](delegation.md). Superseded `permissions` (deprecated — do not use in new artifacts). The relationship-shaped primitive that turns the static surfaces into a system. |
| Trust (the reputation primitive)            | `trust` (consistent across the corpus)                                                                                                                                                                               |
| Identity (the sovereign root)               | `identity` (consistent across the corpus); never compress to `id` or `auth`                                                                                                                                          |
| Settlement (the value-resolution primitive) | `settlement` (consistent across the corpus)                                                                                                                                                                          |

## Unresolved questions

Three primitives appear in the comparative vocabulary (vocabulary 3) but not in the positioning or architectural vocabularies (1 + 2). The doctrine has not adjudicated whether these are:

(a) Real motebit primitives that deserve elevation to the positioning / architectural vocabulary
(b) Implementation surfaces that exist but are not primitives in the positioning sense
(c) Comparative-only labels that exist to map motebit onto hosted-platform taxonomy

The three:

1. **Memory.** Real motebit surface (`@motebit/persistence`, sensitivity-aware memory graph with `none / personal / medical / financial / secret` levels). Could be elevated to architectural primitive — but the positioning sentence would then drift from 5. Open question.

2. **Capability.** Real motebit surface (`@motebit/skills`, tool definitions, MCP integration). The "capability bundle" primitive named in [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md) § "Where motebit has a gap" as a named gap — the task-scoped capability bundle that loads on demand and unloads when done is not yet a first-class motebit primitive. Open question, partly because the surface itself is partly-built.

3. **Autonomous execution.** Real motebit surface (`runtime.consolidationCycle()`, the proactive loop). Doctrinally framed by [`proactive-interior.md`](proactive-interior.md). Could be promoted; isn't, currently.

These questions belong to a future arc, not this memo. This memo locks vocabularies 1–5 as they exist; the elevation question is intentionally deferred to avoid the editorial-residue trap of "shipping a vocabulary memo + a taxonomy reorg in the same arc."

## Sibling-audit discipline

When writing new artifacts — doctrine, README updates, public positioning, founder-surface material, external pitches, investor decks, talks, NIST followups — follow this checklist:

1. Identify which vocabulary serves the artifact's purpose (1, 2, 3, 4, or 5).
2. Use that vocabulary's exact word choices for primitive references in that artifact.
3. If a sibling doc uses a different word for the same concept, do not "fix" it — different docs serve different purposes. Cross-translation is a feature, not a bug.
4. If multiple primitives could fit and the artifact mixes vocabularies, prefer vocabulary 1 (canonical positioning).
5. If the artifact is internal contributor-facing (PR descriptions, doctrine memos, code comments), use vocabulary 2 (architectural enumeration).

## What this memo is not

- **Not a rename.** Existing docs keep their vocabulary; this memo names the cross-translations so future readers can navigate them.
- **Not a deprecation.** None of the five vocabularies is wrong; each serves a purpose. The only deprecated term is `permissions` (superseded by `delegation` per delegation.md).
- **Not the elevation answer for memory / capability / execution.** That arc is deferred. This memo locks what exists; it does not adjudicate what should be added.
- **Not a replacement for the canonical doctrines.** `delegation.md`, `the-stack-one-layer-up.md`, and the others remain canonical for their content. This memo is the index that points to them.

## Cross-cuts

- [`docs/doctrine/delegation.md`](delegation.md) — the doctrine that names the canonical positioning 5-tuple; line 73 is the load-bearing sentence (_"not because the positioning sentence has six concepts"_).
- [`docs/doctrine/the-stack-one-layer-up.md`](the-stack-one-layer-up.md) — the comparative vocabulary, where memory / capability / autonomous-execution appear as primitives.
- [`README.md`](../../README.md) — the hero comparison table uses its own 5-vocabulary (identity, memory, trust, governance, proof); may be re-aligned in a future arc to use vocabulary 1.
- [`apps/docs/content/docs/operator/architecture.mdx`](../../apps/docs/content/docs/operator/architecture.mdx) — operator-canonical surface; uses the 3-vocabulary in the hero caption.
- [`docs/doctrine/protocol-primacy.md`](protocol-primacy.md) — the constitutional invariant; identity, trust, and governance are protocol-level (uses vocabulary 4 / hero compression).
- [`docs/doctrine/registry-pattern-canonical.md`](registry-pattern-canonical.md) — the lattice's unit cell; orthogonal to this memo (registries are typed vocabularies for wire-format values; this memo is the prose-vocabulary index).

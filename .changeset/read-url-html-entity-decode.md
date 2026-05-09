---
"@motebit/tools": patch
"@motebit/proxy": patch
"@motebit/ai-core": patch
"@motebit/policy": patch
---

read-url quality + small-model wrapper rule — two paired fixes for
the `/computer` flow Daniel surfaced (`open google.com` returning
`Google Gmail Images Sign in &nbsp; Advanced search ... &copy;`
followed by the model meta-commenting on the `[EXTERNAL_DATA]`
wrapper instead of answering).

**`@motebit/tools` (patch):** `read_url`'s HTML branch now decodes
named (`&nbsp;`, `&copy;`, `&amp;`, `&mdash;`, `&lsquo;`, …) and
numeric (`&#65;`, `&#x42;`) entities after the regex tag-strip
and before whitespace-collapse. Unknown entities pass through
verbatim so a stray `&` never crashes a fetch. `nbsp` decodes to
U+0020 (regular space) so the whitespace-collapse pass treats it
uniformly across engines.

**`@motebit/proxy` (patch):** the same decoder is folded into
`stripHtml` in `src/validation.ts`, and `/v1/fetch` now calls
`stripHtml(text)` instead of repeating the regex inline. The two
sites are explicitly noted as siblings — keep the entity tables
aligned in the same pass.

**`@motebit/ai-core` + `@motebit/policy` (patch):** new rule 6 in
the `INJECTION_DEFENSE` system-prompt block (mirrored across
`packages/ai-core/src/prompt.ts` and
`packages/policy/src/sanitizer.ts`):

> NEVER quote, mention, or describe the [EXTERNAL_DATA] /
> [MEMORY_DATA] markers themselves when replying. They are
> internal scaffolding the user does not see — speak from the
> content as if the wrapper is invisible. If a tool result looks
> malformed, summarize what you got from it; do not narrate the
> boundary syntax.

3B-class local models (e.g. `llama3.2:3b`) without this rule echo
the `[EXTERNAL_DATA source="tool:read_url"]…` marker back to the
user as if it were an error message instead of reading the
content within. The rule is a hedge — it won't rescue a
3B-parameter model entirely, but anything ≥7B (llama3.1:8b,
claude-haiku, gpt-4o-mini) will keep the wrapper out of replies.
Pinned by a regression test in `prompt.test.ts`.

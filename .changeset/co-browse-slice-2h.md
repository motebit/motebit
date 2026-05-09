---
"@motebit/protocol": minor
---

Co-browse Slice 2h — `read_page`, the first ax-tier tool. Fills the
documented middle slot of the hybrid-engine cost hierarchy
(`api → ax → pixels` per `tool-mode.ts`). Until this slice no tool
declared `mode: "ax"`; the AI's only option against an open browser
session was a pixel screenshot (~30k tokens, crosses the
whole-screen privacy surface).

**`ReadPageResult` wire format** — new exported type carrying the
structured page observation: `url`, `title`, body `text` (bounded;
`text_truncated: bool` flags the cap), `headings: ReadPageHeading[]`
in document order (h1-h6 + visible text), `links: ReadPageLink[]`
(visible label + absolute href). Plus `kind: "read_page"`,
`session_id`, `extracted_at`. Closed shape so sandbox / dispatcher
/ runtime / ai-core / tools all agree without drift.

Server-side bounds (in `services/browser-sandbox`): `text` capped
at 8KB UTF-8 (≈2K tokens vs ~30K for a screenshot), `headings`
and `links` capped at 100 entries each. Defends the AI context
against pathological pages.

**Spec update** — `spec/computer-use-v1.md` §4 codifies `read_page`
as a `SHOULD register` companion to `computer` for surfaces with
a `virtual_browser` embodiment. The MUST-NOT-leak-pixels invariant
is reaffirmed: page text crosses the AI boundary subject to the
existing sensitivity + outbound gates that govern `read_url` /
`web_search`; **screenshot bytes still never leave the device for
external AI**.

Doctrine: `CLAUDE.md` Principle 96 (Hybrid engine, structural
preference) — the registry sort `api → ax → pixels` already ranked
`mode: "ax"` between `mode: "api"` and `mode: "pixels"`, but the
middle tier was empty. `read_page` is its first tenant; the AI's
default tool selection now lands on structured text when "what's
on the page" is the question, falling back to pixels only when
visual context is genuinely required.

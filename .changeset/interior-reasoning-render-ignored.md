---
"@motebit/ai-core": minor
"@motebit/runtime": minor
"@motebit/web": patch
---

Interior reasoning render (Inc 2) — the captured `AIResponse.reasoning` now reaches the owner. A new `reasoning` stream chunk (`AgenticChunk` in ai-core, `StreamChunk` in runtime) carries the trace from the loop through the runtime's pass-through to surfaces; the web chat renders it as a **calm, opt-in, collapsed `<details>` disclosure** attached to the assistant message. This is the `mind` register's correct flat-surface form: mind-mode content is hidden on the slab plane by doctrine (`motebit-computer.md`) and "lives in chat" — so reasoning is legible to the sovereign when they choose to expand it (`felt-interior.md`), never a loud panel, never the visible reply text, and rendered as ephemeral DOM (`textContent`, not persisted/synced — interior-only holds). Fail-closed: no reasoning → no chunk → no disclosure. Web-first; mobile/desktop/spatial fan-out to follow.

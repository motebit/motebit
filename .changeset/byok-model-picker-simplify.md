---
"@motebit/web": patch
"@motebit/proxy": patch
---

byok-model-picker-simplify — collapse the BYOK Model field's
seed-then-live-fetch race into a single static `<select>` and
delete the dead proxy `/v1/models` route.

**The bug Daniel surfaced.** On the Settings → Intelligence pane
in production, opening the BYOK Anthropic Model dropdown showed
the seed list on the first click, then the live-fetched list on
the second click. The Model field was the only widget in the
modal using `<input list="…">` + `<datalist>` — every other
picker (Motebit Cloud Model, On-Device WebLLM/Ollama, TTS Voice)
was already a `<select>`. The native datalist also wouldn't
refresh while open, so the user had to close and reopen to see
the live list.

**Two model-discovery paths existed for one widget:**

1. Static seed (`seedProviderModelLists`) — instant, hardcoded
   list (Opus 4.7 / Sonnet 4.6 / Haiku 4.5 from sdk + OpenAI/
   Google manual lists).
2. Live fetch (`fetchModelsForProvider`) — debounced 500ms
   after API-key input, hit motebit-proxy `/v1/models?provider=
…` with the user's key, overwrote the datalist with the
   real provider list (which can include older models the key
   can call).

The race plus the unstyleable native datalist made the field
read as the cheap thing in the room — and the live-fetch path
covered <1% of intent (most users want the recommended model,
not their account's full list of legacy IDs).

**Fix.** Replace the three `<input list>` blocks with the same
custom-styled `<select>` shape the rest of the Intelligence pane
already uses (custom chevron, `--bg-input` / `--border-medium`,
identical to the Motebit Cloud Model field):

- Anthropic: Opus 4.7 / **Sonnet 4.6** (selected) / Haiku 4.5
- OpenAI: **GPT-5** (selected) / GPT-4.1 / GPT-4o / o3-mini
- Google: Gemini 2.5 Pro / **2.5 Flash** (selected) / 2.0 Flash

Sole consumer of motebit-proxy `/v1/models` was the live-fetch
path that's now removed, so the proxy route
(`services/proxy/src/app/v1/models/route.ts`) is deleted in the
same pass — surfaces that need provider model discovery (LM
Studio, Ollama, mobile) hit `/v1/models` on the local server
directly, never through the motebit proxy.

**Net diff.** Settings.ts loses ~95 lines (entity table,
`writeDatalist`, `seedProviderModelLists`, `fetchModelsForProvider`,
`modelFetchTimer`, three input-listener blocks, three call sites
in load logic, and the now-unused `ANTHROPIC_MODELS` /
`PROXY_BASE_URL` imports). The proxy loses ~140 lines (the dead
route). HTML loses ~30 lines (three `<datalist>` blocks). Single
source of truth, no race, visually consistent.

---
"motebit": patch
---

`/model` accepts what the local server actually serves: ollama's live catalog returns tagged ids (`llama3.2:latest`) while users — and motebit's own defaults — use bare family names, so `/model qwen3` and `/model llama3.2` were refused as "not served" on a machine that served both (witnessed on the 1.12.0 live pass). Live-catalog membership now normalizes the `:latest` form, and the active-model marker in the `/model` list matches across the same normalization.

---
"motebit": patch
---

The CLI's model defaults now consume the sdk registry as single source (`defaultModelForProvider` restated literals; a refresh in one place drifted the other), so the local-server first-run default becomes `qwen3` — a 2026 tool-capable model instead of a 2024 3B one. `/model` gains `qwen3` and `gpt-oss` aliases; refusal teach lines name the current default.

---
"@motebit/sdk": minor
---

New capability-tier axis on the model registry: `modelCapabilityTier(model)` returns `"frontier" | "capable" | "minimal"` from family knowledge plus embedded parameter sizes (ollama `:NNb` tags and dash-form ids like `Llama-3.2-3B-Instruct…`), with `unknown → "capable"` so registry lag never lobotomizes a new model. The runtime keys money-tool exposure on it (#501); nothing here gates admission — a minimal model remains a legitimate sovereign choice.

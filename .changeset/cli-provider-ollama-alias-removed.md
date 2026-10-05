---
"motebit": major
---

The `--provider ollama` flag alias is removed (deprecated since 1.0.0, removal promised for 2.0.0). `motebit --provider ollama` now exits at startup with `The "ollama" provider alias was removed in motebit 2.0.0. Use --provider local-server …` instead of silently mapping to `local-server`. The no-API-key hint and the `--help` provider list now name `--provider local-server`.

A persisted `default_provider: "ollama"` in `~/.motebit/config.json` is unaffected: that read-time migration is permanent and still loads as `local-server`.

## Migration

- Replace `--provider ollama` with `--provider local-server` in scripts, aliases and service units. The behaviour is identical: the alias always resolved to `local-server` (Ollama, LM Studio, llama.cpp, or any OpenAI-compatible local server).
- No config change is needed.

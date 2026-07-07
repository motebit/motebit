---
"@motebit/sdk": minor
---

`modelVendorHint` + `providerAcceptsModel` — provider ↔ model pre-flight admission in the canonical model registry (intelligence-pluggability contract, commitment 1). Born live 2026-07-06: `--provider anthropic` with a config-resident `default_model: llama3.2:latest` composed an illegal pairing that failed opaquely at the first API call. The predicate refuses ONLY known cross-vendor mismatches (registry membership + naming signatures); unknown ids stay permissive so new releases never brick startup; `local-server` accepts anything; the proxy accepts its routed cloud vendors. The CLI consumes it two ways: config residue yields politely (stale `default_model` from a previous provider era auto-resolves to the chosen provider's default, with a visible note), and explicit `--provider`/`--model` contradictions fail loud at startup naming both.

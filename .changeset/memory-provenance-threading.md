---
"motebit": patch
---

Memory provenance threading (`docs/doctrine/memory-provenance.md`): every memory-formation call site now declares a `MemorySource`, enforced at compile time by `AttributedMemoryCandidate`. In the CLI: the daemon's MCP `storeMemory` wiring stamps the literal `peer_agent` after governance (an external caller can never self-declare a trusted provenance tier), and the scheduler's plan-reflection learnings + goal-outcome memories stamp `agent_inferred`. New `memory_nodes.source` / `source_turn_id` columns land via persistence migration v40; legacy rows read back as provenance `unknown` — never a fabricated default.

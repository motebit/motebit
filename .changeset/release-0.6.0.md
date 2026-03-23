---
"@motebit/sdk": minor
"@motebit/verify": minor
"create-motebit": minor
"motebit": minor
---

v0.6.0: zero-dep verify, memory calibration, CLI republish

- @motebit/sdk: Core types for the motebit protocol — state vectors, identity, memory, policy, tools, agent delegation, trust algebra, execution ledger, credentials. Zero deps, MIT
- @motebit/verify: Verify any motebit artifact — identity files, execution receipts, verifiable credentials, presentations. One function, zero runtime deps (noble bundled), MIT
- create-motebit: Scaffold signed identity and runnable agent projects. Key rotation with signed succession. --agent mode for MCP-served agents. Zero runtime deps, MIT
- motebit: Operator console — REPL, daemon, MCP server mode, delegation, identity export/verify/rotate, credential management, budget/settlement. BSL-1.1 (converts to Apache-2.0)
- Memory system: calibrated tagging prompt, consolidation dedup (REINFORCE no longer creates nodes), self-referential filter, valid_until display filtering across all surfaces
- Empty-response guard: re-prompt when tag stripping yields no visible text after tool calls
- Governor fix: candidate modifications (confidence cap, sensitivity reclassification) now respected in turn loop

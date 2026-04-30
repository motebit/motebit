---
"@motebit/protocol": minor
"@motebit/runtime": patch
"@motebit/tools": patch
"@motebit/mcp-client": patch
---

Privacy doctrine — sensitivity-aware tool dispatch (v2 of sensitivity routing). Closes the sibling boundary v1 left open: AI provider calls were gated 2026-04-30 in commit 4ed47f42, but outbound tool calls (`web_search`, `read_url`, `delegate_to_agent`, MCP tools) still ran regardless of session sensitivity. Per the sibling-boundary rule in CLAUDE.md ("when you fix one boundary, audit all siblings in the same pass"), v2 closes the tool-call axis.

**The completion shape:**

`@motebit/protocol` — `ToolDefinition` gains `outbound?: boolean`. Independent of `riskHint` (which captures local risk: file overwrite, irreversible side effect); `outbound` captures the network axis. Default `false`/absent ≡ local — matches the pre-existing builtin set (`read_file`, `recall_memories`, `current_time`).

`@motebit/tools` — `webSearchDefinition` and `readUrlDefinition` get `outbound: true`. Local builtins stay default.

`@motebit/mcp-client` — `discoverTools` sets `outbound: true` on every imported tool (MCP tools execute against a remote server by definition).

`@motebit/runtime` — `interactive-delegation.ts` sets `outbound: true` on the `delegate_to_agent` tool registration. The `loopDeps.tools` assignment is now wrapped through a new `wrapToolRegistryForSensitivity` private method that intercepts `execute(name, args)`: when the tool's `outbound` flag is true, it calls `assertSensitivityPermitsOutboundTool` (which delegates to `assertSensitivityPermitsAiCall` — same predicate that gates AI provider calls). Same fail-closed contract: medical/financial/secret session sensitivity AND non-sovereign provider → `SovereignTierRequiredError` thrown before the underlying handler runs.

**Drift gate (`check-sensitivity-routing` extension):** the gate now also verifies that `wrapToolRegistryForSensitivity` is defined on the runtime AND that the `loopDeps.tools` assignment routes through it. A refactor that "simplifies" by removing the wrap re-opens the privacy hole — caught at CI.

**The principle generalized.** "Medical/financial/secret never reach external AI" was originally framed around AI providers. The architectural framing is broader: the doctrine is about any byte-leaving-the-device boundary. AI provider calls (v1) and outbound tool calls (v2) are two instances of the same boundary; the gate predicate is shared. Future ships extending the same predicate to other outbound surfaces (e.g., relay-side delegation gating, direct webhook tools) compose cleanly — same flag, same gate, same error type.

Tests: 13 cases now (added 2 covering local-tool dispatch + outbound-tool gate predicate). All passing. `pnpm check` 56/56 drift gates green; `pnpm check-gates-effective` 56/56 proven; existing CLI tests pass through unchanged (the wrap is transparent for non-outbound dispatch).

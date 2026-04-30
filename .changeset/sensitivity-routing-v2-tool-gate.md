---
"@motebit/protocol": minor
---

Privacy doctrine — sensitivity-aware tool dispatch (v2 of sensitivity routing), protocol-surface half.

`ToolDefinition` gains `outbound?: boolean`. Independent of `riskHint` (which captures local risk: file overwrite, irreversible side effect); `outbound` captures the network axis. Default `false`/absent ≡ local — matches the pre-existing builtin set (`read_file`, `recall_memories`, `current_time`).

**The principle generalized.** "Medical/financial/secret never reach external AI" was originally framed around AI providers. The architectural framing is broader: the doctrine is about any byte-leaving-the-device boundary. AI provider calls (v1) and outbound tool calls (v2) are two instances of the same boundary; the gate predicate is shared. Future ships extending the same predicate to other outbound surfaces (e.g., relay-side delegation gating, direct webhook tools) compose cleanly — same flag, same gate, same error type.

Backwards-compatible. Tools that don't set `outbound` default to `false` (local). The runtime/tools/mcp-client consumer wiring ships in the sibling `sensitivity-routing-v2-tool-gate-ignored.md` changeset.

---
"@motebit/protocol": minor
---

`ToolResult` gains optional `reason?: string` — a structured
failure category set by handlers that wrap a typed error carrying
its own `reason` field (e.g. `ComputerDispatcherError` from
`@motebit/runtime`). Lets downstream consumers route on category
without parsing the human-readable `error` text.

v1 carrier: `not_in_control` — Slice 1 co-browse gate denial.
The runtime's slab projection uses the structured field to
suppress a body `tool_call` item; the slab control band
(Slice 2b doorbell) is the canonical surface for the resolution
affordance, and a duplicate body card competes for attention.

Replaces the earlier string-prefix probe on the failure message,
which silently broke when `@motebit/tools`'s `computer` handler
started wrapping the error as `"computer: ${msg}"` (witnessed
2026-05-08: a wall of denial text on the slab body next to an
already-shown Grant/Deny band). Doctrine pre-authorized the
graduation in `motebit-runtime.ts` §"if more reasons land later,
graduate to a structured `failure_reason` field rather than
extending the prefix list."

Open string-literal — additive. New reason categories land
without breaking existing consumers (route on values you care
about; ignore the rest).

Wire path: `ComputerDispatcherError(reason, msg)` →
tools-package handler's catch (lifts `.reason` onto the
envelope) → ai-core's `done` chunk
(`AgenticChunk.tool_status.reason`) → runtime's
`StreamChunk.tool_status.reason` → `projectSlabForTurn`'s
`isControlStateFailure` check.

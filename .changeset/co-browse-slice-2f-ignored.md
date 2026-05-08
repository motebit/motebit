---
"@motebit/runtime": minor
"@motebit/tools": patch
---

Co-browse Slice 2f — runtime projection respects `slabProjection:
"none"`; `request_control` declared as state chrome.

**Runtime** (`projectSlabForTurn`) — at the `tool_status: "calling"`
branch, check `chunk.slabProjection === "none"` before opening a
slab item. State-chrome tools skip the projection entirely; their
visible representation is a different surface (the slab control
band for `request_control`). The matching `done` chunk has nothing
to dissolve because nothing was opened. `StreamChunk.tool_status`
gains `slabProjection?: "none" | "tool_call"` (mirrors the
ai-core `AgenticChunk.tool_status.slabProjection` plumbing).

**Tools** — `requestControlDefinition` declares `slabProjection:
"none"`. Without this, the runtime opened a generic `tool_call`
slab item showing "REQUEST_CONTROL / calling…" — a duplicate
empty-looking card that competed with the slab control band's
Grant/Deny buttons. With this, the band IS the canonical surface
for the consent transition.

Doctrine: motebit-computer.md — slab content vs slab chrome.
Tools that author chrome MUST NOT also project as content.

This is the last cleanup before "Chrome inside the slab" reads
honest end-to-end.

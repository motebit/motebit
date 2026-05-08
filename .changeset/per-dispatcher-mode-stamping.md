---
"@motebit/protocol": minor
---

`ToolDefinition.embodimentMode` lands as the per-dispatcher embodiment
stamp the slab uses to pick the correct mode contract per surface.

The wire-format problem this closes: the `computer` tool name is
shared between cloud-browser (apps/web → CloudBrowserDispatcher,
isolated Chromium) and OS-drive (apps/desktop → Tauri Rust bridge,
real OS) — two physically distinct dispatchers, two different
embodiments per `motebit-computer.md` §"Embodiment modes" (cloud →
`virtual_browser`, desktop → `desktop_drive`). `tool-policy.ts` is
name-keyed and surface-blind, so a single mode would mis-tag one
surface. The previous safe-floor (`tool_result`) under-claimed the
embodiment for both.

Resolution: ToolDefinition now carries an optional `embodimentMode`
field. Each dispatcher's registration site stamps its own
embodiment (`apps/web/src/computer-tool.ts` →
`embodimentMode: "virtual_browser"`; `apps/desktop/src/computer-tool.ts`
→ `embodimentMode: "desktop_drive"`). ai-core forwards the mode on
every `tool_status` chunk; the runtime's `projectSlabForTurn` picks
`chunk.mode` over `tool-policy.ts`'s generic floor.

The string union itself (`"mind" | "tool_result" | "virtual_browser"
| "shared_gaze" | "desktop_drive" | "peer_viewport"`) is canonically
declared as `EmbodimentMode` in `@motebit/render-engine`. Typed here
as `string` to avoid a protocol→render-engine layer break — promoting
the type into `@motebit/protocol` is a separate slice the doctrine
names as deferred.

Doctrine: `motebit-computer.md` §"v1 implementation status —
Deferred to v1.5+: per-dispatcher mode stamping" — landed as v1.1
of the virtual_browser arc.

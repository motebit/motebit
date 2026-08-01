---
"motebit": patch
---

The runtime-host election root now follows the config root (#512): with `MOTEBIT_CONFIG_DIR` set, the coordinator socket and lockfile live inside it instead of always at `~/.motebit/` — a sandboxed or scaffolded instance is a different sovereign and elects its own coordinator, never silently attaching its chat turns to the user's live runtime under the user's identity. The normal case is byte-identical. Unix socket paths past the OS `sun_path` limit (~104 chars) now fail loud at construction naming the repair (a shorter config dir), and the election-failure message distinguishes bind problems (path/permissions/stale socket) from attach problems (incompatible coordinator) instead of blaming the wrong one.

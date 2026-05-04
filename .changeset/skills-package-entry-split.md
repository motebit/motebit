---
"motebit": patch
---

Internal: re-route `NodeFsSkillStorageAdapter` + `resolveDirectorySkillSource` imports through `@motebit/skills/node-fs` instead of the top-level `@motebit/skills` entry. The CLI's runtime / slash-commands / `motebit skills *` subcommands all consume the same Node-fs adapter; the import path move is mechanical, no behavior change.

Why the entry-point split: `@motebit/skills`'s top-level index re-exported the Node-fs adapter, which destructures `node:fs` eagerly at module evaluation. Tree-shaking handles it in production builds, but vite dev mode evaluates ES modules eagerly — any browser-side consumer that imports `SkillRegistry` from the top-level entry triggered a `node:fs` stub access and crashed the page before the renderer's animation loop started. The hot-fix splits the package so the bare entry is browser-safe and Node-fs ships behind `/node-fs`. CLI is the only published consumer affected; the rest of the consumers are private workspace packages.

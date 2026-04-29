---
"@motebit/desktop": patch
---

Skills v1 phase 4.2 — desktop renderer for installed skills, behind a Node sidecar that owns all signature verification, fs writes, and trust grants.

The Tauri webview never sees envelope bytes, body bytes pre-decode, or signature material. It calls nine `skills_*` IPC commands; the Rust host forwards them to a single Node child that wraps `@motebit/skills`. The webview only ever holds display-grade `SkillSummary` / `SkillDetail` records.

Why the sidecar shape (not a Tauri-fs adapter in the renderer): install is permissive per `spec/skills-v1.md` §7.1 — motebit accepts arbitrary third-party `SKILL.md` content. Rendering arbitrary attacker-controlled content in a context that ALSO has fs-write + crypto-verify collapses three privilege concerns into one process. The desktop renderer is a Chromium webview, not Node; pulling those privileges into the webview reopens the boundary that motebit was supposed to close. Sidecar isolates them.

What landed:

```text
apps/desktop/src-tauri/sidecar/skills.js   Node sidecar, NDJSON over stdin/stdout
apps/desktop/src-tauri/src/skills.rs       Rust host, owns the Sidecar lifecycle
apps/desktop/src/skills-ipc.ts             TauriIpcSkillsPanelAdapter
apps/desktop/src/ui/skills.ts              DOM bindings, skills panel
apps/desktop/index.html                    button + panel + inline CSS
```

Tauri's `bundle.resources` ships the sidecar JS into the .app bundle. Production assumes Node ≥20 on PATH; honest fail-closed degradation if absent (panel surfaces `sidecar_unavailable: Node not on PATH`). Replacing the JS sidecar with a compiled binary is a phase 4.2.x follow-up.

Cross-surface inheritance: phase 4.3 (mobile) uses native IPC — Swift on iOS, Kotlin on Android — to wrap the same `@motebit/skills` registry. Phase 4.4 (web) inherently cannot match this pattern (no native sidecar) and waits for phase 4.5's curated registry where the relay holds the verified bytes.

Tests: 11 new TS unit tests pin every adapter method's command name and arg shape; 6 new Rust unit tests pin the JSON-RPC frame parser, request serialization, response classification, and notification skipping.

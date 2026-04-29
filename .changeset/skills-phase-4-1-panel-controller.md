---
"motebit": patch
---

Skills v1 phase 4.1: surface-agnostic `SkillsController` in `@motebit/panels`. State + actions for the cross-surface skills panel (browse / install / enable-disable / trust-untrust / verify / remove / search / detail-view) — the foundation for desktop / mobile / web renderers in subsequent slices (4.2 / 4.3 / 4.4).

The controller follows the established `@motebit/panels` pattern: one adapter the host implements, one state shape, one controller exposing `subscribe + actions + getState + dispose`. Zero internal deps preserved — wire-format types (`SkillSensitivity`, `SkillPlatform`, `SkillProvenanceStatus`) are inlined to avoid layer promotion against `@motebit/protocol`. The host wires its `SkillRegistry` instance into the adapter; the controller is registry-unaware.

```text
SkillsPanelAdapter      listSkills | readSkillDetail | installFromSource |
                        enableSkill | disableSkill | trustSkill | untrustSkill |
                        removeSkill | verifySkill
SkillsController        refresh | install | enable-disable | trust-untrust |
                        removeSkill | verifySkill | selectSkill | setSearch |
                        filteredSkills | dispose
SkillSummary            list-row payload (frontmatter + state, no body bytes)
SkillDetail             detail-view payload (summary + body + author/category/tags)
```

Optimistic state mutations:

- `enable / disable` flip `enabled` locally without a full refresh (cheap, immediate UX feedback).
- `trust / untrust / remove` trigger a full refresh — provenance status recompute lives on the registry side, not the panel.
- `verifySkill` mutates only the affected row's `provenance_status` (no full refresh).
- Removing the currently-selected skill clears `selectedSkill` automatically.

Errors surface in `state.error` and leave previous-good state intact; the renderer decides toast vs system-message per surface doctrine. 21 new tests cover refresh / install / enable-disable / trust-untrust / remove / verify / selectSkill / setSearch / dispose / error paths. 132/132 panels tests green.

Phase 4 remaining: 4.2 (desktop renderer), 4.3 (mobile renderer + ExpoFsSkillStorageAdapter), 4.4 (web renderer + IndexedDBSkillStorageAdapter or relay-mediated browse), 4.5 (`motebit/awesome-skills` curated registry).

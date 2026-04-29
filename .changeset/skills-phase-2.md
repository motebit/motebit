---
"@motebit/sdk": minor
"motebit": patch
---

Skills v1 phase 2: wire `SkillSelector` into the runtime context-injection path so installed skills actually inject per-turn (spec/skills-v1.md §7).

**`@motebit/sdk`** — adds the developer-contract surface for the runtime ↔ skill-runtime adapter boundary:

```text
SkillInjection         { name, version, body, provenance }
SkillSelectorHook      { selectForTurn(turn) -> Promise<SkillInjection[]> }
ContextPack            new optional `selectedSkills` field
```

The `SkillSelectorHook` is the abstraction the runtime binds to. Surfaces (CLI / desktop / mobile) provide concrete implementations behind this interface; the runtime stays unaware of the BSL `@motebit/skills` package per the adapter-pattern doctrine.

**`motebit`** (CLI) — wires `NodeFsSkillStorageAdapter + SkillRegistry + SkillSelector` behind the `SkillSelectorHook` interface. Each turn the runtime calls `selectForTurn(text)`; the hook reads `~/.motebit/skills/` fresh (so `install`/`trust`/`remove` propagate without restart), runs the BM25-ranked selector with `sessionSensitivity: "none"` and `hardwareAttestationScore: 0` defaults appropriate to the CLI today, maps the result to `SkillInjection[]`, and returns top-K. `process.platform` maps to `SkillPlatform` for the OS gate.

Selected skill bodies inject into the system prompt as labeled blocks per spec §7.3:

```text
[skill: git-commit-motebit-style@1.0.0 — verified]
<body>
```

Verified skills get `verified` tag; operator-attested unsigned skills get `operator-trusted (unsigned)` tag — the agent sees provenance posture and can factor it into reasoning.

Fail-closed: a hook that throws is logged via `runtime._logger.warn("skill_selector_failed", ...)` and treated as an empty result. Selector failures never block the AI loop.

Phase 2 remaining work: `scripts/` quarantine + per-script approval (deferred until a skill bearing scripts/ ships; will use the existing tool-approval gate per the saved project memory). Phase 3: signed `SkillLoadReceipt` in `execution-ledger-v1`.

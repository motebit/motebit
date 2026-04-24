# Panel pattern

When a UI panel ships on more than one surface, where does its state live? Four answers, chosen per panel, documented here so the next extraction stays consistent.

## The four shapes

### 1. Three-surface controller — `@motebit/panels`

Pattern: `createXController(adapter)` returns a state subscription + action methods. Each surface renders from the emitted state.

- Adapter inverts the dependency on `@motebit/runtime` so the package stays Layer 5 without promotion.
- Auth is adapter-supplied (desktop static token, web rotating `createSyncToken`, mobile varies).
- State mutations are optimistic where safe (pin flip, delete), authoritative otherwise (refresh after add).
- Drift gate `check-panel-controllers` matches the family's file-name pattern against relay-endpoint or runtime-API signatures; any match without `@motebit/panels` import fails CI.

Families shipped: **Sovereign**, **Agents**, **Memory**.

### 2. Two-surface controller — same shape, scope-compressed

Same pattern, but one of the three surfaces is a genuinely different feature (not a render-divergent copy) and stays outside the controller.

No family currently fits this shape. **Goals** was the shipped example until 2026-04-22: desktop + mobile shared the daemon-backed CRUD model (`GoalsController`) and web ran parallel `ScheduledAgent` (recurring simple) + `WebGoal` (one-shot plan) types. The unification pass added `createGoalsRunner` — the daemon-role sibling of `GoalsController` for surfaces that ARE the daemon (web) — folding web's two types onto the shared `ScheduledGoal` shape. The "two surfaces + different feature" framing was retrospectively a diagnosis of drift rather than a legitimate shape.

Rule: before accepting this shape for a new family, verify the "different feature" claim by asking whether the surface is answering a different _user question_. If it's answering the same question through a different mechanism (daemon vs. browser tab), unify instead — the mechanism divergence is surface-level, not domain-level.

### 3. Rendering primitive — in the domain package, not `@motebit/panels`

When the shared logic is a drawing or compute primitive that doesn't own state, it belongs alongside its domain.

Family shipped: **Voice waveform** — `renderVoiceWaveform` + `analyzeWaveformFrame` + `EmaTuning` live in `@motebit/voice`, adjacent to the STT/TTS providers. Desktop and web each own their own state machine; they call the renderer per frame.

Rule: state + actions → `@motebit/panels`. Pure compute + rendering + I/O adapters → the domain package.

### 4. Not a controller — canonical types in `@motebit/sdk`

When the shape is "forms plus platform-specific I/O," a controller adds a layer without reducing complexity. The right extraction is canonical types + pure math in `@motebit/sdk`; each surface's keyring / storage / form-binding stays inline.

Family evaluated: **Settings**. Desktop 2089 + web 1242 + mobile 441 (modal) + ~1750 (tabs) = forms bound to Tauri keyring / localStorage / expo-secure-store. ~40 % shared config math (already in `@motebit/sdk`), ~60 % platform-specific rendering + I/O.

Rule: when the LOC is dominated by form fields and platform I/O, extract the types + derivations into `@motebit/sdk` and leave the surfaces alone.

## What's shipped

| Family         | Surfaces                                   | Home              | Gate                                       |
| -------------- | ------------------------------------------ | ----------------- | ------------------------------------------ |
| Sovereign      | desktop, web, mobile                       | `@motebit/panels` | `check-panel-controllers`                  |
| Agents         | desktop, web, mobile                       | `@motebit/panels` | `check-panel-controllers`                  |
| Memory         | desktop, web, mobile                       | `@motebit/panels` | `check-panel-controllers`                  |
| Goals          | desktop, mobile, web (controller + runner) | `@motebit/panels` | `check-panel-controllers`                  |
| Voice waveform | desktop, web                               | `@motebit/voice`  | — (rendering primitive, not a state drift) |

## Evaluated but not extracted

### Chat

Diagnostic (2026-04-19): desktop 1287 LOC + web 1107 LOC. Honest extraction ratio ~60 %. The core streaming loop — chunk dispatch (`text` / `tool_status` / `delegation_complete` / `approval_request` / `injection_warning` / `result`), bubble creation, scroll, receipt-artifact emergence at a 200 ms beat — is byte-identical on both surfaces. Surface-specific features (TTS integration, markdown rendering, plan execution, PR chips, slash-command autocomplete, goal-approval flow, memory footer) would stay.

Why deferred:

- Only two surfaces; the 3-surface wins (Sovereign's −737 LOC) don't materialize.
- Five real divergences listed below — extracting without closing them first would bake the drift into the controller contract.
- Chat is the most-touched file in the repo; regression blast radius is wider.

Revisit trigger: a third chat surface wanting streaming + approval orchestration (mobile plan execution, spatial, CLI TUI).

Known drifts (close whether or not a controller ships):

1. ~~Web's `streamingTTS` is a module-scope singleton; two concurrent chats would share state.~~ **Accepted 2026-04-24.** Web is strictly single-chat-per-tab by design — the runtime has no code path that mounts two simultaneous chat surfaces in one window. The singleton is architecturally equivalent to a surface-owned instance given that constraint. Revisit when web introduces multi-chat (split panes, floating secondary chat, etc.); the desktop pattern (callback-owned lifecycle) is the reference.
2. ~~Web strips `<thinking>` / `<memory>` / `<state>` tags and `[EXTERNAL_DATA]` / `[MEMORY_DATA]` markers; desktop doesn't.~~ **Closed 2026-04-24.** Canonical `stripInternalTags` primitive added to `@motebit/ai-core`; `stripPartialActionTag` now composes it (so desktop picks up the thinking/external-data stripping via its existing call site) and web imports it directly. Both surfaces route every tag-stripping pass through the same regex set. Adding a new internal tag is one edit in `packages/ai-core/src/core.ts`.
3. Memory footer — confidence scores and Recalled-vs-Formed distinction (`apps/desktop/src/ui/chat.ts:545–642`) — is desktop-only. Web has no equivalent. **Still open** — scope question, not a mechanical fix (is the memory footer a desktop-specific affordance because the desktop surface has more vertical space, or is it a web feature gap?). Revisit when product weighs in.
4. Approval nesting: desktop's callback-driven `consumeApproval` chain allows recursive `approval_request` (line 428); web's Promise-based `showApprovalCard` flattens to sequence. Different UX for multi-step delegation with nested approvals. **Still open** — semantic-design question, not a mechanical fix (nested approvals vs sequential approvals is a product decision about how the creature asks permission for compound actions).
5. ~~`showToolStatus(name, context?)` — web preserves context; desktop ignores it.~~ **Closed 2026-04-24.** Desktop's `showToolStatus` signature widened to `(name, context?)` with `formatToolLabel` helper mirroring web. `completeToolStatus` rewritten to preserve the context label (was `${name} done` — recomposed from `name` alone, dropping context; now rewrites only the trailing `...` on the live element text, matching web's pattern). The four `tool_status` chunk handlers in `apps/desktop/src/ui/chat.ts` now thread `chunk.context` through.

### Settings

Diagnostic (2026-04-19): 3772 LOC across three surfaces, dominated by forms + platform-specific keyring/storage. Not a controller target — the shape is "forms plus I/O," not shared state.

Canonical types already live in `@motebit/sdk` (`GovernanceConfig`, `AppearanceConfig`, `UnifiedProviderConfig`, `APPROVAL_PRESET_CONFIGS`, `RISK_LABELS`, `COLOR_PRESETS`, model lists). Every surface imports them. The remaining surface code is form binding + keyring reads/writes, which is inherently per-platform.

Known drifts (each is a policy / audit question, not a mechanical cleanup):

1. ~~**`APPROVAL_PRESET_CONFIGS` diverges silently across surfaces.**~~ **Closed 2026-04-24** (commit `bb35843c`). Web and mobile now import from `@motebit/sdk`; mobile's divergent values (`balanced` denyAbove: 4 → 3, `autonomous` requireApprovalAbove: 2 → 3) are gone. Direction chosen: align to SDK — canonical values win when surfaces diverge, even when a surface was stricter. Recurrence prevented by drift-defense #40 (`check-preset-imports`): any `apps/*` redeclaration of an SDK-canonical identifier fails CI.

2. Desktop hardcodes `maxMemoriesPerTurn: 5` (`apps/desktop/src/ui/settings.ts:1734`) instead of reading `DEFAULT_GOVERNANCE_CONFIG.maxMemoriesPerTurn`. The field is not user-editable on desktop.

3. Mobile's `GovernanceTab.tsx` has no UI for `maxMemoriesPerTurn`; the field is stored in `MobileSettings` but users can't edit it.

4. Model-list seeding is divergent: web's `FALLBACK_MODELS` (`apps/web/src/ui/settings.ts:35–57`) is a local list, desktop reads from `ANTHROPIC_MODELS` / `OPENAI_MODELS` / `GOOGLE_MODELS` in `@motebit/sdk`, mobile relies on parent-supplied defaults. Different users see different model pickers for the same provider.

5. Voice key persistence on desktop needs audit. Web uses `getTTSKey('elevenlabs')` through a shared helper. Desktop's settings.ts grep shows no matching read path for `elevenlabs_api_key` — the key may only be persisted if the TTS provider reads the keyring itself, which would mean Settings shows a stale "connected" indicator when the key changes.

6. `deriveInteriorColor` is copied to mobile (`apps/mobile/src/components/settings/settings-shared.tsx`) instead of imported from the desktop `color-picker.ts`. The math matches today; drift-prone.

Recommended next pass: walk drifts 1–6 with policy-level decisions for 1 and the user's preference on 2+5. None of them are drift gate candidates — they're one-time audits.

## Three invariant questions the next extraction should pre-answer

1. **Is this state or a primitive?** State + actions → `@motebit/panels`. Pure compute / rendering / I/O adapter → domain package. The question isn't "what surfaces does it ship on," it's "does this thing own a subscription model."

2. **Does 2-surface extraction pay?** Sometimes. Goals paid because the `GoalStatus` enum + `setEnabled` contract prevented silent Rust/mobile drift. Chat might not — the "drifts to close" list is longer than the controller would own.

3. **When is the answer "harden the SDK, not extract a controller"?** When the surface LOC is dominated by forms bound to platform APIs. Settings is the example. The right move is canonical types + pure math in `@motebit/sdk`; keyring / storage / form binding stays per surface.

## Drift gate scope

`scripts/check-panel-controllers.ts` enforces the `@motebit/panels` import on every file matching a registered family's name pattern that hits the family's canonical signatures. Adding a new family is a single table entry — see the existing Sovereign / Agents / Memory / Goals entries for the shape. The gate does not cover rendering primitives (voice waveform has no gate; the primitive moved to `@motebit/voice`, so a surface that tries to reinvent the canvas math would fail review, not CI).

## Cross-references

- `packages/panels/CLAUDE.md` — rules for panel controllers
- `scripts/check-panel-controllers.ts` — the drift gate
- `docs/drift-defenses.md` §33 — inventory entry for the gate
- `packages/voice/src/waveform-canvas.ts` — rendering primitive reference

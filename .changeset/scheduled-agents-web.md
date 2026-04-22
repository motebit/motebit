---
"@motebit/web": minor
---

Scheduled agents — recurring tasks the motebit fires on cadence.
"Every morning, brief me on AI news." "Every Thursday, scan for
updates." Each fire runs through the normal chat pipeline and
produces a signed `ExecutionReceipt` the user can inspect or
export — every scheduled run is verifiable, which is the layer
no hosted agent product can match without rebuilding the identity
substrate.

**Current scope (tab-local):**

- Storage: `localStorage` under `motebit.scheduled_agents`. Small
  JSON array, one record per agent.
- Scheduler: single `setInterval(30_000)` tick in `WebApp`. Agents
  whose `next_run_at <= now && enabled` fire immediately.
- Execution: the runner drains `webApp.sendMessageStreaming(prompt)`
  to completion so the normal chat pipeline emits signed
  receipts the existing workstation log captures.
- Coordination: scheduled fires yield to in-flight user turns —
  the runner skips firing when `_isProcessing` is true and relies
  on the next cadence slot to catch up.

**UI (inside the workstation panel):**

- "Scheduled" section between the URL bar and the browser pane.
- Inline compose: prompt input + cadence dropdown (hourly / daily
  / weekly) + schedule / cancel buttons.
- Per-row actions: pause/resume toggle (⏸ / ▶), "run" (fire now,
  bypasses cadence), delete (×). Row shows cadence badge, prompt,
  countdown to next fire (updated every 30s).
- Empty state: "No recurring tasks yet. Add one — the motebit
  runs it on cadence."

**Deferred (endgame):**

- Relay-side scheduling so runs fire while no tab is open. The
  current module's storage + public shape match the endgame — when
  relay scheduling ships, the runner swaps to a subscription to
  relay-fired events; UI and data don't change.
- Desktop surface mount. The desktop app already has a scheduled-
  goals daemon (Rust); a follow-up unifies the UX.
- Per-run linkage from receipts back to the originating scheduled
  agent. Today receipts appear in the main audit log; a future
  pass adds a per-agent receipt thread.

**API surface:**

- `WebApp.getScheduledAgents(): ScheduledAgentsRunner | null`
- `ScheduledAgentsRunner`:
  - `list()` → snapshot array
  - `subscribe(listener)` → unsubscribe thunk
  - `add({ prompt, cadence })` → new agent
  - `setEnabled(id, enabled)`
  - `remove(id)`
  - `runNow(id)` — manual fire
  - `dispose()`

All 28 drift gates pass. 178/178 web tests green. Full workspace
build clean.

Strategic context: this is motebit's answer to Perplexity Computer's
"Scheduled" row (portfolio tracker hourly, morning brief daily,
trend research weekly). The differentiator we add on top —
cryptographic receipt per run — requires no platform cooperation;
every fire produces a verifiable artifact of what the motebit
actually did.

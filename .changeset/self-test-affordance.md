---
"motebit": minor
---

Self-test affordance — third leg of the sovereignty-visible trifecta. Activity (`eb10bac6`) shows what the motebit DID; Retention (`ac622b64`) shows what the operator PROMISED; this commit ships the third axis: **the user can probe that the protocol's security boundary still holds.** One click, green/red receipt, every surface.

`cmdSelfTest` (the canonical adversarial-onboarding probe per `CLAUDE.md` "Adversarial onboarding") submits a self-delegation task through the live relay, exercising the real device-auth + audience-binding + sybil-defense flow production agents use. It's run once on every onboarding today, but the result was logged to console and never surfaced. The user couldn't ask "is my motebit still secure?" without `console.log` — until now.

Cross-surface controller in `@motebit/panels`:

```ts
const ctrl = createSelfTestController({
  runSelfTest: () => app.runSelfTestNow(),
});
ctrl.subscribe(setState);
ctrl.run(); // kicks off the probe; concurrent calls coalesce.
// state.status: idle | running | passed | failed | task_failed | timeout | skipped
```

Discrete status state machine, idempotent under concurrent clicks, `selfTestBadgeLabel(status)` projection so every surface renders the same calm-software badge. Adapter throws are caught and projected into `failed` with the error in `summary` — surfaces never see a rejected promise.

Each surface ships:

- **Web** (`apps/web/src/web-app.ts`): `runSelfTestNow()` public method that mints `task:submit` token, calls `cmdSelfTest`, returns the structured result.
- **Desktop** (`apps/desktop/src/index.ts`): same shape, dynamic-imports `@tauri-apps/api/core` for `invoke`, fetches device keypair, mints token.
- **Mobile** (`apps/mobile/src/mobile-app.ts`): same shape against `await getSyncUrl()` + `createSyncToken("task:submit")`.
- All three Activity panels render a "Run security self-test" button with status badge below the retention summary, inside the existing retention block. Inline summary surfaces failure hint when relay returns 401 ("device may not be registered") / 402 ("fund the agent's budget") / etc.

Drift gate `check-panel-controllers` (#33) extends with `self-test` family — any surface that ships the button but bypasses the controller fails CI. Same shape as the existing `activity` + `retention` enforcement.

10 controller tests covering state machine (idle → running → terminal), adapter throw → `failed` projection, hint + httpStatus passthrough, concurrent-call coalescing, subscribe/dispose lifecycle, badge label projection.

The trifecta on every surface, locked by gate, demo-ready.

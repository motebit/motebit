---
"@motebit/protocol": patch
---

**Third slice of PR 1 of the agent-surface pivot — cobrowse-as-mode reshape (protocol half).** Adds `yield_control` to the `CO_BROWSE_TRANSITION_KINDS` closed registry. Symmetric protocol-level partner to `release_control` (motebit yields to user) on the user side, closing the polarity-asymmetry where the protocol named "user takes" (`reclaim_control`) but not "user gives." Implicit when the user was the always-default driver; named explicitly now that motebit-default is the new register. Doctrine: [`chrome-as-state-render.md`](https://github.com/hakimlabs/motebit/blob/main/docs/doctrine/chrome-as-state-render.md) § "user register — cobrowse mode entered."

Why a distinct transition rather than re-using `request_control + grant_control` as a compound: a single explicit `yield_control` produces one audit event with the right semantics ("user handed back"); the request-then-grant compound would produce two events that a verifier would have to recognize as a paired pattern. The audit log is the source of truth for "who was driving when"; one transition kind keeps the log legible.

Additive `@alpha` registry entry; existing verifiers see the new kind as an unknown literal and reject (closed-set discipline). API-extractor baseline regenerated. The runtime-side counterpart — `yieldControl(by: "user")` method on `CoBrowseControlMachine`, web-side `/back` slash command + "motebit waiting" chip-button + handler wiring — ships in the ignored sibling `.changeset/slab-chrome-cobrowse-as-mode-ignored.md`.

---
"@motebit/sdk": minor
---

`AIResponse` gains an optional `reasoning` field — the model's interior cognition (`<thinking>`), captured for the owner-facing `mind` embodiment organ (render-engine `EMBODIMENT_MODE_CONTRACTS.mind`, `source:"interior"`/`observer:"self"`). Previously the reasoning trace was stripped from the visible text and captured nowhere — destroyed before it could reach the surface built to render it. It stays stripped from the visible `text` (the chat register stays clean) and is INTERIOR-ONLY by contract: never synced, egressed, persisted to a shared surface, or sent to external AI. Additive and fail-closed — absent when the model emitted no reasoning. Increment 1 of the interior-cognition arc (`felt-interior.md`); the `mind`-organ render follows in Increment 2.

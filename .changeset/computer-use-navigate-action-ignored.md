---
"@motebit/wire-schemas": minor
"@motebit/tools": minor
---

`computer-use@1.0`: companion ignored-package work for the `navigate(url)`
action protocol addition (`computer-use-navigate-action.md`).

`@motebit/wire-schemas` gains `NavigateActionSchema` (zod) and the
discriminated-union variant for `kind: "navigate"`; the JSON Schema
artifact in `spec/schemas/` regenerates on the same cadence.

`@motebit/tools` widens the `computer` tool's `oneOf` action variants
to include the `navigate` branch and updates the tool description so
the AI loop selects `navigate` when the surface is cloud-browser
(headless viewport — no address bar to type into).

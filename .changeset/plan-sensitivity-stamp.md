---
"@motebit/protocol": minor
---

Add the optional `Plan.sensitivity` field: the highest sensitivity tier a plan's content (its steps' prompts and results, derived from the goal and the turns that ran them) was produced at. A runtime executes or resumes a plan at no lower tier, so a plan produced at a medical, financial or secret tier is never sent to an external provider, and treats an unstamped plan as `secret`. The field is local to a device and is not on the sync wire.

Additive only. No existing type changes.

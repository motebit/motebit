---
"@motebit/crypto": minor
---

Add `verifyMigratingKeyBinding` — the offline, operator-free key↔id binding check a destination relay runs before onboarding a migrating agent (spec/migration-v1.md §8.2 step 6). Two tiers, fail-closed: a never-rotated sovereign id binds its key directly (`verifySovereignBinding`); a rotated key binds via its identity file's sovereign-rooted succession chain (`verifyKeyBindingAtTime`). Lets a sovereign agent that has rotated its key migrate — previously locked out, since `motebit_id` commits to the genesis key. Additive.

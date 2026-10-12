---
"motebit": patch
---

Internal: the `motebit serve --direct` task handler moved from `daemon.ts` into its own module (`direct-task-handler.ts`) so both task doors can be tested; behaviour unchanged.

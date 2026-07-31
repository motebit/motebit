---
"motebit": patch
---

A conversational hire now ends with its receipt (#493): the runtime emits `delegation_complete` with the worker's signed `full_receipt` on the `delegate_to_agent` path — both routes, including post-approval execution — so the CLI archives and renders the offline-verified receipt block (`/receipt <task-id>` now works for AI-loop hires), the same beat `/invoke` users already had. The streaming layer peeks the receipt stash without draining it, so the parent receipt's `delegation_receipts` chain is untouched.

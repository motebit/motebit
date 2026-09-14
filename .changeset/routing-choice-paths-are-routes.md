---
"@motebit/protocol": patch
---

Documents the exact meaning of `routing_choice.routing_paths` and `alternatives_considered` on `DelegatedStepResult` and the execution-ledger step summary: `routing_paths[0]` is the path in the routing graph whose composed edge metrics `sub_scores` reflects — the sequence of agent ids from the caller to the worker that justified the choice — and any further entries are the non-dominated alternative paths the policy weighed, best first. Every entry is a path that exists in the routing graph; a per-dimension optimum no single path attains is never reported. A path is trust evidence behind `selected_agent`, not a record of who executed the task (that is what receipts prove). Pinned hires report `[[worker]]` with `alternatives_considered: 0`. Types are unchanged; this pins the semantics that `motebit/execution-ledger@1.0` §4.1.1 and `motebit/delegation@1.0` §3.2 now state, matching the path-preserving ranking shipped in the reference relay.

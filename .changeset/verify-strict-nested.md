---
"@motebit/verify": patch
---

`motebit-verify`'s strict-by-default `result_hash` check now covers every nested `delegation_receipts` entry at every depth: a signed outer receipt carrying a child whose `result_hash` does not bind its own `result` is `INVALID` (exit 1), and the error names the child's delegation depth and `task_id`. `--lenient` remains signature-only at every depth, with its one-line warning.

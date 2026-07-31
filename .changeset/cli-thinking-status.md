---
"motebit": patch
---

A thinking-status row now covers model latency in the REPL (#480, second queued #456 increment): the gap between your Enter and the first token, and between a tool's done-line and the model's next words, shows a calm `· thinking · 3s` pulse instead of a blank `mote>`. Streamed text is its own progress indicator, so the row yields the moment tokens flow. Same treatment on the attached REPL.

---
"motebit": patch
---

The per-turn `[state: attention=…]` and `[Body]` lines no longer render after every REPL turn (#480). They were operation-level readouts in the product register; the felt-interior unit is the durable mutation, so `[memories: …]` still renders when a memory forms, and the full state vector remains available behind `/state`. Same treatment on the non-streaming path.

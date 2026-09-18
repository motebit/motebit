---
"@motebit/relay": patch
"@motebit/runtime": patch
"@motebit/mobile": patch
---

The unpublished half of `halt-status-across-machines`: the relay composes a many-machine `halt-status` (one delivery per machine, attributed by socket, a partial answered 504 with the per-machine body), `@motebit/runtime` gains `readComposedCommandResult` — the one reader both consumer surfaces use — and the phone's `/halted` reads a composed body before it reads the status. See that changeset for the reasoning; issue #687.

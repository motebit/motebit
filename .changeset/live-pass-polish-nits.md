---
"motebit": patch
---

Two rendering nits witnessed in the 1.11.3 live pass. Exit lines no longer glue onto the mode row: `destroyTerminal()` now retires the owned bottom region (flushes the partial line and any in-flight input as history, clears the status/mode rows, parks the cursor on a fresh line) before shutdown output prints. `/receipt` is now usable from its own render: the rendered receipt shows a truncated task id, so the command accepts a unique prefix (a pasted trailing "…" is stripped), lists candidates on an ambiguous prefix, and with no argument re-renders the session's latest receipt.

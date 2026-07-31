---
"motebit": patch
---

REPL input now wraps across rows instead of h-scrolling behind an ellipsis — the full line stays visible while typing or editing (#480, first queued #456 increment). The input row is one logical row of arbitrary width; clearing and cursor parking both derive from the same reflow math, so repaints, resize, and mid-line edits stay exact at any width.

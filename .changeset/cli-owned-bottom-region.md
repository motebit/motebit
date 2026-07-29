---
"motebit": patch
---

CLI rendering: the REPL now owns the bottom of the screen (#456, #455). One renderer discipline (clear region, append scrollback, repaint) replaces print-and-hope: resizing repaints the prompt in place instead of stacking duplicates; in-flight delegation shows a calm status row with the current step narration, elapsed time, and poll-attempt count instead of animated dots; runtime warnings (delegation poll failures above all) flow through the renderer as calm text instead of raw JSON dumped into the input line. Same treatment on the attached REPL and the background goal scheduler.

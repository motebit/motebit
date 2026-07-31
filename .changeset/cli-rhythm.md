---
"motebit": patch
---

One vertical rhythm and one indentation grammar for the REPL (#480): a new idempotent `writeGap()` renderer primitive guarantees exactly one blank row at every boundary (receipt blocks, end-of-turn) however many writers ask — the double/triple blank-line class is gone. Indentation now encodes nesting: 2-space records at act level, 4-space detail under a live act (logger lines included). Sub-second tools read `<1s` instead of a suspicious `0s`.

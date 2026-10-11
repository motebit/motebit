---
"@motebit/protocol": minor
---

New `toWellFormedText(s)` replaces every unpaired UTF-16 surrogate with U+FFFD (the identity on well-formed text; the same bytes a UTF-8 encoder produces), and `truncateWellFormed(s, maxUnits)` cuts text to at most `maxUnits` UTF-16 code units without ever splitting a surrogate pair. Producers use them so no signed receipt carries a string with no UTF-8 encoding (spec/execution-ledger-v1.md §11.4).

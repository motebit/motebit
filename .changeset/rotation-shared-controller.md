---
"motebit": patch
---

`motebit rotate` now runs the same rotation state machine as web, mobile and desktop (`@motebit/surface-kit`), so the four cannot drift. Two edges are handled more carefully: a rotation interrupted between its two local writes is finished from its write-ahead rather than treated as stale, and a write-ahead that is present but cannot be read stops the run with the honest next step instead of being mistaken for none.

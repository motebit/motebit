---
"motebit": patch
---

The REPL now nudges when a newer motebit is on npm — one dim line in the seed-nudge register (`motebit 1.11.2 available — npm i -g motebit`), because a global npm install never self-updates and the gap was invisible. The registry check is cached for a day and refreshed in the background for the NEXT launch: startup never blocks on the network, offline is silent, and `MOTEBIT_NO_UPDATE_CHECK=1` opts out entirely.

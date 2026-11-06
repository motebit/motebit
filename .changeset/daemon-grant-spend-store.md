---
"motebit": patch
---

`motebit run` and `motebit serve` now meter standing-grant spending against the persistent spend store. Both daemons accept a grant this identity signed, but neither passed a `grantSpendStore`, so the runtime fell back to the in-memory store and a grant's window and lifetime ceilings reset on every daemon restart. Both now build their runtime config through `daemonRuntimeConfig`, which requires the store and is given the daemon's own database store (the same one the REPL uses). A restart no longer resets a grant's ceilings or forgets a spent token. `check-money-authority` gains assertion 7, which parses each `new MotebitRuntime(` config: one that sets `identityPublicKeyHex` must also carry a `grantSpendStore` property with a real store value (not `undefined`, and not only a word in a string or comment).

---
"motebit": patch
---

`motebit run` and `motebit serve` now meter standing-grant spending against the persistent spend store. Both daemons accept a grant this identity signed, but neither passed a `grantSpendStore`, so the runtime fell back to the in-memory store and a grant's window and lifetime ceilings reset on every daemon restart. Both now build their runtime config through `daemonRuntimeConfig`, which requires the store and is given the daemon's own database store (the same one the REPL uses). A restart no longer resets a grant's ceilings or forgets a spent token. `check-money-authority` gains assertion 7. It follows each runtime construction's config through object literals, the CLI config builders, spreads of literals, conditionals and casts. A config that sets `identityPublicKeyHex` must pass a `grantSpendStore` on every branch, and a config it cannot follow fails the gate. It does not check that a passed store is durable.

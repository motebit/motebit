---
"motebit": patch
---

`motebit rotate` takes the relay's own answer to "may a rotation depart from this key" instead of re-deriving it — a daemon that had shut down (its key held only on a device row) no longer reads as unregistered. The departing key comes from the config's private key, an interrupted commit is finished from the write-ahead, a stale write-ahead is reported and cleared rather than left to block a passphrase change, and every relay-facing command resolves the relay through one shared resolver.

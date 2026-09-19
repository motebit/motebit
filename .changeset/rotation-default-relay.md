---
"motebit": patch
---

`motebit rotate` now resolves the relay the same way every other subcommand does — `--sync-url`, then the environment, then persisted config, then the default relay. It read only the persisted value, so an identity registered against the default relay was told no relay was configured and rotated locally, leaving its key ahead of the relay's with no way back.

A rotation whose submission outcome is unknown is now held rather than lost: the record is written before the request goes out, and the next run finishes that rotation instead of minting a new keypair the relay would refuse.

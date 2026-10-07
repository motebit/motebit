---
"create-motebit": patch
---

Refuse the interactive path when stdin is not a terminal. Previously a CI or piped run printed the first prompt and exited 0 having created nothing; it now exits 1 with a message pointing to `--yes` and `MOTEBIT_PASSPHRASE`.

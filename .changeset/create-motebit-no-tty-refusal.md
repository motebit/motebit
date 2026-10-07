---
"create-motebit": patch
---

Refuse the interactive path when stdin is not a terminal. Running `create-motebit` (scaffold, `--agent`, or `rotate`) without a TTY and without `--yes` used to print the first prompt, create nothing, and exit 0. It now exits 1 with a one-line message pointing at `--yes` and `MOTEBIT_PASSPHRASE`.

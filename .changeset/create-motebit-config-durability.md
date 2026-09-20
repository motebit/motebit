---
"create-motebit": patch
---

`~/.motebit/config.json` is the file the CLI keeps its identity key in, so the same three rules now apply here: an absent config is a first run, a config that cannot be read is refused rather than reported as empty, and a replacement is staged and renamed rather than written through, owner-only.

Reading damage as empty mattered twice over: the guard that refuses to clobber an existing identity decides from `motebit_id` alone, so an unreadable config looked like a fresh machine and was overwritten.

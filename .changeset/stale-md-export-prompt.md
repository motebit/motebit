---
"motebit": patch
---

Three sibling fixes around the identity snapshot and its refresh path. `motebit export` no longer corrupts passphrase input (the masked prompt detaches the caller's readline for the duration of the read — a paused terminal readline kept echoing and consuming keystrokes, so the correct passphrase read as incorrect), and its wrong-passphrase message now names the real remedies (unlimited offline attempts; `motebit restore` resets a forgotten passphrase) instead of advising deletion of the config that holds your key and funds. Export also refreshes `~/.motebit/motebit.md` in place, so the snapshot can no longer silently diverge from the live identity after a key change; `motebit doctor` flags any remaining divergence with an advisory warning — the live key is `config.device_public_key`, never the .md, which is a portable snapshot.
(The on-disk surface baseline records the refreshed `~/.motebit/motebit.md` path.)

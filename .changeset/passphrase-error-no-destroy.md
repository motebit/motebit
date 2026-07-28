---
"motebit": patch
---

Wrong-passphrase handling no longer leads with a destructive remedy. The prompt now retries a few times within one run (offline, no lockout), and on giving up it warns — instead of instructing `rm ~/.motebit/config.json`, which erases the identity key and any wallet funds it controls — that attempts are unlimited and offline, and that deletion is irreversible without a recovery seed. A non-interactive session (`MOTEBIT_PASSPHRASE`) still gets a single attempt.

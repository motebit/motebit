---
"motebit": patch
---

Prompt for the identity passphrase once per invocation, not once per unlock.

`motebit export` prompted four times in a single run — once at the top, then once per relay-auth header minted through `loadActiveSigningKey`'s default getter — which on screen looked like Enter not registering (the prompt line "duplicating" after every submit). `delegate` could reach six prompts, `market` five.

The passphrase is now cached in process memory for the life of the invocation, seeded only at proof points: a successful AES-GCM decrypt of the identity key, or the encrypt call that sets the passphrase. An unverified prompt never seeds it, `MOTEBIT_PASSPHRASE` still takes precedence, nothing is persisted, and the decrypted key is still securely erased after each use. A cached value that stops decrypting (key replaced mid-process) self-heals by clearing and re-prompting. The relay key passphrase is a different secret on a different path and is unaffected.

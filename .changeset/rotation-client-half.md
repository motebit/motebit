---
"motebit": patch
---

`motebit rotate` reaches the relay, and cannot strand the identity between two keys.

It used to erase the old key, then tell the relay with a bearer the relay could never verify, then swallow the refusal — every rotation left the identity on a key the relay had never heard of, with no way back. Now it reads where the relay stands first (from the public succession route, no token), writes the new key to disk encrypted before anything is sent, submits signed by the key being retired, and moves local state only after the relay confirms. A lost response is resolved on the next run by reading, never by re-signing or replaying; an unreachable relay stops with the old key intact; a relay that holds some other key names it and points at guardian recovery; an identity the relay never knew rotates locally and says so. The relay is resolved the same way `motebit up` resolves it, default included. `motebit restore`'s passphrase reset refuses while a rotation is in flight, since the held key is encrypted under the current passphrase.

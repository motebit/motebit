---
---

Relay: a key succession is recorded only from a key the relay already holds for that identity. An ordinary succession is refused under another identity's token (guardian recovery stays exempt — it is carried by someone else by design); the record must depart from the registry key, or from a key one of the identity's device rows holds where the registry key is absent or empty, and is refused when the relay holds neither. That check was previously skipped on a falsy stored key, which let a chain be planted under any deregistered or keyless identity and served as its key history. Pairing's bearer-less key-transfer route now writes only a key the identity already holds and spends its session. `spec/identity-v1.md` §7.5 states the obligations.

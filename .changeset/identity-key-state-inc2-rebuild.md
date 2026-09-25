---
"@motebit/relay": minor
---

An identity's key is now held by evidence, not by whichever door wrote last (#703 Increment 2, build 3). The new `identity_keys` holder is the only authority for what the relay serves (the identity bundle, the identity log, `/succession`), what a rotation departs from, and what a registration is checked against.

It is written only by:

- a sovereign binding plus current possession of the key (register-self's signature, or a register bearer verified by the device holding that key);
- a succession link from the key already held;
- a migration's binding;
- an operator registration of a service identity with no devices;
- the one-time migration transplant of the existing registry key or chain head (v42).

Unsigned bootstrap, a bearer naming some other key, and a rotation admitted through a device row write nothing to the holder. New keys must arrive as lowercase hex; a key already on file is admitted in its stored spelling. Signature checks elsewhere use the holder once it exists, and otherwise read exactly what they did before.

A legacy (non-sovereign) identity with no evidence now serves `''` in its identity bundle instead of its registry key. Receipt ingestion no longer rewrites the registry key from a receipt's embedded key.

---
---

Relay: one rule for who may change what the relay believes an identity's key is. A key succession is accepted only under the identity it rotates and only from a key that identity holds; recording a succession re-keys the identity's device records in the same step, so a rotated-away key stops verifying tokens; a guardian is installed only by a caller verified under the identity key and is never replaced by re-registration. `spec/identity-v1.md` §7.5 states the three obligations.

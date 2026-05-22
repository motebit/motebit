---
"create-motebit": minor
---

New identities are now minted **sovereign by default**: `motebit_id` is the UUIDv8 commitment to the genesis key (`sha256(pubkey)`) instead of a random UUIDv7. The id↔key binding is therefore self-certifying — a verifier (e.g. receipt.computer) confirms it offline with no operator — and recoverable from the genesis seed, while rotation still works via succession. Existing identities are unaffected (their random UUIDv7 ids keep working); only freshly-generated identities are sovereign. The device_id stays a random UUIDv7.

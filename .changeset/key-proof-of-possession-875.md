---
"motebit": minor
---

Relay registration is signed by the key it introduces (#875 — proof of possession).

The relay now refuses an unsigned `POST /api/v1/agents/bootstrap`: the body must be a device-registration request signed by the key it names. It uses the same construction and ±5-minute window as `register-self` (`spec/device-self-registration-v1.md`). Every CLI caller now signs it through one helper, `signedBootstrapBody` in `relay-registration.ts`: the daemon's relay registration, the REPL's startup device registration and the #962 push loop's re-introduction after a 401/403 (`bootstrapReplDevice`, used by the REPL, `run`, `serve` and `delegate`), `/connect`, `motebit register` and `smoke-x402`. A relay that predates #875 ignores the extra fields, so the signed body works against both.

`motebit register` no longer falls back to an unsigned registration when it cannot load the signing key (no key, wrong passphrase, key mismatch). It exits with the key error and its remedy, because the relay would refuse an unsigned bootstrap anyway.

Stated cost: suppose a sovereign identity has rotated away from its genesis key. `motebit register` against a relay that has never seen it is then refused (`409 SOVEREIGN_ID_KEY_MISMATCH`), because the id commits to the genesis key. Reach that relay through migration from a relay that holds the identity, or register with the genesis key and rotate afterwards.

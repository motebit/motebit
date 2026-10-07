---
"motebit": patch
---

Relay bootstrap is signed by the key it introduces (#875 — proof of possession, client half).

Every CLI caller of `POST /api/v1/agents/bootstrap` now sends a device-registration request signed by the key it names (`signDeviceRegistration`: JCS + Ed25519 over {motebit_id, device_id, public_key, timestamp, suite}, the `register-self` construction), built by one helper, `signedBootstrapBody` in `relay-registration.ts`: the daemon's relay registration, the REPL's startup device registration and the #962 push loop's re-introduction (`bootstrapReplDevice`, used by the REPL, `run`, `serve` and `delegate`), `/connect`, `motebit register` and `smoke-x402`.

This ships ahead of the relay enforcement (make-before-break): a relay that does not yet require the signature ignores the extra fields, so the signed body is accepted by both the current relay and the enforcing one.

`motebit register` no longer falls back to an unsigned registration when it cannot load the signing key (no key, wrong passphrase, key mismatch). It exits with the key error and its remedy, because the enforcing relay refuses an unsigned bootstrap.

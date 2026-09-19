---
"@motebit/relay": patch
---

Both public registration doors now answer to one rule about who may add a device to an identity that already exists.

`POST /api/v1/devices/register-self` and `POST /api/v1/agents/bootstrap` take no bearer — the request is its own auth. That is right for an identity's first moment and wrong for every moment after it, because a device row is not inert: its `public_key` is what a signed owner token is verified against. `bootstrap` carried a hijack check; `register-self`, written later, checked for a key conflict only on the _same_ `device_id`, so a new `device_id` under an existing identity was accepted with any key. Two doors, two rules, and the weaker one was the door.

They now share `refusePublicDeviceRegistration` (`device-registration-guard.ts`): once an identity holds a key, a public registration under it must present a key the identity already holds — on any of its devices, or in its agent registration, since an identity with no device row is not an identity with no owner. A second machine after a key-transfer link and a restore from seed both pass (same key, fresh `device_id`); a new key joins through the authenticated pairing flow, and a replacement through `/rotate-key`. A `device_id` already registered to a different identity is refused too, even under a brand-new `motebit_id`: the device table is keyed by `device_id` alone, so that registration used to replace the row.

A refusal persists nothing. `spec/device-self-registration-v1.md` §5.1 gains the three outcome rows it was missing — the unspecified case is how the two doors drifted — and §6.3 states the conflict as per-identity.

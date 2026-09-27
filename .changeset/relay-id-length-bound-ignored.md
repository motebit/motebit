---
"@motebit/relay": patch
---

Bound `motebit_id` and `device_id` length at every relay door that writes an identity, device, registry or push-token row (#814). Not every caller-chosen id: the roster ingest stores a caller-chosen `device_id` inside a signed enrolment, bounded only by the 4096-byte entry cap, which is harmless to retirability because a retirement carries no `device_id`.

A machine-roster retirement names the `motebit_id` plus a 64-hex `enrollment_id`, so for a short `device_id` it is larger than the enrolment it ends. The relay refuses roster entries over 4096 bytes, so with ids unbounded an identity could enrol a machine the relay held and never hold its retirement — the retired machine stayed active on every surface.

- New `id-bounds.ts`: `MAX_MOTEBIT_ID_LENGTH = 256`, `MAX_DEVICE_ID_LENGTH = 256` (UTF-16 code units) and one shared check, `refuseInvalidIds`, which refuses an id that is present but not a string (array, object, number, boolean, `null` — the storage layer bound a one-element array as its text, so `["z"×5000]` passed a length check that looked only at strings) as well as one past its bound. At the bound, in the costliest canonical-JSON spelling (6 bytes per code unit), the largest enrolment is 3,388 bytes and the largest retirement 1,919 — measured with the real signing code in `__tests__/id-bounds.test.ts`.
- Enforced with 400 at `POST /api/v1/agents/bootstrap`, `POST /api/v1/devices/register-self` (`reason: "id_too_long"` or `"malformed"`, before signature verification; `device_name` / `owner_id` must be strings or absent), `POST /api/v1/agents/register`, `POST /device/register` (and its `device_name`), `POST /pairing/:id/approve`, `POST /api/v1/agents/push-token` (the caller's id as well as the body `device_id`; `push_token` must be a string) and `POST /api/v1/agents/accept-migration` (before any network fetch).
- Rows an earlier relay admitted are not touched; an over-long id keeps authenticating but gains no new device, registration or push-token row.
- `spec/device-self-registration-v1.md` and `spec/machine-roster-v1.md` §11 state the reference relay's bound.

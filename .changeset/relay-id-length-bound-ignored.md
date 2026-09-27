---
"@motebit/relay": patch
---

Bound `motebit_id` and `device_id` length at every relay door that writes an identity, device, registration or push-token row (#814).

A machine-roster retirement names the `motebit_id` plus a 64-hex `enrollment_id`, so for a short `device_id` it is larger than the enrolment it ends. The relay refuses roster entries over 4096 bytes, so with ids unbounded an identity could enrol a machine the relay held and never hold its retirement — the retired machine stayed active on every surface.

- New `id-bounds.ts`: `MAX_MOTEBIT_ID_LENGTH = 256`, `MAX_DEVICE_ID_LENGTH = 256` (UTF-16 code units) and one shared check, `refuseOverlongIds`. At the bound, in the costliest canonical-JSON spelling (6 bytes per code unit), the largest enrolment is 3,388 bytes and the largest retirement 1,919 — measured with the real signing code in `__tests__/id-bounds.test.ts`.
- Enforced with 400 at `POST /api/v1/agents/bootstrap`, `POST /api/v1/devices/register-self` (`reason: "id_too_long"`, before signature verification), `POST /api/v1/agents/register`, `POST /device/register`, `POST /pairing/:id/approve`, `POST /api/v1/agents/push-token` and `POST /api/v1/agents/accept-migration` (before any network fetch).
- Rows an earlier relay admitted are not touched; an over-long id keeps authenticating but gains no new device or registration.
- `spec/device-self-registration-v1.md` and `spec/machine-roster-v1.md` §11 state the reference relay's bound.

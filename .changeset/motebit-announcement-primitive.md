---
"@motebit/crypto": minor
---

Add the self-signed motebit-announcement primitive — `signMotebitAnnouncement` / `verifyMotebitAnnouncement`, the `SignableMotebitAnnouncement` / `MotebitAnnouncementVerifyResult` / `AnnouncementSurface` types, and the `MOTEBIT_ANNOUNCEMENT_SUITE` / `MOTEBIT_ANNOUNCEMENT_MAX_AGE_MS` constants.

A motebit announcement is the identity's one-time "I exist, count me" against a named relay — the metabolic-intake half of the boundary, and the client side of the sovereign funnel. It mirrors the device-registration pair exactly (JCS + Ed25519 + base64url under `motebit-jcs-ed25519-b64-v1`, 5-minute replay window, public-key-in-body, signature-is-the-auth), with one addition: an `audience` field bound into the signed body. Verification rejects an announcement whose `audience` is not the verifying relay's id (`wrong_audience`), so consent to be counted by one relay cannot be replayed as intake on another — token binding per `docs/doctrine/security-boundaries.md`.

Additive surface; no behavior change to existing artifacts.

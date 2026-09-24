---
"@motebit/wire-schemas": patch
---

Wire schemas for the machine roster's two artifacts: `HostEnrollmentSchema` and `HostRetirementSchema`, with committed JSON Schemas `spec/schemas/host-enrollment-v1.json` and `host-retirement-v1.json`.

Both are `.strict()`, and that is the point rather than a default. The doctrine keeps capabilities and display names _out_ of the signed body — they change, and the body is served verbatim for as long as the entry exists — so a permissive schema would let them back in one producer at a time. A test asserts that `hosts`, `device_name`, `prev` and a retirement `reason` are all refused. Hex is lowercase only: an entry's id is a hash of its exact bytes, so there is one spelling of a key.

The tests use hand-built fixtures. This package does not depend on `@motebit/crypto`, and a dependency edge is not something to add for a test; that the signer's real output parses is asserted at the relay's ingest, where both are in reach.

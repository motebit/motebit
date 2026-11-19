---
"@motebit/runtime": minor
---

Two exports beside `getOrPinRelayKey` (which is unchanged, as are its callers): `relayPinKey(url)`, the comparable form of a relay URL (null for a backslash, `?`, `#`, `@`, whitespace, a control character, a non-http(s) scheme or an unparseable URL), and `verifyRelayMetadataForUrl(url, { fetchImpl, timeoutMs })`, which establishes a relay's key from its signed discovery metadata only when that metadata names the URL it was asked at (redirects not followed, five-second timeout by default) and otherwise returns a reason value. Neither stores anything.

Ignored-package half of the per-relay relay key change; the published `motebit` half, which consumes both, is in the sibling changeset `cli-relay-pin-per-relay.md`.

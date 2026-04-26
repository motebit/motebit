---
"motebit": patch
---

License metadata correction: `package.json` `license` field flipped from
`BSL-1.1` to `BUSL-1.1` — the SPDX-canonical identifier for Business Source
License 1.1.

`BSL-1.1` is not on the SPDX license list and silently collides with `BSL-1.0`
(Boost Software License 1.0) in some scanners; npm warns on non-SPDX values.
The legal terms are unchanged. This is a metadata-only correction; the
published package's license text and obligations are identical.

Prose continues to use "BSL" / "BSL-1.1" everywhere humans read (the BSL FAQ,
HashiCorp, CockroachDB, Sentry all use "BSL"); `BUSL-1.1` appears only in
`package.json` `license` fields where tooling parses a token.

# Operator signing keys

`github.json` is the pinned set of GitHub's commit-signing keys,
`motebit/operator-signing-keys@1.0` (spec/repo-change-v1.md §9.1). It is the
trust decision `motebit-verify repo-change --landed --github-keys` reads: a
landed squash commit's committer time is accepted only when GitHub's
signature on it verifies under one of these keys, inside that key's window.
The file is strict JSON, so its provenance is recorded here.

## Source

- URL: https://github.com/web-flow.gpg
- Fetched: 2026-11-05T05:29:14Z
- Size: 2483 bytes
- SHA-256: `6e8af687f60cf3f403151c8fb1b26e95e6f9e424ca60cc8f3787bd4466a3ef84`
- Kept unmodified as `github-web-flow.gpg`.

GitHub publishes both keys in one armored block. The format wants one key per
entry, so the block was split at each primary key packet: each entry's
`armored` holds that key's packets (public key, user ID, self-signature)
byte for byte as published, re-armored with its own CRC-24. Joined in order,
the two entries' packets are exactly the published block's
(`packages/verify/src/__tests__/repo-change-landed-github.test.ts` checks
this).

## Keys

| Fingerprint                                | Created              | User ID                                                 | `trusted_until`                     |
| ------------------------------------------ | -------------------- | ------------------------------------------------------- | ----------------------------------- |
| `5de3e0509c47ea3cf04a42d34aee18f83afdeb23` | 2017-08-16T15:44:01Z | `GitHub (web-flow commit signing) <noreply@github.com>` | `1705435200` (2024-01-16T20:00:00Z) |
| `968479a1aff927e37d1a566bb5690eeebb952194` | 2024-01-16T18:05:42Z | `GitHub <noreply@github.com>`                           | `null` (open)                       |

The 2017 key is retired by closing its window, never by removing it (§9.1),
so landings it signed before then still verify. The time is GitHub's:
"The previous GPG key expired on January 16, 2024 20:00:00 UTC." — GitHub
blog, "Rotating credentials for GitHub.com and new GHES patches",
2024-01-16,
https://github.blog/news-insights/company-news/rotating-credentials-for-github-com-and-new-ghes-patches/

## Changing it

When GitHub rotates again: add the new key as a new entry, and set the old
key's `trusted_until` to the time GitHub stops signing with it. Record the
fetch (URL, time, SHA-256) and the citation for the window here, and replace
`github-web-flow.gpg` with the new fetch.

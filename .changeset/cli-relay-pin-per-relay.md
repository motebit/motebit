---
"motebit": major
---

The CLI uses a relay key only for the relay URL that key signs. It used to hold one relay key (`relay_public_key`) for every relay, so a session on relay B could use relay A's key on the paid peer-to-peer path: the fee destination was derived from A's key, the client broadcast the payment, and B rejected the task. The owner had paid for nothing.

The CLI now keeps one key per relay URL in `relay-pins.json` (in the config directory, mode 0600). REPL startup, `motebit delegate --sovereign` and the `--grant` pre-flight read only that record, decided once per process, and never fall back to `relay_public_key`. An entry is written only when the relay proves the key for the URL you name it by (its signed metadata names that URL, and its signed transparency declaration names the same key and relay id) and that key is the one this install already holds. `motebit register` writes the entry after everything it does today; an existing install gets its entry on the next start with no action, when its relay signs its URL. An entry is never replaced.

`motebit register`'s own behaviour, the legacy `relay_public_key` field, its PIN MISMATCH rule, `motebit verify-release` and `create-motebit rotate` are unchanged. The implementation half in `@motebit/runtime` is in the sibling changeset `cli-relay-pin-per-relay-ignored.md`.

## Migration

Four groups stop getting a relay key until the remedy is applied. Without a key, paid peer-to-peer is off: REPL delegation runs relay-mode, `motebit delegate --sovereign` exits 1 naming the remedy, and the `--grant` pre-flight reports the relay pin as a blocker. Nothing is paid.

**1. A relay that signs no URL** — a `motebit relay up` started without `--federation-url`, a `pnpm run dev` relay, or a self-hosted relay without the endpoint variable.

**Before:**

```bash
motebit relay up
motebit register --sync-url http://localhost:3000   # pinned; --sovereign worked
```

**After:** start the relay so that it signs its URL, then register against exactly that URL.

```bash
motebit relay up --federation-url http://localhost:3000
# or, for the relay service:
MOTEBIT_FEDERATION_ENDPOINT_URL=http://localhost:3000 MOTEBIT_FEDERATION_ENABLED=false pnpm run dev

motebit register --sync-url http://localhost:3000
```

`--federation-url` turns federation on for that relay; `MOTEBIT_FEDERATION_ENABLED=false` keeps it off for the relay service.

**2. An install whose saved relay URL is an alias** of the URL its relay signs (for example an old default hostname). The message names the URL the relay signs.

**After:**

```bash
motebit register --sync-url <the URL the relay signs>
# and change the flag, MOTEBIT_SYNC_URL or the saved sync_url to that URL
```

**3. A second relay.** `motebit register` against a relay whose key differs from `relay_public_key` still exits 1 with PIN MISMATCH, as before. What changes: a session that names that second relay anyway now gets no key instead of the first relay's key. That is the fix. The remedy is the one PIN MISMATCH already gives: verify the relay's key out of band, remove `relay_public_key` from `config.json`, and run `motebit register --sync-url <relay>`. One install still holds a legacy key for one relay at a time.

**4. A first start that cannot reach the relay**, reaches it more slowly than five seconds, or names it by a URL that redirects — and a relay URL written with a backslash, a tab or newline, `?`, `#` or `@`. The entry is attempted once per process, so that session runs without a key; the next start tries again. Until an install has its entry, a start can wait up to about ten seconds on the two requests, and five more on the record's lock.

**After:** run `motebit register --sync-url <relay>` when the relay is reachable; name a redirecting relay by the address it redirects to; name the relay by a plain `http(s)` address. A relay whose real path contains `@` has no remedy in this release.

If `relay-pins.json` is damaged, no key is used and `motebit register` exits 1 before prompting: move the file aside (the entry is re-established on the next start), or upgrade the CLI when the file was written by a newer version.

**Why:** the fee leg of a paid peer-to-peer delegation is an irreversible onchain payment to a treasury derived from the relay's key. A key recorded without the relay it belongs to cannot be used safely on any other relay, and "one key for all relays" made the wrong payment the default whenever a session named a different relay. Binding each key to the URL the relay itself signs is the smallest rule that makes the wrong payment unrepresentable; the cost is that a relay must sign its URL before the CLI will pay through it.

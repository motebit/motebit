---
"motebit": major
---

The CLI uses a relay key only for the relay URL that key signs. It used to hold one relay key (`relay_public_key`) for every relay and pass it for whichever relay a session named.

With relay A's key held and a session on a second relay B, a paid peer-to-peer delegation (`motebit delegate --sovereign`, or paid delegation from the REPL) was a wrong payment in the ordinary case. A current relay answers the payment pre-flight (`p2p-eligibility`) with the amounts to pay, and with those amounts the client builds the payment without reading any signed relay document: it broadcast one payment whose fee leg went to the treasury derived from A's key, and B then refused the task. The owner had paid a worker, and A's fee, for nothing. That happened whether B served its own signed documents or none at all, and also when B served copies of A's documents or redirected the metadata read to a copy that verifies under A's key.

The one case the client stopped before paying was a relay whose pre-flight answer carries no amounts (an older relay) and which serves its own signed documents: the client then read the fee rate from the relay's signed metadata, which must verify under the key it holds, and refused (`relay_fee_rate_unverified`).

After this release none of these builds a payment, because the key is not passed at all: a key is recorded for a URL only when the relay's signed metadata names that URL (read without following redirects), its signed transparency declaration names the same key and relay id, and that key is the one this install already holds.

The CLI now keeps one key per relay URL in `relay-pins.json` (in the config directory, mode 0600). REPL startup, `motebit delegate --sovereign` and the `--grant` pre-flight read only that record, decided once per process, and never fall back to `relay_public_key`. An entry is written only when the relay proves the key for the URL you name it by (its signed metadata names that URL, and its signed transparency declaration names the same key and relay id) and that key is the one this install already holds. `motebit register` writes the entry after everything it does today; an existing install gets its entry on the next start with no action, when its relay signs its URL. An entry is never replaced.

`motebit register` keeps its order, its messages, the legacy `relay_public_key` field and its existing PIN MISMATCH rule, and gains two exits with code 1:

- **a damaged `relay-pins.json`**: `register` exits 1 naming the file as its first act, before the passphrase prompt and before any request;
- **a per-relay PIN MISMATCH**: after the bootstrap and the existing legacy pin step have run, when `relay-pins.json` already holds an entry for this relay under a different key than the one the relay just proved (and that proved key is the install's legacy key), `register` exits 1 naming the file and the entry to remove after out-of-band verification. The registration itself has already succeeded by then, and if the legacy key was unset the existing step has already written it.

Every other outcome of the added step (no key established, the legacy key not matching, the record locked or unwritable) is a warning with the exit code `register` had before. `motebit verify-release` and `create-motebit rotate` are unchanged. The implementation half in `@motebit/runtime` is in the sibling changeset `cli-relay-pin-per-relay-ignored.md`.

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

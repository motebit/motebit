# Machine roster, part B: the relay stores and observes, and never reduces

Status: design note, **before code**. v3.1 takes every change from one adversarial design review (verdict "sound with required changes", recorded in §5). It replaces the design behind #698 (withdrawn after review round 2) and the parked note v2 ("chain rooted in signatures").

Law, already merged: `spec/machine-roster-v1.md`, `verifyHostRoster` in `@motebit/crypto` (#697). Doctrine: `docs/doctrine/machine-roster.md`.

## 0. Why a third design

**#698 (round 2).** The relay had two notions of "enrolled": the rows it holds, and what the law makes of them. Round 1 moved "is it retired?" to the law but left member listing, liveness binding and recording on raw rows. The round-1 fix created a finding of its own: a device linked without key transfer could enrol itself and light a roster line. On top of that, a verdict cache went stale on rotation.

**Note v2 (design-reviewed, never built).** It rooted the relay's key chain in signatures (`verifySovereignBinding` of the genesis key, then verified succession links, else `known: false`). It was sound on paper and inert in practice.

**The production data (2026-09-25, read-only query on the live relay, schema v42):**

| Fact                                                        | Count  |
| ----------------------------------------------------------- | ------ |
| Identities with device rows                                 | 50     |
| Device rows                                                 | 120    |
| Identities with a proven key holder (`identity_keys`, #703) | **9**  |
| Identities with exactly one device                          | 48     |
| Identities with 15 and 57 devices                           | 1 each |

Any design in which the relay acts on the law under its own knowledge of a motebit's key does nothing for at least 41 of 50 identities (82%). #703 did not change that, because it only records keys it has evidence for. Nor will time change it: the machines the roster exists for (daemons, VPS hosts) are exactly the ones whose relay-side key knowledge is thinnest.

The spec text that #698's branch added (§11, not yet on main) already says what the relay should do: **"The store does not reduce. It returns the set; the consumer reduces it (§6) against a key chain the consumer verified."** #698's round-1 fix broke that sentence, because relay housekeeping called `verifyHostRoster`. v3 takes the sentence literally.

## 1. The one rule

> **The relay holds the signed set, verbatim, and records liveness per device. It never evaluates the roster law, never decides membership, and never computes a quantity over machines.** Every consumer that needs "the machines of this motebit" reduces the served set itself, under a key chain it verified.

Every design choice below follows from this rule. A relay that cannot compute a roster cannot compute a wrong one: the #698 finding class (a relay-lit line the law rejects, or a relay verdict that went stale) has no code path to live in.

## 2. Decisions

**D1 — Storage.** Keep #698's table: `relay_host_roster_entries(motebit_id, entry_id, kind, signer_key, body_json, received_at)`. `entry_id` is the law's id (sha256 of the signed body). `signer_key` is the key the entry names; it is what the partitioned caps in D2 count by. Ingest is an idempotent union with no freshness window. The first copy that verifies is held (the spec requires verify-before-hold). The migration takes the next free version, because v41 and v42 are now taken on main.

**D2 — Ingest verification, and caps partitioned by signer key.** An entry is held when all three hold:

- it passes the strict guard and the wire schema;
- its `motebit_id` equals the path id, and the caller is that motebit (D5);
- its signature verifies under **the key the entry names** (suite-dispatch).

There is **no `untrusted_key` check.** The relay has no trusted chain for 82% of identities, and it must hold entries under rotated-away keys anyway.

The caps are **partitioned by signer key** (review F2):

- An entry whose `signer_key` equals **the key the caller's token verified under** goes into that key's own bucket (512 enrolments, 2048 retirements). Only a holder of that key can fill it.
- Every other signer key shares one **foreign bucket** (proposed: 256 entries). It exists to replicate the lines of other epochs.
- Refusal in either bucket is `roster_full`. A partial presentation gets 422.

**Stated residual.** Whoever fills a key's own bucket holds that key. A thief of an old key can therefore fill only that old key's bucket, and a rotation moves the sovereign to a new, empty one. The foreign bucket is shared, so a key-holder can exhaust it. The worst that can then happen is that superseded lines from other epochs stop replicating through this relay. An **active** line is never lost this way: it is signed by the current key, and the current key's holders are the only writers of its bucket. This needs the auth middleware to expose the key it verified under. That is an additive `onVerified(key)` callback beside `onReject` in `auth.ts`, the same contract as D4.

**D3 — Entries are never pruned, and there is no removal path.** An entry is never removed by age. Retirements must stay, because remove-wins needs them present, and a machine silent for a year is still a line (doctrine). The relay has **no per-identity erase** of first-person data today (review F6: its only deletes are TTL and horizon sweeps, and `devices` is declared indefinite). So roster entries are declared **"indefinite; no removal path exists"**, with the same honesty as `device_registry`, plus a `different_mechanism` honest-gap line in the retention manifest. The partitioned caps bound growth.

**D4 — Liveness: captured at verification, keyed by device and key, and persisted only for hosts.**

- **`bound_under` is captured when the token is verified:** the key returned by the same `devices` row read that verified the socket's token, delivered through `onVerified(key)`. It is stored on `ConnectedDevice` and **never re-read** (review F1). Rotation rewrites device rows (`succession-apply.ts`) and closes no sockets, so re-reading would let a socket opened under the old key read as bound under the new one.
- **Persisted rows are keyed by `(motebit_id, device_id, bound_under)`**, so two holders of different keys claiming one `device_id` never overwrite each other. Each row holds `last_seen_at` (one overwritten value) and `observed_by`.
- **Only a verified socket that announces `unattended_runtime` gets a persisted row** (review F5). "Verified" means its token verified and its `did` equals the claimed `device_id` (`deviceIdVerified`). Phones, browsers and desktops leave no stored record, which matches the doctrine's scope and spec §8's "one value per member". Master-token and `enableDeviceAuth=false` sockets are never bound.
- **`last_seen_at` is written at bind, at close, and on the coarse periodic flush,** not only at data-frame time (review F4). Clients send no periodic frames, so an idle daemon would otherwise age while connected.
- **`socket_open` is never persisted.** GET computes it from `connections`: an open-socket count per `(device_id, bound_under)`. That count is also `motebit doctor`'s hint for a copied `device_id`.
- **Retention.** The TTL sweep on `last_seen_at` (proposed: 90 days) skips any row with a live bound socket. GET serves the retention window and `observing_since`, so a consumer can say "not observed in the last 90 days" rather than "never seen". The doctrine's liveness bullet and spec §8 are amended in the same PR, and the declaration block is rewritten, not reused.

**D5 — First-person, built as "caller present and equal".** Both routes require `callerMotebitId` to be **present and equal** to the path id (review F7). #698's `requireFirstPerson` passed when it was unset, which is exactly the master-token case. The operator master token therefore gets 403, and a test pins it. The token audience is named explicitly, never left to the `admin:query` default. Service-mode molecules have no device row and cannot use these routes, and the note says so.

**D6 — The consumer joins; the relay never does.**
`GET` returns:

```
{ motebit_id, enrollments, retirements,
  liveness: { observed_by, retention_days, observing_since,
              rows: [{device_id, bound_under, last_seen_at, sockets_open}],
              live_unenrolled: [{device_id, bound_under, sockets_open}] } }
```

Here `rows` is the persisted rows plus live bound host sockets, and `live_unenrolled` is live bound sockets with no persisted row.

The consumer does the following:

1. **Obtain the full key chain** (review F3). No client holds a local succession chain today: key transfer carries only the seed. So the chain is a pinned local anchor (the key held, or the signed `motebit.md`), extended by the public `GET …/succession` and verified **extension-only** against the last chain it accepted. It is refreshed before any universal claim, and every claim cites the chain head.
2. **Reduce** with `verifyHostRoster` under that chain.
3. **Join.** For each active machine, attach the row with the same `device_id` and `bound_under` equal to the enrolment's `public_key`.
4. **Classify** the rows left over:
   - (a) that machine's `device_id` under a **different key** is shown as "this machine's id, connected under a key that is not its enrolment's". That is the theft signal, never "not in the roster".
   - (b) a `device_id` with no line is shown as "connected, not in the roster", beside the set.
   - (c) an `untrusted_key` refusal whose `device_id` has liveness is shown as "your chain may be stale — refresh".

If there is no usable chain, the consumer shows **no roster**, never an empty one.

**D7 — Fan-out without quantification (sets up #687; not built here).** The command route sends to every open socket bound under `deviceIdVerified` for the motebit. Each answer line carries `device_id` **and `bound_under`**. The route returns those lines, the raw entry set, and the liveness block, and never reports "N machines", "all" or "none". The client marks an enrolled machine **reached only when a line's `bound_under` equals the enrolment key**, names an enrolled machine with no such line `unreached`, and quantifies over membership. The drift gate allows exactly three reads of the entry table: the per-signer-key cap count, the insert-or-ignore, and GET serialisation.

**D8 — Clients (part C; named here so D6 is buildable).**

- `run` and `serve` mint one enrolment per machine on first unattended start, cache it, and present the full cached set, retirements included, after every `registerWithRelay`. They send it in chunks within the per-request limit, and treat anything other than every chunk being taken (a 413 included) as not taken.
- `motebit machines` reduces and renders.
- `motebit machines retire <device_id>` signs and presents a retirement.
- The phone gets the equivalents in the same pass.
- After a rotation, a machine that was active re-enrols under the new key (law note 6).

## 3. What this removes, and what it keeps from #698

**Removed, with no replacement:**

- `relayKeyChain`
- `rosterStatus` and its cache
- `isBoundToRosterLine`
- law-driven recording and pruning
- `untrusted_key` at ingest
- `requireFirstPerson` as written

**Kept:**

- canonical storage keyed by the law's id
- idempotent union
- 422 for a partial presentation, 400 for a malformed field
- `deviceIdVerified` and `onPeerClosed` on the ws route, and the first ws-route tests
- `observeHostConnection` as the one door to the liveness record, re-keyed per D4
- the shutdown flush
- spec §11 appended at the end, amended

**Rewritten:**

- the declaration block and PRIVACY.md render (D3, D4)
- the caps (D2)

## 4. Increments

- **B1:** the auth additive `onVerified(key)`, with its tests.
- **B2:** store, ingest and partitioned caps.
- **B3:** liveness per D4.
- **B4:** the routes per D5 and D6.
- **B5:** the declaration, the retention manifest, and the spec and doctrine amendments.

B1 through B5 ship as **one PR**: create never ships without its declaration. The clients (part C) and #687 follow.

**Filed separately, not part of this PR:** rotation closes no sockets bound under the retired key, so such a socket keeps receiving sync traffic (review F8).

## 5. Design review record (2026-09-25)

Verdict: **sound with required changes.** The one rule held. Every change below has been taken into §2.

| Finding | Severity     | Change                                                                                                                                        | Where  |
| ------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F1      | BLOCKING     | `bound_under` captured at verification, never re-read; rows keyed with the key; a theft class added to the consumer                           | D4, D6 |
| F2      | BLOCKING     | cap-fill by a key-transfer-less device or an old-key thief was permanent under D3; caps partitioned by signer key                             | D2     |
| F3      | Required     | no client holds a succession chain; the full chain comes from anchor plus public `/succession`, extension-only, cited                         | D6     |
| F4      | Required     | `socket_open` never persisted; idle daemons were aging out; the sweep skips live rows                                                         | D4     |
| F5      | Required     | persisting every device contradicted doctrine and spec §8; now hosts only, and "not observed in 90 days" is distinguishable from "never seen" | D4     |
| F6      | Required     | no per-identity erase exists; declared as a gap                                                                                               | D3     |
| F7      | Required     | first-person means caller present and equal; master-token test                                                                                | D5     |
| F8      | Non-blocking | fan-out lines carry `bound_under`; socket-close-on-rotation issue                                                                             | D7, §4 |
| F9      | Non-blocking | chunked presentation; audience named; service-mode molecules excluded                                                                         | D5, D8 |

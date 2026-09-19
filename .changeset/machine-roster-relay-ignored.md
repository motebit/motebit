---
"@motebit/relay": minor
---

The relay's half of the machine roster: it stores what the sovereign signed, serves it back unchanged, and reports beside it — never inside it — what it has observed about each machine's connection. Increment 1, part B of `docs/doctrine/machine-roster.md`; the law it implements landed in #697.

**Membership.** `POST` / `GET /api/v1/agents/:motebitId/roster` (`spec/machine-roster-v1.md` §11). Entries are schema-parsed, **verified under the key they name before they are held** — the entry id excludes the signature, so an unverified copy could squat a slot and turn the authentic one into a no-op — and stored as canonical JSON keyed by the law's id, so `INSERT OR IGNORE` _is_ the idempotent union. There is no freshness window: a surface re-presenting its set after a data loss presents entries that are months old, and refusing them is how the offline machine vanishes. Entries under keys the motebit has rotated away from are still held, because after a rotation those lines are how a consumer sees the machine that was cut off. A partial presentation is a **422**, not a 200 over a body someone must remember to read. The relay does not reduce the set; a consumer does, against a key chain it verified.

**Liveness.** One overwritten `last_seen_at` per machine — never a history — written through a single function shared by the socket's close hook and a coarse flush in the supervised cleanup loop, and only for a socket whose signed token **proved** its device id on a machine the motebit enrolled. The relay keeps nothing about when an unenrolled device came and went. It is served under `observed_by: "relay"` as `socket_open`, not `connected`: there is no heartbeat with a deadline yet, and the honest word is the one that says only what is known. Deleted 30 days after a machine's retirement; never aged out while the machine is active — "not seen for a year" is what the line is for.

**The socket.** `ConnectedDevice.deviceIdVerified` — the declared `device_id` equals the `did` of the signed token the connection authenticated with. `?device_id=` alone is a query string. And the relay's WebSocket route gets its first tests: it had none.

**Both routes are first-person**, and the privacy declaration says so: `DECLARATION_CONTENT.retention.machine_roster` names both tables, what is observable, the retention windows, and that a roster is never published, ranked, aggregated, or served to another identity. `PRIVACY.md` re-rendered.

Nothing consumes the roster yet. The many-machine refusals in `command-route.ts` still count live sockets; they move to membership with #687 and #681. Migration v41.

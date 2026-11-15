---
"motebit": patch
---

`motebit --grant <id>` and `motebit serve --direct --grant <id>` no longer present a standing grant on a turn where the relay's revocation feed could not be read. A timeout, a network error, a non-2xx answer or a body that is not the feed used to count as "nothing revoked", so a grant revoked on another machine still verified whenever the relay was unreachable. Now a failed pull presents no grant for that turn: in chat, money actions ask for approval; on a direct task they are refused. The session says so once, in one line. With no relay configured, or when the pull succeeds, nothing changes. Not covered: a relay that omits a revocation, or a wrong relay URL (the feed is unsigned).

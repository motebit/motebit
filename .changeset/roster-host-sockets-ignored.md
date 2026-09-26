---
"@motebit/relay": patch
---

**The roster GET serves the host count beside the session count.** Every liveness row and every `live_unenrolled` entry now carries `host_sockets_open`: the open sockets on that `(device_id, bound_under)` pair whose device id is verified and that announce `unattended_runtime`. This is the host's liveness. `sockets_open` keeps its meaning, every bound socket: something is attached. They are two quantities, because the desktop app shares the CLI daemon's `device_id`. A retired machine with only a desktop session open must still read connected. That same session must never read as a running host.

One predicate, `livenessKeyOf`, counts `host_sockets_open`. It also writes `last_seen_at` and decides the 90-day sweep's live-skip. A row kept alive only by a non-host socket is now swept, and that socket is then served in `live_unenrolled` with `host_sockets_open: 0`. `sweepHostLiveness` takes the connection map instead of a callback. The change is additive on the wire: older clients read `sockets_open` exactly as before. `spec/machine-roster-v1.md` §8/§11, the transparency declaration and `PRIVACY.md` are amended to match. The host count is derived from the same live connections, and nothing new is kept.

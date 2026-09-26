---
"@motebit/relay": patch
---

Two machine-roster relay fixes found by a post-merge review.

**`Retry-After` is readable from a browser.** The relay's CORS middleware now sends `Access-Control-Expose-Headers: Retry-After, X-Motebit-Content-Manifest`. Neither header is CORS-safelisted, so page JavaScript in a browser or the Tauri webview read both as `null`: the web and desktop roster clients never honoured a 429's back-off, and `@motebit/state-export-client` in a browser saw no manifest on a signed state export. React Native's fetch was unaffected. The list is `CORS_EXPOSED_RESPONSE_HEADERS` in `middleware.ts`, named with its readers.

**`sockets_open` counts host sockets only.** A liveness row's `sockets_open`, the persisted `last_seen_at` write and the TTL sweep's live-skip now use one predicate, `livenessKeyOf`: a socket counts only when its device id is verified and it announces `unattended_runtime`. The desktop app shares the CLI daemon's `device_id`, so before this a dead daemon read as open while the desktop was connected, both together read 2 (which clients print as "two machines may share this id"), and the desktop alone kept a stale daemon row from ageing out. `sweepHostLiveness` now takes the connection map instead of a callback. `live_unenrolled` is unchanged. `spec/machine-roster-v1.md` §8/§11 is amended to match.

The signed transparency declaration (`DECLARATION_CONTENT.retention.machine_roster`) and `PRIVACY.md` now say the same: live sockets are reported as a count per device and key of host sockets only, and a liveness row is kept past 90 days only while a host socket on its pair is open.

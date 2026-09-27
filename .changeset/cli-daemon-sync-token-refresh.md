---
"motebit": patch
---

**`motebit run` and `motebit serve` stay reachable after five minutes** (#820). Each daemon's relay socket authenticates with a signed sync token, and a signed token expires after 5 minutes. The socket reconnects on its own after a sleep, a network flap or a relay deploy, and each reconnect presents a token again. Both commands used to mint one token at startup and reuse it on every reconnect, so any reconnect after five minutes of uptime was refused. The daemon then stayed disconnected for good: no remote halt reached it, and the machine roster watched it go.

Both commands now build their socket with `createRelaySyncSocket`, which passes the socket a credential source. The socket resolves that source on every connect, and it mints a fresh sync token from the device key each time. When no signed token can be minted (no device id or no key), it falls back to the configured sync or master token, as before.

---
"motebit": patch
---

`motebit machines` no longer mistakes a desktop session for the machine's daemon.

Where the relay serves `host_sockets_open`, the roster reads it for two things: whether an active machine is running ("the relay believes a socket is open"), and the "two machines may share this id" hint, so a desktop app or an interactive CLI beside the daemon no longer trips it. An active machine with only a session open says "a session (not the host) is connected" beside when it was last seen.

"Retired, but connected", a device that is not enrolled but is connected, and the check that a device holds the current key still read `sockets_open` (any bound socket), because a session proves those exactly as a daemon does. Against an older relay that does not serve the field, behaviour is unchanged.

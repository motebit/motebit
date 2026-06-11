---
"motebit": minor
---

One coordinator runtime per machine — the CLI adopts the runtime-host election (daemon-desktop unification, increment 2). Every entry point elects before constructing a runtime: the first motebit process binds `~/.motebit/runtime.sock` and coordinates; the rest attach or refuse honestly.

- `motebit run` and `motebit serve` are coordinator-role: a second start no longer silently runs a parallel authority over the same identity key and database — it exits naming the live coordinator's pid. This is the single-instance enforcement the unification doctrine called for.
- The bare `motebit` REPL attaches as a rendering frontend when a coordinator (for example a running daemon) is live: chat, `/invoke`, and approval votes proxy over the local socket with a device-key-signed `runtime:attach` handshake. The coordinator acts; the terminal renders. `/exit` leaves the coordinator running.
- Authority cannot be asserted over the socket: wire-supplied options are narrowed to a rendering-safe subset before reaching the runtime — grant and attestation fields are stripped at the boundary.

No flags, no migration: with no coordinator running, every command behaves exactly as before (and now also serves the socket for later frontends).

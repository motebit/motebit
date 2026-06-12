---
"motebit": minor
---

`motebit serve` alongside a running coordinator now attaches instead of refusing — an MCP frontend over the coordinator's interior (daemon-desktop unification, attach-mode parity). Tools are listed pre-filtered by the coordinator's policy gate and execution is re-validated coordinator-side regardless of the frontend's pre-flight; memory writes run the coordinator's governance with `peer_agent` provenance; the synthetic chat tool rides the chat frame. An attached serve opens no database handle, registers nothing with the relay, and runs no worker mode — `motebit_task` is absent because signing authority never proxies over the socket; the coordinator stays the machine's one authority and its one relay presence.

Desktop slash commands gain the same parity: an attached window's `/state`, `/memories`, `/gradient`, and the rest of the shared command layer execute on the coordinator (validated against the command registry), and `/sensitivity` reads and sets the coordinator's live gate — the tier you see is the tier that actually gates.

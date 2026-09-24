---
"@motebit/relay": patch
---

A halt is refused on a many-machine motebit rather than stopping one of them.

The halt store is local and nothing replicates it, and the relay delivered first-wins. So a sovereign with a daemon on a laptop and a worker on a VPS had one machine stopped and one still working — and got back the stopped one's acknowledgement, which reads as "stopped" for a motebit that is still running. That is the worst thing this vocabulary can do, so it is refused instead. "I cannot do this from here" is survivable; "stopped" about a motebit that is running is not. The refusal says which configuration caused it and what would have gone wrong, and touches neither machine.

`approvals` and `runs` already refuse a many-machine motebit because their answer _is_ a per-machine database. This is a different reason — nothing here is about which database answers — so it gets its own sentence rather than being folded into that one.

**Reaching every machine is the right answer, and this is not it.** That was built, under issue #681, and withdrawn after five review rounds. A broadcast has to gather answers rather than race them (the machine with least to do answers first), name the machines that stayed silent, decline to synthesize a verdict the relay is not the authority on (`resume` reports `lifted`, not `acknowledged`; a goal-scoped halt is honourable only by the machine that owns the goal), and carry a status a partial result cannot be mistaken for success. Each round found another face of that, including two defects introduced while fixing the round before, and the fifth found a sibling surface — the phone's copy — left asserting delivery about a machine that was never reached. The story also needs `halt-status` composed (#687), or a sovereign can stop their motebit and not be able to see what stopped.

The work is preserved on `unattended/halt-broadcast-multi-machine` and issue #681 carries the five rounds as evidence. It costs nothing to wait: no motebit has unattended runtimes on two machines until the installer ships (#685) — which is also why the broadcast is worth building whole, once, against the multi-runtime harness rather than under review pressure.

Single-machine motebits — every deployment that exists — are untouched, and a test asserts it, alongside one proving that two processes sharing a device id are still interchangeable rather than read as two machines.

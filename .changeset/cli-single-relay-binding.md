---
"motebit": minor
---

Delegation follows one relay binding, and a paid result says which relay owes it.

The REPL, `/connect`, `motebit delegate` and the molecule runtime bind the runtime's single delegation relay (`bindRelay`) instead of enabling delegation and taps separately. Paid-result records in the SQLite ledger now name their relay (a new nullable column, migration #53; existing rows read with none). `/result <task>` for a payment owed by another relay than the one this session is on answers "owed by <relay> … nothing was sent" instead of asking the current relay (which answered "not found"). The hardware-attestation capabilities read after a hire goes to the relay of that hire, and nothing is read while no delegation relay is bound. So `motebit serve`, the daemon, and a REPL that has a sync URL but no delegation binding (no device key and no bound operator token) no longer make that read. That read only adds hardware-attestation scoring to a worker's trust record — it gates nothing — and part 4b (plan-step delegation under the binding) restores it for receipts that arrive outside a delegation call.

The `--pay-new-agents` option's documentation now names the binding it is forwarded into.

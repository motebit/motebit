---
"motebit": minor
---

Delegation follows one relay binding, and a paid result says which relay owes it.

The REPL, `/connect`, `motebit delegate` and the molecule runtime bind the runtime's single delegation relay (`bindRelay`) instead of enabling delegation and taps separately. Paid-result records in the SQLite ledger now name their relay (a new nullable column, migration #53; existing rows read with none). `/result <task>` for a payment owed by another relay than the one this session is on answers "owed by <relay> … nothing was sent" instead of asking the current relay (which answered "not found"). The hardware-attestation capabilities read after a hire goes to the relay of that hire, and nothing is read while no delegation relay is bound — `motebit serve` and the daemon bind none, so they no longer make that read.

The `--pay-new-agents` option's documentation now names the binding it is forwarded into.

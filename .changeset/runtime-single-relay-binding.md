---
"@motebit/sdk": minor
"motebit": minor
---

A paid-result record names the relay that owes its result, and delegation follows one relay binding.

- `@motebit/sdk`: `PaidIntentRecord` gains an optional `relay_url?: string` — the relay the paying call was bound to. Additive: a record written before it has none and is read from whichever relay is bound, as before. Stores that persist records should keep the field when it is present.
- `motebit` (CLI): the REPL, `/connect`, `motebit delegate` and the molecule runtime bind the runtime's single delegation relay (`bindRelay`) instead of enabling delegation and taps separately. Paid-result records in the SQLite ledger now name their relay (new nullable column, migration #53; existing rows read with none). `/result <task>` for a payment owed by another relay than the one this session is on answers "owed by <relay> … nothing was sent" instead of asking the current relay (which answered "not found"). The hardware-attestation capabilities read after a hire goes to the relay of that hire, and nothing is read while no delegation relay is bound (`motebit serve` / the daemon bind none, so they no longer make that read).

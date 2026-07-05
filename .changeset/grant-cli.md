---
"motebit": minor
---

`motebit grant` (money-execution Inc 4) — mint, inspect, and revoke standing-delegation grants from the CLI. `grant create --scope … --subject … --lifetime-usd …` signs a `StandingDelegation` whose `spend_ceiling` (standing-delegation@1.2) is the delegator's cryptographic commitment, plus the v1.0 PRE-MINTED tick schedule (one future-dated `not_before`-gated 1h `DelegationToken` per cadence slot — the signed token set IS the cadence). Money-grant shape enforced at mint: lifetime ceiling required, ≤30-day life (spec §6 D4). Artifacts stored verbatim at `~/.motebit/grants/<grant_id>.json` (files, out of the sync surface). `grant revoke` signs the terminal `DelegationRevocation` and best-effort propagates it to the relay cache; offline revocation still bites locally. `motebit --grant <id>` presents the due tick per REPL turn via the runtime's in-process `delegation` option — no due tick means an honestly grantless turn.

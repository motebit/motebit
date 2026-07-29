---
"motebit": minor
---

Paid-intent interlock: a delegation whose payment settled without delivering a result can never be paid for twice — mechanically, on every path.

The #433 fix told the model that money already moved; the last line of defense was still the model reading that message correctly, and on the standing-grant auto-execute path there is no human between a retry loop and real money at all. Now a session-scoped ledger, seeded only by verified settled-payment facts, refuses a duplicate hire of the same worker and capability before any broadcast (typed `intent_already_paid`, fail-closed, carrying the prior task and tx), and suspends all new paid delegation once two payments are outstanding. Enforcement lives inside the shared submit chokepoint, so the interactive loop path and the granted deterministic path cannot diverge.

Also from the standing-grant audit: `executeGrantedDelegation` no longer flattens a paid-but-undelivered hire into a bare failure code (the settled-payment facts now survive into the result and the operator log); `motebit grant show` and `grant list` display lifetime spend and remaining headroom read from the durable spend store; the session-start grant preflight shows headroom before the first spend and refuses arming on an exhausted ceiling; and metering real money against an in-memory spend store now warns that the lifetime ceiling re-arms on restart.

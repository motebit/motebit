---
"motebit": patch
---

An approval that expires can never end in silence again.

Approvals wait ten minutes; answering after the timer had voided one used to render nothing at all — an approved irreversible-money action ending with an empty prompt (witnessed live: the human approved, the runtime returned zero output, and only the blockchain could confirm no money moved). Now the expiry announces itself the moment the timer fires, a late answer renders a plain "this approval expired before your answer arrived — nothing was executed; no money moved," and the REPL prints an honest fallback if a resumed approval ever yields nothing. Every approval answer ends in a rendered terminal outcome.

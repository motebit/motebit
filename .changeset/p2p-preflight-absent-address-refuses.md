---
"motebit": patch
---

A paid P2P delegation now refuses when the relay's `p2p-eligibility` pre-flight does not confirm the worker's registered `settlement_address`. Before, an absent field skipped the registry comparison and the discovered address was paid unchecked. The pre-flight now refuses with `worker_settlement_unbound` before anything is priced, and the pre-broadcast re-check refuses (`p2p_ineligible`) if its second read omits the field, so nothing is broadcast. The current relay always returns the field for a worker with a registered address.

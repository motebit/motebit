---
"@motebit/web": patch
---

The chrome receipt-sign pulse fires only for a receipt whose `status` is `completed`. The runtime now signs a receipt for refused and failed tool calls too, so "a receipt was signed" no longer means "the act happened"; the pulse's documented meaning (completed and audited) is kept.

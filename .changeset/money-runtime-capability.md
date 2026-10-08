---
"motebit": patch
---

A standing grant now authorizes `motebit serve --direct --grant` and `motebit --grant` only when it was signed by this motebit's own identity (motebit id and key): a grant a stranger signed — including one naming the stranger as its own delegate — authorizes nothing. On `serve --direct`, an R4_MONEY tool whose spend is priced at call time is now metered against the grant's spend ceiling before it runs, as in chat; a task whose arguments the meter cannot price (no `amount_micro` and `counterparty`) is refused. Unchanged and still refused by design: an R4_MONEY task arriving by relay WebSocket dispatch carries no verified caller identity, so no grant clears it.

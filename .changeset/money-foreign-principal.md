---
"motebit": patch
---

`motebit serve --direct` treats every task submitter as a foreign principal: an R4_MONEY tool runs only when the presented standing grant's delegate is the caller the transport verified (motebit id and key), inside that grant's scope and ceiling. The owner's own grant (`serve --direct --grant <id>` with a `motebit grant create` self-grant) no longer authorizes another caller's money call, and a relay-dispatched task (which carries no verified caller identity) never clears R4. A grant revoked after `serve --direct --grant` or `motebit --grant` starts now stops authorizing on the next call: the stored grant, its revocation and the relay revocation cache are re-read at each presentation.

A standing grant now verifies only for the identity presenting it: `verifyGrantForTurn` refuses a grant whose delegate is not the presenter.

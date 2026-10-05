---
"@motebit/web": patch
"@motebit/runtime": patch
---

**The cobrowse chrome's receipt-sign pulse fires only for a signed receipt.** The pulse was driven by the tool-activity bus, which the runtime fires before signing and regardless of whether signing succeeds — so a call whose receipt signing failed closed still pulsed "signed". `wireReceiptSignPulse` (`apps/web/src/ui/cobrowse-chrome.ts`) now triggers on the receipts bus and joins the activity event's `args` by `invocation_id` only to pick the animation kind. Runtime and web doc comments state that tool activity means "attempted", never "signed". Desktop, mobile and spatial render no signed claim from the activity bus.

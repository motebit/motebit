---
"@motebit/web": patch
"@motebit/desktop": patch
---

v1.5 detach wiring (apps side). Companion to the published-side
changeset adding `buildComputerSessionReceiptArtifact` to
`@motebit/render-engine`.

Both `apps/web/src/computer-tool.ts` and
`apps/desktop/src/computer-tool.ts` accept a new optional
`onSessionReceiptSigned` callback. The close path fires it after
the audit `ComputerSessionSummarized` event lands — calm-software
ordering: record on the log first, surface emerges second.

`WebApp.emergeSessionReceipt(receipt)` and
`DesktopApp.emergeSessionReceipt(receipt)` are sibling methods that
build the artifact via `buildComputerSessionReceiptArtifact` and
hand it to `addArtifact` with `kind: "receipt"`. No-op when
`document` is undefined (test env).

Fail-soft chain unchanged: a throwing emerge callback does not break
the audit emit, which does not break the close event, which does not
break dispatcher teardown. Two new tests cover the emerge ordering
and the throwing-callback fail-soft.

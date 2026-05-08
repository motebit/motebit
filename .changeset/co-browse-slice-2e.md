---
"@motebit/protocol": minor
---

Co-browse Slice 2e — browser history navigation + click-ripple
feedback. The last slice before the "Chrome-feel" demo speaks.

**Three new parameter-less variants on `UserInputEvent`** —
`{ kind: "back" }`, `{ kind: "forward" }`, `{ kind: "reload" }`.
Server-side: `page.goBack` / `page.goForward` / `page.reload`,
all with `{ waitUntil: "domcontentloaded", timeout: 15_000 }`.
Empty-history semantics: `back` / `forward` against a session
with no matching history MUST be a no-op (Playwright returns
null; the wire treats null as 204 success). Matches real-browser
UX.

**Audit shapes are equally minimal** — `{ kind: "back" | "forward"
| "reload" }`. Nothing to redact; history navigation carries no
user-supplied data.

**Spec** — `spec/computer-use-v1.md` §5.5 documents all three
wire + audit variants and the empty-history no-op contract.

After this slice: click + type + paste + scroll + navigate +
back/forward/reload. The local end-state ("user can drive a
browser inside the slab") is now honest.

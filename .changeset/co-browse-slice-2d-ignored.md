---
"@motebit/runtime": minor
---

Co-browse Slice 2d — URL redaction helper + navigate audit branch.

`urlAuditDetail(url)` — pure function, exported alongside
`pasteAuditDetail`. Parses via the WHATWG `URL` constructor; on
success returns `{ scheme, host, has_path, has_query }`; on parser
throw collapses to all-`unknown`. Lowercases scheme and host for
canonical-form audit comparisons across replays. `pathname === "/"`
counts as no path (the bare-root case shouldn't trip the deep-link
flag).

`buildUserInputAuditDetail` gains a `navigate` branch. Symmetric to
the paste branch (wire → redacted detail through a single helper
call).

`forwardUserInput` and `CloudBrowserDispatcher.forwardInput` accept
the new wire kind transparently — no co-browse-input-specific code
path needed. Server-side dispatch is `page.goto`.

10 new redaction tests (host preserved, path/query stripped,
schemed and scheme-less variants, malformed URL fallback,
non-http schemes, content-never-logged structural checks).

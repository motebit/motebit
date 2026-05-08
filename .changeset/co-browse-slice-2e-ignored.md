---
"@motebit/runtime": minor
---

Co-browse Slice 2e — redaction branches for back / forward /
reload. Trivial pass-through (audit shape mirrors the wire kind
exactly; no parameters to redact, no coordinates to normalize).

`buildUserInputAuditDetail` gains three branches that return
`{ kind }` directly. The structural type-surface check exhausts
across all seven variants now (click, key, paste, wheel, navigate,
back, forward, reload).

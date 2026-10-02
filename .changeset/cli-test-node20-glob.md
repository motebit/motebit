---
---

Test-only: the #962 print-sanitizer scan in apps/cli uses `readdirSync({ recursive })` instead of Node-22-only `fs.globSync`, so it runs on Node 20 (engines `>=20`). No published behavior changes.

---
"@motebit/relay": patch
"@motebit/browser-sandbox": patch
"@motebit/web": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
"@motebit/spatial": patch
---

`@hono/node-server` ≥1.19.19 (GHSA-jpvv-r467-5p4w, fixed in 1.19.18): a backslash in the request path was parsed as a path separator, so a reverse proxy that allows or denies by path prefix could be bypassed. The upper-bounded override floor rises with it. GHSA-rmxm-3fg6-px4f (`serveStatic` decodes the path twice) is fixed only in 2.x and is not reachable: nothing in the repository uses `serveStatic`; recorded in `docs/security/dependency-triage.md`.

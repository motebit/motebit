---
"motebit": patch
---

The CLI now depends on zod ≥4.6.6, closing CVE-2023-54404 (unbounded issue accumulation on oversized arrays) in its own schema validation. The lockfile had held zod 4.4.3. The transitive `fast-uri` (≥3.1.9) and `ip-address` (≥10.7.4) floors under the MCP SDK are raised too.

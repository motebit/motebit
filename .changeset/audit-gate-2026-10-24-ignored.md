---
"@motebit/wire-schemas": patch
"@motebit/mcp-server": patch
"@motebit/relay-client": patch
---

zod ≥4.6.6 (CVE-2023-54404). zod 4.6 emits nullable fields as `"type": [T, "null"]` instead of `anyOf: [{T}, {null}]`. The six regenerated JSON Schemas in `spec/schemas/` accept exactly the same documents.

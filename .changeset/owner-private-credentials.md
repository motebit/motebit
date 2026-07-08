---
"motebit": patch
---

CLI credential reads (`motebit credentials`, `motebit export`) now send the least-privilege `credentials` / `credentials:present` audience tokens the relay requires for the newly owner-private credential + presentation routes.

---
"motebit": patch
---

Test-only: the CLI's vitest config installs the shared real-model guard (no unit test may load the real embedding model), and three scheduler tests inject a no-model embedding loader so they take the deterministic hash fallback.

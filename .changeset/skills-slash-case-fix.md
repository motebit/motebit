---
"motebit": patch
---

Replace inner `switch (provenance_status)` with an if/else chain in `slash-commands.ts`. The provenance-status branches were being misclassified as fake slash commands by `command-registry.test.ts`, whose regex scans every `^\s+case "X":` pattern in the handler source. No behavior change — identical badges returned for the same statuses.

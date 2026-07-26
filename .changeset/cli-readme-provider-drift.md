---
"motebit": patch
---

Fix npm README drift and complete the `--help` provider list. The README claimed 19 open specs (actual: 34), listed only 2 of the 7 supported providers, referenced `spec/skills-v1.md` as bare text that resolves to nothing on npmjs.com, and described the package as a "binary". The `--help` Providers section now documents `groq` and `deepseek`, which were fully wired but undocumented.

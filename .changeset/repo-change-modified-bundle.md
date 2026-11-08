---
"@motebit/verify": patch
---

`motebit-verify repo-change` (CI-on-PR mode) now judges a bundle the pull request modifies, as spec/repo-change-v1.md §9 requires ("every axis is still computed when a shape check fails"). A pull request that adds no bundle but modifies exactly one regular file under `.motebit/bundles/` still fails its shape checks exactly as before, and the file at the head is now judged on every axis: a second bundle under a grant whose first bundle already landed reads `authority: insufficient` with `authority.repo_change.grant_spent`, and `spent` is true, where before it read `authority: unknown` and `spent: false`. A deleted bundle still leaves no bundle to judge. No valid pull request verifies differently.

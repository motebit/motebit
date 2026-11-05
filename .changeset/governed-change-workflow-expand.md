---
---

The `governed-change` check (docs/proposals/governed-repo-change-v1.md, build step 5) in its expand state: `.github/workflows/governed-change.yml` runs `motebit-verify repo-change` in CI-on-PR mode on `pull_request_target`, from the trusted base checkout against the PR's commits fetched as fsck-checked objects into a bare store, and writes every verdict axis to the job summary. It reports and is not required; a PR that touches nothing under `.motebit/bundles/` concludes "not a governed change" without being judged. Repository tooling only: no published package changes.

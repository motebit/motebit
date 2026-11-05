---
---

No release. Commits GitHub's two web-flow commit-signing keys as the pinned set `.motebit/operator-keys/github.json` (`motebit/operator-signing-keys@1.0`; the 2017 key retired at 2024-01-16T20:00:00Z by closing its window), with provenance in the README beside it, and adds a real-vector test in `@motebit/verify` (test and fixture only, nothing published changes): a real GitHub-signed squash commit from `main` is accepted under the committed pins and refused when altered, unpinned or outside the signer's window.

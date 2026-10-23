---
---

No release from this change on `main`. The `@motebit/crypto` and `@motebit/state-export-client` source changes here (a guardian named only by the presented identity file never establishes binding; a malformed identity file never throws and never binds) were already released from the security-release line as `@motebit/crypto@4.0.0` and `@motebit/state-export-client@0.7.0`. This commit brings that source to `main`, and the same change sets `main`'s manifests to the published versions with the release line's changelog entries. Their changesets were consumed on the release line, so bumping again here would publish the same fix twice (crypto 5.0.0).

---
"motebit": patch
---

Skills v1 phase 4.5a — CLI install via the relay-hosted registry.

`motebit skills install` now accepts a relay address shape:

```text
motebit skills install did:key:z6Mk…/example-skill@1.0.0
```

The CLI fetches the bundle from the relay's `GET /api/v1/skills/:submitter/:name/:version` endpoint, re-verifies the envelope signature locally, asserts the relay-returned submitter matches the requested DID, then installs via the existing in-memory source path. Existing directory installs (`motebit skills install /path/to/skill`) are unchanged.

The local re-verify is the trust boundary — the relay is a convenience surface, never a trust root. A tampering relay returns bytes that fail verification on the consumer.

Spec: `spec/skills-registry-v1.md`.

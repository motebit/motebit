---
"@motebit/verify": minor
---

Add `motebit-verify content-artifact <body-file> --manifest <header-or-path>` subcommand — the canonical third-party verification path for relay-asserted (or motebit-asserted) C2PA-shape content-provenance manifests. Closes the producer-consumer asymmetry left open by the state-export-signing series: producers sign on every endpoint, but until now no consumer demanded the signature.

```bash
# Verify a downloaded state-export against the manifest from its HTTP header.
motebit-verify content-artifact ./audit-trail.json \
  --manifest 'eyJzdWl0ZSI6Im1vdGViaXQt...'   # base64url-encoded canonical-JSON

# Pin the expected producer (e.g. the relay key from /.well-known/motebit-transparency.json).
motebit-verify content-artifact ./audit-trail.json \
  --manifest ./audit-trail.manifest.json \
  --producer-key 7c4e9f...                    # 64 hex chars / 32-byte Ed25519

# Require a specific artifact-type from the ContentArtifactType registry.
motebit-verify content-artifact ./goals.json \
  --manifest 'eyJzdWl0ZSI6...' \
  --expect goal-list
```

`--manifest` auto-detects: a filesystem path that reads as JSON is treated as a manifest file; otherwise the value is base64url-decoded (the `X-Motebit-Content-Manifest` HTTP-header form). `--expect` values are sourced from `ALL_CONTENT_ARTIFACT_TYPES` in `@motebit/protocol` (closed registry, drift-gated). `--producer-key` adds an offline trust-anchor check pre-crypto: the manifest's declared `producer_public_key` must match the pinned hex byte-for-byte, otherwise reject with `producer_key_mismatch`.

Output mirrors the existing credential-verification path: human-readable by default, structured JSON with `--json`. Exit codes 0 (valid) / 1 (invalid with typed reason) / 2 (usage or I/O). Network-free, no implicit fetches — per the package CLAUDE.md Rule 3. Zero new cryptographic logic; consumes `verifyContentArtifact` from `@motebit/crypto` directly.

Doctrine: `docs/doctrine/self-attesting-system.md` (now lists content-artifact manifests alongside the other self-attesting artifact categories) and `docs/doctrine/nist-alignment.md` §8 (third-party verifier shipped).

---
"@motebit/crypto": minor
---

Add `signContentArtifact` + `verifyContentArtifact` + `ContentArtifactManifest` — content-artifact provenance for standalone artifacts that travel independently of the conversation context (memory exports, audit trails, plan dumps, future generated documents/media).

```ts
import { signContentArtifact, verifyContentArtifact } from "@motebit/crypto";

const content = new TextEncoder().encode("audit entry 1\naudit entry 2\n");

const manifest = await signContentArtifact(content, {
  artifactType: "audit-trail",
  producer: "did:key:z6Mk…",
  producerPublicKey,
  producerPrivateKey,
  claimGenerator: "motebit/1.x.x",
  invocation: { task_id: "task-42" },
});

// Transport manifest separately from content (C2PA-shape: HTTP header,
// sidecar JSON, embedded metadata). Recipient verifies:
const { valid, reason } = await verifyContentArtifact(manifest, content);
```

Two-step verification: SHA-256 content-hash recomputation + Ed25519 signature verification over the canonical-JSON manifest. Fail-closed with typed reasons (`content_hash_mismatch` | `signature_invalid` | `malformed_public_key` | `malformed_signature` | `unsupported_suite`).

Same canonical-JSON + Ed25519 + suite-dispatch pattern as `signExecutionReceipt` and `signSkillManifest` — nothing new at the crypto layer. Pinned suite `motebit-jcs-ed25519-hex-v1` today; PQ migration is a registry append (`@motebit/protocol`'s `SuiteAlgorithm` union pre-types ML-DSA-44/65 and SLH-DSA-SHA2-128s).

Closes the C2PA-shape provenance gap named in `docs/doctrine/nist-alignment.md` §8 (and previously deferred-with-reason). The primitive is the consumer-agnostic surface; relay state-export endpoints, future content-generation tools, and downloadable bundles all wire into the same shape.

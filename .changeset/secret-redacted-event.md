---
"@motebit/protocol": minor
---

Add `EventType.SecretRedactedFromEgress` + `SecretRedactedFromEgressPayload` — the privacy-egress audit event the runtime emits when `SecretRedactingProvider` masks credential-class secrets from an outbound payload to a non-sovereign provider. The sibling of `SensitivityGateFired` on the same axis (that records a BLOCKED crossing in a marked-sensitive session; this records a REDACTED one in an unmarked session), turning the otherwise-silent redaction into an inspectable trail. Strictly metadata — count + credential-class label names (e.g. `"API_KEY"`, `"JWT"`) + provider mode, never the secret content.

---
"motebit": minor
---

Add `motebit verify <kind> <path>` — a CLI subcommand that validates a
wire-format artifact against the published `@motebit/wire-schemas`
contract AND verifies its Ed25519 signature using the embedded
public key. Three kinds today: `receipt`, `token`, `listing`.

This is the proof point that closes the wire-schemas loop. A non-motebit
developer building a Python or Go worker can now check protocol
compliance with one command:

```sh
motebit verify receipt my-emitted-receipt.json
```

Output is structured per-check — schema, suite, signature (and time
window for tokens) each report independently, so a failure tells you
exactly what's wrong:

```
✓ OK  receipt  /path/to/receipt.json
  ✓ json       parsed 636 bytes
  ✓ schema     ExecutionReceipt v1
  ✓ suite      recognized: motebit-jcs-ed25519-b64-v1
  ✓ signature  Ed25519 over JCS body — verified with embedded public_key
```

`--json` flag emits a structured report for programmatic consumers.

Backward-compatible with existing `motebit verify <path>` for identity
files. Two-arg form (`verify <kind> <path>`) discriminates on the
kind keyword; one-arg form (or explicit `verify identity <path>`) goes
to the existing identity-file verifier.

Self-attesting in action: the verifier doesn't require trust in the
motebit runtime, just in the published schema and Ed25519 math.

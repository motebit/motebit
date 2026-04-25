# Python reference implementation — execution receipt verifier

A non-TypeScript reference verifier for `motebit/execution-ledger@1.0` §11 ExecutionReceipt. Single Python file, two PyPI dependencies (`pynacl` for Ed25519, `requests` for HTTP), no motebit code consumed at any step.

This example exists as a concrete proof — for one signed wire artifact — that the published specification is sufficient to verify motebit ExecutionReceipts third-party-implementably. Sibling to `examples/python-device-register/`: the device-register example proves the spec is sufficient to **submit** signed registrations; this verifier proves the spec is sufficient to **verify** signed receipts. Together they cover both ends of the cryptographic envelope (canonical JSON → SHA-256 → Ed25519 sign → base64url; inverse on the verifier side) that every signed motebit artifact shares.

Scope is deliberately narrow: §11 ExecutionReceipt exercises the suite (`motebit-jcs-ed25519-b64-v1`) every other signed wire artifact also uses, so passing this end-to-end is a load-bearing signal that the spec's description of the verification recipe is correct. Other receipt-shaped artifacts (`SettlementRecord`, `ConsolidationReceipt`, `AgentTrustCredential`) inherit the cryptographic primitive; their per-artifact wire shapes still need their own end-to-end pass when a third-party adopts them.

## What it does

Implements §11.3 verification per the spec:

1. Loads a receipt JSON from a file path, a URL, or stdin.
2. Validates §11.1 wire-format shape — required fields with the right types, suite identifier, status enum, optional `invocation_origin` enum, hex-encoded `public_key` (64 chars), hex-encoded `prompt_hash` / `result_hash` (64 chars).
3. Strips the `signature` field, JCS-canonicalizes the remaining body per RFC 8785.
4. base64url-decodes the signature; Ed25519-verifies against the embedded `public_key` (or a caller-supplied key when omitted, per §11.3).
5. Recurses into `delegation_receipts` per §11.5 — each nested receipt must independently verify, with a hard cap at the §11.5 RECOMMENDED maximum nesting depth of 10.
6. (Optional) Re-derives §11.4 `prompt_hash` / `result_hash` from supplied original content strings (`hex(SHA-256(UTF-8(content)))`) and asserts the receipt's hashes match.

## Installation

```bash
cd examples/python-receipt-verifier
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Verifying the committed fixture (offline)

The fixture under `fixtures/example-receipt.json` is a real signed receipt produced by a live conformance run against the relay. No network is required to verify it:

```bash
python verify.py fixtures/example-receipt.json
```

Successful output is the `VerificationResult` JSON with `"valid": true`, the recovered `public_key_hex`, and the `canonical_sha256` hash of the canonical body bytes (a useful diagnostic when comparing against a producer's debug output).

## Running the live round-trip against a local relay

The receipt verifier's interesting failure mode is wire-format drift between the spec and the relay's TypeScript implementation. The conformance test exercises that boundary directly:

```bash
# Terminal A — boot the relay (same recipe as python-device-register)
env PORT=3199 \
    X402_PAY_TO_ADDRESS=0x0000000000000000000000000000000000000000 \
    NODE_ENV=development \
    MOTEBIT_DB_PATH=":memory:" \
    npx tsx services/api/src/server.ts

# Terminal B — run the conformance test
python conformance_test.py http://localhost:3199
```

The conformance script:

- Generates a fresh Ed25519 keypair and self-registers a device (sibling-example flow, populating the relay's device record with the public key).
- Signs an ExecutionReceipt with the same key, verifies it locally, then submits to `/agent/:motebitId/verify-receipt` and asserts on the **body's** `valid` field.
- Tampers with one byte of `result` and re-verifies on both sides — both MUST reject.
- Re-derives §11.4 hashes from the original prompt and result strings; asserts equality.
- Builds a 2-deep delegation chain (§11.5); asserts `nested_count == 1` and the chain verifies.

### Captured live run (2026-04-25)

```
==> Generating Ed25519 keypair
motebit_id = 019dc3f3-6027-73ca-b877-0cf9141c0b72
device_id  = 019dc3f3-6027-7d66-9e74-963310dee4d8
public_key = cd7f51b9c11761ebde6e99d7ab095a5c86ebd4c0787a24d2c5f6bc797d4924aa

==> Self-registering the device against the relay
{ "motebit_id": "...", "device_id": "...", "registered_at": 1777109000243, "created": true }

==> Building a §11.1 receipt and signing it (Python pynacl + JCS)
task_id     = 019dc3f3-6035-7519-ad58-9dfce31f1f15
prompt_hash = eb5911406dca1c164556323ca01280851745b5ccb8c352fb03c039bf247a5ddd
result_hash = 4a95faaea77fa8e5b6f87a76524375cad17e73ea7878fb5c1a6191b00606a528
signature   = lehVTUerbGsAUlQLMhVqWPjwXvdNyLBqG7JO0-PbbTfuXFjPWLS3_YqMYDY6Fq2orWu4wINwJrVKoSahnOGXDA

==> Verifying with the local Python verifier (verify.verify_receipt)
{ "valid": true, "canonical_sha256": "445407920cb8e5...", "nested_count": 0 }

==> Submitting to /agent/:motebitId/verify-receipt — LIVE relay verifier
{ "valid": true }

==> Tampering: flipping one character of `result` and re-verifying
local verifier rejected tampered receipt: ['§11.2 violation: Ed25519 signature did not verify']
relay rejected tampered receipt:          {'valid': False}

==> §11.4: re-deriving prompt_hash and result_hash from original content
prompt_hash and result_hash both match SHA-256 hex of UTF-8 bytes

==> §11.5: building a 2-deep delegation chain and verifying it
{ "valid": true, "canonical_sha256": "38d89609661e...", "nested_count": 1 }

==> All §11.1 / §11.2 / §11.4 / §11.5 conformance checks passed.
```

This is the load-bearing demonstration: a Python verifier built against the spec alone agreed byte-for-byte with the TypeScript relay's verifier on every test case — including the negative tamper case, which rejects on both sides for the same cryptographic reason. The spec's JCS + Ed25519 + base64url envelope is portable across language stacks and library implementations.

## Verifying a receipt fetched from a relay

The relay archives full canonical receipt JSON under the admin endpoint `/api/v1/admin/receipts/<motebit-id>/<task-id>`; the bytes returned are byte-identical to what the signer signed (per `services/api` rule 11). Any party with admin access can fetch and verify directly:

```bash
python verify.py \
    --from-url https://relay.example/api/v1/admin/receipts/<motebit-id>/<task-id> \
    --bearer "$RELAY_ADMIN_TOKEN"
```

For relay-mediated tasks (every task that crossed the relay's settlement boundary on or after migration v10), this path is the canonical "pull a real receipt and verify it offline" loop the spec promises.

## What this proves

A successful verification means the receipt's cryptographic envelope round-trips through:

- A JCS implementation written from RFC 8785 alone — different than `@motebit/encryption.canonicalJson`'s Node implementation.
- An Ed25519 verifier (`pynacl`, libsodium) — different than `@motebit/crypto`'s `@noble/ed25519`.
- stdlib `base64.urlsafe_b64decode` with manual padding handling — different than `@motebit/encryption.fromBase64Url`.
- `hashlib.sha256` for §11.4 hash re-derivation — different than `@motebit/crypto`'s WebCrypto-or-noble dispatch.

If any of those four steps had a TypeScript-specific assumption — a field-ordering quirk only the TS canonicalizer produces, an over-eager base64 padding stripper, a Unicode normalization step the spec doesn't mention — the live round-trip step (Python signs → relay's TS verifier consumes) would reject the receipt with `{valid: false}` and the test would fail with a body-shape diagnostic that points at exactly which step disagreed. A passing test means every step agrees on the bytes.

## Conformance notes

The script's `jcs_canonicalize` is the same minimal subset of RFC 8785 that `examples/python-device-register/register.py` uses — sufficient for the receipt body's shape (ASCII strings, integers, arrays, nested objects, optional null/bool) and explicit about what it doesn't handle (floats raise an error rather than emit subtly-wrong canonicalization bytes). A production third-party verifier handling a wider message surface should use a complete JCS implementation such as [`pyjcs`](https://pypi.org/project/pyjcs/).

The signature suite hard-coded here is `motebit-jcs-ed25519-b64-v1` (JCS canonicalization, Ed25519 primitive, base64url signature encoding, hex public key). The execution-receipt schema (`spec/schemas/execution-receipt-v1.json`) declares this as the only valid value today; future post-quantum suites add a new entry to `@motebit/protocol`'s `SUITE_REGISTRY` and a corresponding verification path here without changing the wire format.

The conformance test's body-level inspection (`if not body.get("valid")`) is deliberate: per the dead-drop lesson recorded at `memory/lesson_hardware_attestation_self_issued_dead_drop.md`, the relay returns HTTP 200 with `{valid: false}` for semantic rejections. A test that short-circuits on `response.ok` would call a tampered-receipt rejection a successful round-trip — exactly the failure shape that hid a 926-line bug for 24 hours in the hardware-attestation pass earlier this session.

## License

Apache-2.0. Same license as the specification this implements.

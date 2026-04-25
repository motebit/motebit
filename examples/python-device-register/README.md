# Python reference implementation — device self-registration

A non-TypeScript reference implementation of `motebit/device-self-registration@1.0`. Single Python file, two PyPI dependencies (`pynacl` for Ed25519, `requests` for HTTP), no motebit code consumed at any step.

This example exists as proof that motebit's protocol surface is implementable from the published specification alone. If a third party stands up a Python — or Go, or Rust — service that talks to a motebit relay, the work looks structurally identical to `register.py` because the spec, not the TypeScript implementation, is the contract.

## What it does

Implements the `POST /api/v1/devices/register-self` flow (`spec/device-self-registration-v1.md`):

1. Generates a fresh Ed25519 keypair.
2. Constructs the §3 request body with a UUIDv7 `motebit_id` and `device_id`.
3. Canonicalizes the body per RFC 8785 (JCS) with `signature` removed.
4. Signs the canonical bytes with the private key.
5. base64url-encodes the signature and attaches it to the body.
6. POSTs to `/api/v1/devices/register-self`.
7. Parses the §5.2 response.

## Installation

```bash
cd examples/python-device-register
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running against a local relay

In one terminal, start the relay:

```bash
pnpm --filter @motebit/api dev
```

In another terminal, run the registration:

```bash
python register.py http://localhost:3001
```

A successful 201 response prints something like:

```json
{
  "motebit_id": "019d9a7c-...",
  "device_id": "019d9a7c-...",
  "registered_at": 1776239454547,
  "created": true
}
```

## Running against the staging relay

```bash
python register.py https://relay-staging.motebit.com
```

(Substitute your staging URL.)

## What this proves

A successful registration from this script means the relay accepted a request that:

- Was constructed from `DeviceRegistrationRequest` fields named in the spec, not in any TypeScript header.
- Was canonicalized with a JCS implementation written from RFC 8785 alone.
- Was signed with `pynacl`'s Ed25519 — a different library than `@motebit/crypto`'s `@noble/ed25519`.
- Was encoded with stdlib base64.urlsafe_b64encode + manual padding-strip.

If any of those four steps had a TypeScript-specific assumption (a field name only the TS code knew, a canonicalization quirk only `@motebit/encryption.canonicalJson` produced, a hex-vs-base64url confusion in the suite identifier, a padding mismatch on the signature), the relay would reject the request with HTTP 400. A successful 201 means the published spec is what the relay actually enforces.

## Conformance notes

The script's `jcs_canonicalize` is a minimal subset of RFC 8785 sufficient for the registration body — ASCII strings, integers, nested dicts, optional null/bool. It deliberately rejects floats with a runtime error rather than emit subtly-wrong canonicalization bytes. A production third-party implementation that handles a wider message surface (e.g., signing settlement records that carry float-shaped amounts) needs a full JCS implementation; the [`pyjcs`](https://pypi.org/project/pyjcs/) package or equivalent is suitable.

The signature suite hard-coded here is `motebit-jcs-ed25519-b64-v1` (JCS canonicalization, Ed25519 primitive, base64url signature encoding). The spec's §7 versioning section makes this additive: a future post-quantum suite is added by registering it in `@motebit/protocol`'s `SUITE_REGISTRY` and extending the relay's verification dispatcher. A third-party implementer adds a corresponding signing path here — the wire format and routing recipe stay identical.

## License

Apache-2.0. Same license as the specification this implements.

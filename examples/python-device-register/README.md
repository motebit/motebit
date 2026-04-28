# Python reference implementation — device self-registration

A non-TypeScript reference implementation of `motebit/device-self-registration@1.0`. Single Python file, two PyPI dependencies (`pynacl` for Ed25519, `requests` for HTTP), no motebit code consumed at any step.

This example exists as a concrete proof — for one endpoint — that the published specification is sufficient to build a working client without consuming any motebit TypeScript code. Scope is deliberately narrow: `POST /api/v1/devices/register-self` exercises the canonical JSON + Ed25519 signing + base64url envelope shared by the rest of motebit's signed-artifact surface, so passing this end-to-end is a load-bearing signal that the spec's description of those primitives is correct. Broader endpoints (`ExecutionReceipt`, `SettlementRecord`, dispute resolution, etc.) are not exercised here; verifying them third-party-implementably is incremental work. A future Python — or Go, or Rust — implementer of any motebit endpoint would write code structurally identical to `register.py` for the cryptographic envelope; the per-endpoint wire shape is what differs.

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

The relay's executable boot path is `services/relay/src/server.ts`, not `index.ts` (which is the library entry — side-effect-free at module load so embedders can import without binding ports). Boot it with the minimum env required:

```bash
env PORT=3199 \
    X402_PAY_TO_ADDRESS=0x0000000000000000000000000000000000000000 \
    NODE_ENV=development \
    MOTEBIT_DB_PATH=":memory:" \
    npx tsx services/relay/src/server.ts
```

`X402_PAY_TO_ADDRESS` is the only mandatory env var (any 0x-prefixed hex address suffices for local dev — settlement isn't exercised). `MOTEBIT_DB_PATH=":memory:"` keeps each run hermetic; for persistent dev use a path like `./data/relay.db`. Health probe:

```bash
curl http://localhost:3199/health
# {"status":"ok","frozen":false,"ws_connections":0,"timestamp":...}
```

In another terminal, run the registration:

```bash
python register.py http://localhost:3199
```

### Captured request/response (real run, 2026-04-25)

Request body the Python client built (canonical JSON, signed):

```json
{
  "device_id": "019dc34e-fd87-78c4-8714-c031b5ded150",
  "device_name": "python-reference-impl",
  "motebit_id": "019dc34e-fd87-744f-a4b1-0320bdef0d27",
  "public_key": "<64-char lowercase hex Ed25519>",
  "signature": "<86-char base64url no-padding Ed25519>",
  "suite": "motebit-jcs-ed25519-b64-v1",
  "timestamp": 1777098227054
}
```

Response body the relay returned (HTTP 201):

```json
{
  "motebit_id": "019dc34e-fd87-744f-a4b1-0320bdef0d27",
  "device_id": "019dc34e-fd87-78c4-8714-c031b5ded150",
  "registered_at": 1777098227089,
  "created": true
}
```

Server log line emitted on success (note the spec-conformant event name):

```
device.self_register.ok  motebitId=019dc34e-... deviceId=019dc34e-... created=true
```

This is the load-bearing demonstration: a Python client built against the spec alone produced a request the TypeScript relay accepted on first try, with no ad-hoc compatibility shims. The cryptographic step (Ed25519 over JCS-canonicalized bytes) is portable across libraries; the wire format (field names, suite identifier, base64url-no-padding signature encoding, JSON-over-HTTP envelope) is portable across languages.

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

If any of those four steps had a TypeScript-specific assumption (a field name only the TS code knew, a canonicalization quirk only `@motebit/encryption.canonicalJson` produced, a hex-vs-base64url confusion in the suite identifier, a padding mismatch on the signature), the relay would reject the request with HTTP 400. A successful 201 means the published spec is what the relay actually enforces — for this endpoint. Endpoints that share the same canonical-JSON + Ed25519 + base64url envelope (every signed artifact in motebit) inherit the proof at the cryptographic layer; their per-endpoint wire shapes still need their own end-to-end pass when a third party adopts them.

## Conformance notes

The script's `jcs_canonicalize` is a minimal subset of RFC 8785 sufficient for the registration body — ASCII strings, integers, nested dicts, optional null/bool. It deliberately rejects floats with a runtime error rather than emit subtly-wrong canonicalization bytes. A production third-party implementation that handles a wider message surface (e.g., signing settlement records that carry float-shaped amounts) needs a full JCS implementation; the [`pyjcs`](https://pypi.org/project/pyjcs/) package or equivalent is suitable.

The signature suite hard-coded here is `motebit-jcs-ed25519-b64-v1` (JCS canonicalization, Ed25519 primitive, base64url signature encoding). The spec's §7 versioning section makes this additive: a future post-quantum suite is added by registering it in `@motebit/protocol`'s `SUITE_REGISTRY` and extending the relay's verification dispatcher. A third-party implementer adds a corresponding signing path here — the wire format and routing recipe stay identical.

## License

Apache-2.0. Same license as the specification this implements.

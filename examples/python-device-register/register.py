#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
motebit/device-self-registration@1.0 reference implementation in Python.

A self-attesting device → relay registration client built against the
published specification (`spec/device-self-registration-v1.md`) alone, with
no motebit TypeScript code consumed at any step. The flow:

    1. Generate a fresh Ed25519 keypair (pynacl).
    2. Construct the §3 request body — motebit_id, device_id, public_key,
       timestamp, suite — naming a UUIDv7 for both identifiers.
    3. Canonicalize the body per RFC 8785 (JCS) with `signature` removed.
    4. Sign the canonical bytes with the private key (Ed25519).
    5. base64url-encode the signature; attach it to the body.
    6. POST to `/api/v1/devices/register-self` and parse the response.

This file exists as proof that the motebit protocol surface is
implementable from the specification alone. If a future spec change
breaks this script's flow without a corresponding spec amendment, the
spec has drifted from its claim of cross-implementation portability.

Dependencies:
    pip install pynacl requests

Usage (against a local relay):
    pnpm --filter @motebit/relay dev   # start the relay in another terminal
    python register.py http://localhost:3001

Usage (against staging):
    python register.py https://relay.motebit.com
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import uuid
from typing import Any

import nacl.signing
import requests


# ────────────────────────────────────────────────────────────────────────
# UUIDv7 (RFC 9562) — time-ordered 128-bit identifier.
#
# The spec says "UUIDv7 in this spec; any opaque string is accepted by the
# wire format." We emit UUIDv7 to match the convention. Stdlib `uuid` does
# not yet ship UUIDv7 (Python ≤ 3.12), so we build it from `time_ns` + 10
# random bytes per the RFC layout:
#   <48-bit unix-ms><4-bit version=7><12-bit rand_a><2-bit variant=10><62-bit rand_b>
# ────────────────────────────────────────────────────────────────────────


def uuidv7() -> str:
    """Return a UUIDv7 string. Time-ordered; sortable by creation time."""
    timestamp_ms = int(time.time() * 1000) & 0xFFFFFFFFFFFF
    rand = os.urandom(10)
    b = bytearray(16)
    b[0] = (timestamp_ms >> 40) & 0xFF
    b[1] = (timestamp_ms >> 32) & 0xFF
    b[2] = (timestamp_ms >> 24) & 0xFF
    b[3] = (timestamp_ms >> 16) & 0xFF
    b[4] = (timestamp_ms >> 8) & 0xFF
    b[5] = timestamp_ms & 0xFF
    b[6] = 0x70 | (rand[0] & 0x0F)  # version 7
    b[7] = rand[1]
    b[8] = 0x80 | (rand[2] & 0x3F)  # variant 10
    b[9] = rand[3]
    b[10:16] = rand[4:10]
    return str(uuid.UUID(bytes=bytes(b)))


# ────────────────────────────────────────────────────────────────────────
# RFC 8785 canonical JSON (JCS) — minimal subset sufficient for the
# device-registration body. The body uses only ASCII strings, integers,
# nested dicts, and the optional null/bool — no floats, no non-ASCII keys.
# A full JCS implementation handles JSON Number canonicalization (ECMA-262
# §6.1.6.1.20); we deliberately reject floats here rather than emit
# subtly-wrong bytes.
# ────────────────────────────────────────────────────────────────────────


def jcs_canonicalize(value: Any) -> bytes:
    """Return the RFC 8785 canonical JSON encoding of `value` as UTF-8 bytes."""
    return _jcs_serialize(value).encode("utf-8")


def _jcs_serialize(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        raise ValueError(
            "float JCS canonicalization is non-trivial and not implemented; "
            "the device-registration body has no float fields"
        )
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_jcs_serialize(v) for v in value) + "]"
    if isinstance(value, dict):
        # JCS requires UTF-16 code-unit ordering of keys; for the ASCII
        # keys this body uses, lexicographic byte order matches.
        items = sorted(value.items(), key=lambda kv: kv[0])
        return (
            "{"
            + ",".join(
                json.dumps(k, ensure_ascii=False, separators=(",", ":")) + ":" + _jcs_serialize(v)
                for k, v in items
            )
            + "}"
        )
    raise TypeError(f"unsupported JSON type: {type(value).__name__}")


def base64url_no_pad(data: bytes) -> str:
    """RFC 4648 base64url, no padding — matches motebit-jcs-ed25519-b64-v1."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# ────────────────────────────────────────────────────────────────────────
# Registration flow — spec §3 + §4 + §5.
# ────────────────────────────────────────────────────────────────────────


def register_device(
    relay_url: str,
    *,
    motebit_id: str | None = None,
    device_id: str | None = None,
    device_name: str | None = None,
    owner_id: str | None = None,
    timeout_seconds: float = 10.0,
) -> dict[str, Any]:
    """Run one self-registration handshake against `relay_url`.

    Generates a fresh Ed25519 keypair if both identifiers are unset. Returns
    the relay's parsed response body on 200/201 — `{motebit_id, device_id,
    registered_at, created}` per §5.2. Raises `requests.HTTPError` on any
    non-2xx response, surfacing the relay's `{code, reason}` body for
    inspection.
    """
    signing_key = nacl.signing.SigningKey.generate()
    public_key_hex = signing_key.verify_key.encode().hex()

    motebit_id = motebit_id or uuidv7()
    device_id = device_id or uuidv7()

    # §3 request body — required fields first; optional fields appended only
    # when the caller supplied them. JCS sorts keys alphabetically, so field
    # insertion order doesn't matter for the signature, but a stable in-memory
    # order makes debugging easier.
    body: dict[str, Any] = {
        "motebit_id": motebit_id,
        "device_id": device_id,
        "public_key": public_key_hex,
        "timestamp": int(time.time() * 1000),
        "suite": "motebit-jcs-ed25519-b64-v1",
    }
    if device_name is not None:
        body["device_name"] = device_name
    if owner_id is not None:
        body["owner_id"] = owner_id

    # §4.1 — canonicalize the body with `signature` absent, sign the UTF-8
    # bytes, base64url-encode the 64-byte Ed25519 signature.
    canonical = jcs_canonicalize(body)
    signature_bytes = signing_key.sign(canonical).signature
    body["signature"] = base64url_no_pad(signature_bytes)

    # §5 — POST as JSON. No Authorization header per spec.
    response = requests.post(
        f"{relay_url.rstrip('/')}/api/v1/devices/register-self",
        json=body,
        headers={"Content-Type": "application/json"},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    return response.json()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Reference implementation of motebit/device-self-registration@1.0 "
            "(spec/device-self-registration-v1.md). Built against the "
            "published spec — no motebit TypeScript is consumed."
        )
    )
    parser.add_argument(
        "relay_url",
        help="Relay base URL (e.g. http://localhost:3001 or https://relay.motebit.com)",
    )
    parser.add_argument("--device-name", help="Optional human-readable label")
    parser.add_argument("--owner-id", help="Optional owner reference")
    args = parser.parse_args()

    try:
        result = register_device(
            args.relay_url,
            device_name=args.device_name,
            owner_id=args.owner_id,
        )
    except requests.HTTPError as exc:
        sys.stderr.write(f"registration failed: HTTP {exc.response.status_code}\n")
        try:
            sys.stderr.write(json.dumps(exc.response.json(), indent=2) + "\n")
        except ValueError:
            sys.stderr.write(exc.response.text + "\n")
        return 1
    except requests.RequestException as exc:
        sys.stderr.write(f"registration failed: {exc}\n")
        return 1

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

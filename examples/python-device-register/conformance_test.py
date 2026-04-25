#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Conformance test for the Python device-self-registration reference impl.

Drives `register.py` against a running relay and asserts the response
matches `spec/device-self-registration-v1.md` §5.2 — motebit_id, device_id,
registered_at, created. Exits 0 on success, non-zero on any deviation.

This is the test the CI smoke-test job invokes. It exists separately from
`register.py` so the example client stays a tiny demonstration script while
the CI assertions can grow over time (idempotent re-registration, key
conflict 409, malformed-request 400, etc.) without bloating the example.

Usage:
    python conformance_test.py http://localhost:3199
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid

import register


# §3 motebit_id is "any opaque string" per the wire format, "UUIDv7 in this
# spec" per the convention. The reference relay echoes back what the client
# sent, so this regex is the same shape register.py emits.
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def assert_response_shape(response: dict) -> None:
    """Assert §5.2 — every required field present with the right type."""
    required = {
        "motebit_id": str,
        "device_id": str,
        "registered_at": int,
        "created": bool,
    }
    for field, expected_type in required.items():
        if field not in response:
            raise AssertionError(f"§5.2 violation: missing field '{field}'")
        value = response[field]
        # bool is a subclass of int in Python; check bool first.
        if expected_type is bool and not isinstance(value, bool):
            raise AssertionError(
                f"§5.2 violation: '{field}' expected bool, got {type(value).__name__}"
            )
        if expected_type is not bool and not isinstance(value, expected_type):
            raise AssertionError(
                f"§5.2 violation: '{field}' expected {expected_type.__name__}, got {type(value).__name__}"
            )

    # Per spec convention, motebit_id and device_id are UUIDs (any version).
    # We sent UUIDv7s; the relay should echo them back unchanged.
    if not UUID_RE.match(response["motebit_id"]):
        raise AssertionError(
            f"§3 violation: motebit_id '{response['motebit_id']}' not a UUID"
        )
    if not UUID_RE.match(response["device_id"]):
        raise AssertionError(
            f"§3 violation: device_id '{response['device_id']}' not a UUID"
        )

    # registered_at must be a recent epoch-ms timestamp, not a placeholder.
    # Accept anything within the past hour and the next minute (skew tolerance).
    import time

    now_ms = int(time.time() * 1000)
    if not (now_ms - 3_600_000 < response["registered_at"] < now_ms + 60_000):
        raise AssertionError(
            f"§5.2 violation: registered_at {response['registered_at']} not "
            f"in [now-1h, now+1min] (now={now_ms})"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Conformance test for the Python device-registration reference impl."
    )
    parser.add_argument("relay_url", help="Relay base URL")
    args = parser.parse_args()

    print(f"==> Running registration against {args.relay_url}")
    response = register.register_device(args.relay_url, device_name="conformance-test")
    print("==> Relay response:")
    print(json.dumps(response, indent=2))

    print("==> Asserting §5.2 response shape")
    try:
        assert_response_shape(response)
    except AssertionError as exc:
        sys.stderr.write(f"\nFAIL: {exc}\n")
        return 1

    if response["created"] is not True:
        sys.stderr.write(
            "\nFAIL: first-time registration MUST return created=true (§5.1)\n"
        )
        return 1

    # Sanity: motebit_id and device_id MUST be valid UUIDs the stdlib parser
    # accepts. The relay shouldn't be returning malformed identifiers.
    try:
        uuid.UUID(response["motebit_id"])
        uuid.UUID(response["device_id"])
    except ValueError as exc:
        sys.stderr.write(f"\nFAIL: relay returned a malformed UUID: {exc}\n")
        return 1

    print("==> All §5.2 conformance checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

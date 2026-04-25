#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Live round-trip conformance test for the Python receipt verifier.

Drives `verify.py` against a running motebit relay. The flow exercises
the full sign / canonicalize / submit / verify loop without mocking
any HTTP boundary:

    1. Generate a fresh Ed25519 keypair (pynacl).
    2. Self-register a device against `/api/v1/devices/register-self`
       — the same flow the device-register example proves portable.
       This populates the relay's device record with our public_key.
    3. Build an ExecutionReceipt (§11.1) referencing that motebit_id
       and device_id, sign it with the same key (§11.2), embed
       `public_key` so the receipt is portably self-verifiable.
    4. Submit the receipt to `/agent/:motebitId/verify-receipt`.
       The relay's TypeScript verifier (`@motebit/crypto`) MUST
       return `{valid: true}` — proving Python's JCS + Ed25519 +
       base64url envelope is byte-identical with the relay's.
    5. Run `verify.py`'s pure-Python verifier against the same
       receipt. MUST return `valid=True`.
    6. Tamper with one byte of `result`, re-submit. Both verifiers
       MUST reject the receipt — proves the cryptographic binding
       is real on both sides.
    7. Re-derive `prompt_hash` and `result_hash` per §11.4 from the
       original content strings; assert byte-equal.
    8. Build a 2-deep delegation chain (§11.5); assert the local
       verifier walks the recursion and reports `nested_count=1`.

A pass means the spec's description of the receipt envelope is what
the relay actually enforces — no TypeScript-specific assumptions
sneaked in. A failure localizes the regression: shape mismatch
points at §11.1, signature mismatch points at §11.2, hash mismatch
points at §11.4, recursion mismatch points at §11.5.

Usage:
    python conformance_test.py http://localhost:3199

CRITICAL: this test inspects the `valid` field of the relay's
response body. It does NOT short-circuit on `response.ok` / HTTP
200. Per the dead-drop lesson
(`memory/lesson_hardware_attestation_self_issued_dead_drop.md`):
the relay returns HTTP 200 even when the verification semantically
failed; the body is the source of truth.
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import sys
import time
import uuid
from typing import Any

import nacl.signing
import requests

import verify

SUITE_ID = "motebit-jcs-ed25519-b64-v1"


# ────────────────────────────────────────────────────────────────────────
# UUIDv7 — same generator as register.py; copied here so this example
# stays self-contained per the protocol-portability claim.
# ────────────────────────────────────────────────────────────────────────


def uuidv7() -> str:
    timestamp_ms = int(time.time() * 1000) & 0xFFFFFFFFFFFF
    rand = os.urandom(10)
    b = bytearray(16)
    b[0] = (timestamp_ms >> 40) & 0xFF
    b[1] = (timestamp_ms >> 32) & 0xFF
    b[2] = (timestamp_ms >> 24) & 0xFF
    b[3] = (timestamp_ms >> 16) & 0xFF
    b[4] = (timestamp_ms >> 8) & 0xFF
    b[5] = timestamp_ms & 0xFF
    b[6] = 0x70 | (rand[0] & 0x0F)
    b[7] = rand[1]
    b[8] = 0x80 | (rand[2] & 0x3F)
    b[9] = rand[3]
    b[10:16] = rand[4:10]
    return str(uuid.UUID(bytes=bytes(b)))


# ────────────────────────────────────────────────────────────────────────
# Receipt construction + signing per §11.1 / §11.2.
# ────────────────────────────────────────────────────────────────────────


def build_signed_receipt(
    signing_key: nacl.signing.SigningKey,
    *,
    motebit_id: str,
    device_id: str,
    prompt: str,
    result: str,
    delegation_receipts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a §11.1-shaped, §11.2-signed ExecutionReceipt with `public_key`
    embedded so the receipt is portably self-verifiable."""
    now_ms = int(time.time() * 1000)
    body: dict[str, Any] = {
        "task_id": uuidv7(),
        "motebit_id": motebit_id,
        "device_id": device_id,
        "public_key": signing_key.verify_key.encode().hex(),
        "submitted_at": now_ms,
        "completed_at": now_ms + 1,
        "status": "completed",
        "result": result,
        "tools_used": [],
        "memories_formed": 0,
        "prompt_hash": verify.content_hash(prompt),
        "result_hash": verify.content_hash(result),
        "suite": SUITE_ID,
        "invocation_origin": "user-tap",
    }
    if delegation_receipts:
        body["delegation_receipts"] = delegation_receipts

    canonical = verify.jcs_canonicalize(body)
    signature_bytes = signing_key.sign(canonical).signature
    body["signature"] = base64.urlsafe_b64encode(signature_bytes).rstrip(b"=").decode("ascii")
    return body


# ────────────────────────────────────────────────────────────────────────
# Device self-registration — minimal copy of `register.py`'s flow.
# Replicated rather than imported because each example is intended to
# be a self-contained spec implementation.
# ────────────────────────────────────────────────────────────────────────


def register_device(
    relay_url: str,
    signing_key: nacl.signing.SigningKey,
    *,
    motebit_id: str,
    device_id: str,
    timeout_seconds: float = 10.0,
) -> dict[str, Any]:
    """Self-register a device using the keys we'll later sign receipts with.
    Returns the relay's §5.2 response. Raises on any non-2xx."""
    body: dict[str, Any] = {
        "motebit_id": motebit_id,
        "device_id": device_id,
        "public_key": signing_key.verify_key.encode().hex(),
        "device_name": "python-receipt-verifier-conformance",
        "timestamp": int(time.time() * 1000),
        "suite": SUITE_ID,
    }
    canonical = verify.jcs_canonicalize(body)
    sig = signing_key.sign(canonical).signature
    body["signature"] = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")

    response = requests.post(
        f"{relay_url.rstrip('/')}/api/v1/devices/register-self",
        json=body,
        headers={"Content-Type": "application/json"},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    return response.json()


# ────────────────────────────────────────────────────────────────────────
# Live round-trip: submit a receipt to the relay's TS verifier and
# read the body. NEVER trust `response.ok` alone — the relay returns
# HTTP 200 with `{valid: false, reason: ...}` for semantic rejections,
# and treating that as success is the bug pattern from
# `lesson_hardware_attestation_self_issued_dead_drop.md`.
# ────────────────────────────────────────────────────────────────────────


def relay_verifies(
    relay_url: str,
    motebit_id: str,
    receipt: dict[str, Any],
    *,
    timeout_seconds: float = 10.0,
) -> tuple[bool, dict[str, Any]]:
    """POST `receipt` to the relay's verify-receipt endpoint. Returns
    `(valid, body)` where `valid` is the relay's body-level decision.
    Raises on any non-2xx HTTP response."""
    response = requests.post(
        f"{relay_url.rstrip('/')}/agent/{motebit_id}/verify-receipt",
        json=receipt,
        headers={"Content-Type": "application/json"},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, dict):
        raise RuntimeError(f"relay returned non-object body: {body!r}")
    return bool(body.get("valid")), body


# ────────────────────────────────────────────────────────────────────────
# Test cases. Each step prints what it's doing and what the body said,
# so a CI failure surfaces both sides of every disagreement.
# ────────────────────────────────────────────────────────────────────────


def step(label: str) -> None:
    print(f"\n==> {label}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Live round-trip conformance test for the Python receipt verifier."
    )
    parser.add_argument("relay_url", help="Relay base URL (e.g. http://localhost:3199)")
    parser.add_argument(
        "--emit-fixture",
        help=(
            "Optional path: write the round-trip-validated receipt to this file "
            "as the committed fixture. Used during fixture refresh, not in CI."
        ),
    )
    args = parser.parse_args()

    print(f"Relay base URL: {args.relay_url}")

    # ── Setup: generate keypair, register device ────────────────────
    step("Generating Ed25519 keypair")
    signing_key = nacl.signing.SigningKey.generate()
    motebit_id = uuidv7()
    device_id = uuidv7()
    print(f"motebit_id = {motebit_id}")
    print(f"device_id  = {device_id}")
    print(f"public_key = {signing_key.verify_key.encode().hex()}")

    step("Self-registering the device against the relay")
    reg_response = register_device(
        args.relay_url,
        signing_key,
        motebit_id=motebit_id,
        device_id=device_id,
    )
    print(json.dumps(reg_response, indent=2))
    if reg_response.get("created") is not True:
        sys.stderr.write("FAIL: device registration must return created=true\n")
        return 1

    # ── Step 1: build + locally verify a receipt ────────────────────
    step("Building a §11.1 receipt and signing it (Python pynacl + JCS)")
    prompt = "summarize the doctrine of self-attesting systems in one paragraph"
    result = (
        "Every motebit claim — receipts, credentials, settlement records — "
        "is independently verifiable by any third party from cryptographic "
        "primitives alone, with no relay contact required."
    )
    receipt = build_signed_receipt(
        signing_key,
        motebit_id=motebit_id,
        device_id=device_id,
        prompt=prompt,
        result=result,
    )
    print(f"task_id        = {receipt['task_id']}")
    print(f"prompt_hash    = {receipt['prompt_hash']}")
    print(f"result_hash    = {receipt['result_hash']}")
    print(f"signature      = {receipt['signature']}")

    step("Verifying with the local Python verifier (verify.verify_receipt)")
    local_result = verify.verify_receipt(receipt)
    print(json.dumps(local_result.to_dict(), indent=2))
    if not local_result.valid:
        sys.stderr.write(
            "FAIL: local verifier rejected a receipt we just signed — "
            "Python's sign and verify primitives disagree\n"
        )
        return 1

    # ── Step 2: live relay round-trip ───────────────────────────────
    step("Submitting to /agent/:motebitId/verify-receipt — LIVE relay verifier")
    relay_valid, relay_body = relay_verifies(args.relay_url, motebit_id, receipt)
    print(json.dumps(relay_body, indent=2))
    if not relay_valid:
        sys.stderr.write(
            f"FAIL: relay rejected a Python-signed receipt: {relay_body}\n"
            "This means the spec's JCS + Ed25519 + base64url envelope drifted "
            "from what the relay's TypeScript verifier expects, OR the device's "
            "public_key was not registered before submission.\n"
        )
        return 1

    # ── Step 3: tampering negative case ─────────────────────────────
    step("Tampering: flipping one character of `result` and re-verifying")
    tampered = copy.deepcopy(receipt)
    tampered["result"] = tampered["result"][:-1] + (
        "X" if tampered["result"][-1] != "X" else "Y"
    )
    local_tampered = verify.verify_receipt(tampered)
    if local_tampered.valid:
        sys.stderr.write(
            "FAIL: local verifier accepted a tampered receipt — "
            "signature binding is broken\n"
        )
        return 1
    print(f"local verifier rejected tampered receipt: {local_tampered.reasons}")

    relay_tampered_valid, relay_tampered_body = relay_verifies(
        args.relay_url, motebit_id, tampered
    )
    if relay_tampered_valid:
        sys.stderr.write(
            f"FAIL: relay accepted a tampered receipt: {relay_tampered_body}\n"
            "Per the dead-drop lesson: this is exactly the failure shape that "
            "looks like success if you only check response.ok.\n"
        )
        return 1
    print(f"relay rejected tampered receipt: {relay_tampered_body}")

    # ── Step 4: §11.4 hash conformance ──────────────────────────────
    step("§11.4: re-deriving prompt_hash and result_hash from original content")
    hash_reasons = verify.check_content_hashes(receipt, prompt=prompt, result=result)
    if hash_reasons:
        sys.stderr.write("FAIL: §11.4 hash re-derivation mismatch:\n")
        for r in hash_reasons:
            sys.stderr.write(f"  - {r}\n")
        return 1
    print("prompt_hash and result_hash both match SHA-256 hex of UTF-8 bytes")

    # ── Step 5: §11.5 recursion — 2-deep delegation chain ───────────
    step("§11.5: building a 2-deep delegation chain and verifying it")
    inner_signing_key = nacl.signing.SigningKey.generate()
    inner = build_signed_receipt(
        inner_signing_key,
        motebit_id=uuidv7(),
        device_id=uuidv7(),
        prompt="inner subtask prompt",
        result="inner subtask result",
    )
    outer = build_signed_receipt(
        signing_key,
        motebit_id=motebit_id,
        device_id=device_id,
        prompt=prompt,
        result=result,
        delegation_receipts=[inner],
    )
    chain_result = verify.verify_receipt(outer)
    print(json.dumps(chain_result.to_dict(), indent=2))
    if not chain_result.valid:
        sys.stderr.write(
            f"FAIL: §11.5 chain verification failed: {chain_result.reasons}\n"
        )
        return 1
    if chain_result.nested_count != 1:
        sys.stderr.write(
            f"FAIL: nested_count expected 1, got {chain_result.nested_count}\n"
        )
        return 1

    # ── Optional: refresh the committed fixture ────────────────────
    if args.emit_fixture:
        # Pretty-print rather than canonical-bytes — humans read the fixture;
        # the verifier re-canonicalizes on load.
        with open(args.emit_fixture, "w", encoding="utf-8") as f:
            json.dump(receipt, f, indent=2, sort_keys=True)
            f.write("\n")
        print(f"\n==> Fixture refreshed at {args.emit_fixture}")

    print("\n==> All §11.1 / §11.2 / §11.4 / §11.5 conformance checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

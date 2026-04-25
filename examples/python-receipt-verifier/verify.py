#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
motebit/execution-ledger@1.0 §11 ExecutionReceipt verifier in Python.

A self-contained portable verifier for motebit ExecutionReceipts, built
against the published specification (`spec/execution-ledger-v1.md` §11)
alone, with no motebit TypeScript code consumed at any step. The flow:

    1. Load a receipt JSON (file path or stdin).
    2. Validate §11.1 wire-format shape — required fields with the
       right types, suite identifier, and signature/public-key
       encodings.
    3. Strip `signature`, JCS-canonicalize the body (RFC 8785).
    4. base64url-decode the signature; Ed25519-verify against the
       embedded `public_key` per §11.3.
    5. Recurse over `delegation_receipts` per §11.5.
    6. (Optional) Re-derive `prompt_hash` / `result_hash` per §11.4
       when the original prompt and result strings are supplied.

This file exists as proof — for one wire artifact — that motebit's
signed-receipt surface is verifiable from the specification alone.
A successful verification means the receipt's bytes round-trip
through a JCS implementation written from RFC 8785 alone, an
Ed25519 verifier (`pynacl`) different from `@motebit/crypto`'s
`@noble/ed25519`, and stdlib base64 — a different library stack at
every cryptographic step from the relay's. If the spec's description
of the JCS / Ed25519 / base64url envelope had a TypeScript-specific
assumption, this verifier would reject every signed receipt the
relay produces. It does not.

Dependencies:
    pip install pynacl requests

Usage (verify a fixture):
    python verify.py fixtures/example-receipt.json

Usage (verify from stdin):
    cat receipt.json | python verify.py -

Usage (verify a receipt fetched from a relay's admin archive):
    python verify.py --from-url \\
        https://relay.example/api/v1/admin/receipts/<motebit-id>/<task-id> \\
        --bearer "$RELAY_ADMIN_TOKEN"

Usage (additionally check §11.4 hashes against the original strings):
    python verify.py receipt.json --prompt-file prompt.txt --result-file result.txt
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import nacl.exceptions
import nacl.signing
import requests


SUITE_ID = "motebit-jcs-ed25519-b64-v1"

# §11.5 RECOMMENDED maximum nesting depth. We treat it as a hard
# rejection: a chain deeper than 10 is adversarial, not a normal
# workload, and continuing the recursion risks stack-overflow on a
# malicious receipt.
MAX_DELEGATION_DEPTH = 10


# ────────────────────────────────────────────────────────────────────────
# RFC 8785 canonical JSON (JCS) — the same minimal subset used by
# `examples/python-device-register/register.py`. Receipts use only
# ASCII strings, integers, arrays, and nested objects; no floats. We
# reject floats with a runtime error rather than emit subtly-wrong
# bytes that would fail signature verification in confusing ways.
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
            "ExecutionReceipt has no float fields per spec §11.1"
        )
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_jcs_serialize(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0])
        return (
            "{"
            + ",".join(
                json.dumps(k, ensure_ascii=False, separators=(",", ":"))
                + ":"
                + _jcs_serialize(v)
                for k, v in items
            )
            + "}"
        )
    raise TypeError(f"unsupported JSON type: {type(value).__name__}")


def base64url_decode_no_pad(s: str) -> bytes:
    """RFC 4648 base64url with optional stripped padding. Strict — raises on
    malformed input; the receipt-verification path catches and re-raises with
    a §11.3-shaped reason."""
    pad = (-len(s)) % 4
    return base64.urlsafe_b64decode(s + ("=" * pad))


# ────────────────────────────────────────────────────────────────────────
# Result type — accumulates every reason the verifier rejected something.
# A receipt is `valid` only when zero reasons accumulated; partial
# success (e.g., outer signature ok, one nested receipt invalid) sets
# `valid = False` with the leaf reason listed.
# ────────────────────────────────────────────────────────────────────────


@dataclass
class VerificationResult:
    valid: bool
    reasons: list[str] = field(default_factory=list)
    public_key_hex: str | None = None
    canonical_sha256: str | None = None
    nested_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "reasons": self.reasons,
            "public_key_hex": self.public_key_hex,
            "canonical_sha256": self.canonical_sha256,
            "nested_count": self.nested_count,
        }


# ────────────────────────────────────────────────────────────────────────
# §11.1 wire-format shape validation. A receipt that fails shape MUST
# fail verification — the spec's required fields are signed-bound, so
# a malformed receipt either had an empty signed body (verification
# would fail anyway) or was tampered with (verification MUST fail).
# We surface the shape reason explicitly because "invalid signature"
# on a malformed body is misleading.
# ────────────────────────────────────────────────────────────────────────

REQUIRED_FIELDS: dict[str, type | tuple[type, ...]] = {
    "task_id": str,
    "motebit_id": str,
    "device_id": str,
    "submitted_at": int,
    "completed_at": int,
    "status": str,
    "result": str,
    "tools_used": list,
    "memories_formed": int,
    "prompt_hash": str,
    "result_hash": str,
    "suite": str,
    "signature": str,
}

VALID_STATUSES = {"completed", "failed", "denied"}
VALID_ORIGINS = {"user-tap", "ai-loop", "scheduled", "agent-to-agent"}
HEX_64 = 64
ED25519_SIG_BYTES = 64
ED25519_KEY_BYTES = 32


def _validate_shape(receipt: Any, *, depth: int = 0) -> list[str]:
    """Return a list of §11.1 violations. Empty list ≡ shape OK."""
    reasons: list[str] = []
    if not isinstance(receipt, dict):
        return ["§11.1 violation: receipt is not a JSON object"]

    for field_name, expected in REQUIRED_FIELDS.items():
        if field_name not in receipt:
            reasons.append(f"§11.1 violation: missing required field '{field_name}'")
            continue
        value = receipt[field_name]
        # bool is a subclass of int in Python — reject explicitly so
        # `submitted_at: true` doesn't pass the int check.
        if expected is int and isinstance(value, bool):
            reasons.append(f"§11.1 violation: '{field_name}' must be int, got bool")
            continue
        if not isinstance(value, expected):
            type_name = (
                expected.__name__
                if isinstance(expected, type)
                else "/".join(t.__name__ for t in expected)
            )
            reasons.append(
                f"§11.1 violation: '{field_name}' must be {type_name}, "
                f"got {type(value).__name__}"
            )

    # Spec §11.1: suite is the binding cryptosuite identifier. A
    # different value means a different verification recipe and we
    # must NOT silently fall through to motebit-jcs-ed25519-b64-v1.
    if receipt.get("suite") not in (None, SUITE_ID):
        reasons.append(
            f"§11.1 violation: suite '{receipt.get('suite')}' "
            f"is not '{SUITE_ID}' — this verifier supports only that suite"
        )

    if receipt.get("status") not in (None, *VALID_STATUSES):
        reasons.append(
            f"§11.1 violation: status '{receipt.get('status')}' not in "
            f"{sorted(VALID_STATUSES)}"
        )

    invocation_origin = receipt.get("invocation_origin")
    if invocation_origin is not None and invocation_origin not in VALID_ORIGINS:
        reasons.append(
            f"§11.7 violation: invocation_origin '{invocation_origin}' not in "
            f"{sorted(VALID_ORIGINS)}"
        )

    pub = receipt.get("public_key")
    if pub is not None:
        if not isinstance(pub, str) or len(pub) != HEX_64 or not _is_hex(pub):
            reasons.append(
                "§11.1 violation: public_key must be 64-char lowercase hex Ed25519"
            )

    for hash_field in ("prompt_hash", "result_hash"):
        h = receipt.get(hash_field)
        if isinstance(h, str) and (len(h) != HEX_64 or not _is_hex(h)):
            reasons.append(
                f"§11.4 violation: {hash_field} must be 64-char lowercase hex SHA-256"
            )

    nested = receipt.get("delegation_receipts")
    if nested is not None and not isinstance(nested, list):
        reasons.append("§11.5 violation: delegation_receipts must be an array")
    if depth > MAX_DELEGATION_DEPTH:
        reasons.append(
            f"§11.5 violation: nesting depth {depth} exceeds RECOMMENDED max "
            f"{MAX_DELEGATION_DEPTH}"
        )

    tools = receipt.get("tools_used")
    if isinstance(tools, list) and any(not isinstance(t, str) for t in tools):
        reasons.append("§11.1 violation: tools_used must be array of strings")

    return reasons


def _is_hex(s: str) -> bool:
    """Lowercase-hex check. The spec mandates lowercase per §11.4."""
    if not s:
        return False
    return all(c in "0123456789abcdef" for c in s)


# ────────────────────────────────────────────────────────────────────────
# §11.2/§11.3 verification. Strip `signature`, canonicalize, decode
# `signature` from base64url, Ed25519-verify against `public_key`.
# Recurse into `delegation_receipts` per §11.5.
# ────────────────────────────────────────────────────────────────────────


def verify_receipt(
    receipt: Any,
    *,
    public_key_hex: str | None = None,
    depth: int = 0,
) -> VerificationResult:
    """Verify one receipt (and recursively its delegation chain).

    Resolution order for the verification key, per §11.3:
      1. `receipt["public_key"]` if present and well-formed.
      2. The `public_key_hex` parameter (caller-supplied out-of-band).
      3. None → invalid.

    Returns a `VerificationResult`. `result.valid` is True only when
    every receipt in the chain (including this one) passed shape +
    signature verification.
    """
    result = VerificationResult(valid=False)

    shape_errors = _validate_shape(receipt, depth=depth)
    if shape_errors:
        result.reasons.extend(shape_errors)
        return result

    embedded_pk = receipt.get("public_key")
    pk_hex = embedded_pk if isinstance(embedded_pk, str) and embedded_pk else public_key_hex
    if not pk_hex:
        result.reasons.append(
            "§11.3 violation: no verification key — receipt has no `public_key` "
            "and none was supplied out-of-band"
        )
        return result
    if len(pk_hex) != HEX_64 or not _is_hex(pk_hex):
        result.reasons.append(
            "§11.1 violation: verification key must be 64-char lowercase hex"
        )
        return result
    result.public_key_hex = pk_hex

    body = {k: v for k, v in receipt.items() if k != "signature"}
    try:
        canonical = jcs_canonicalize(body)
    except (TypeError, ValueError) as exc:
        result.reasons.append(f"§5/§11.2 canonicalization failed: {exc}")
        return result
    result.canonical_sha256 = hashlib.sha256(canonical).hexdigest()

    try:
        sig_bytes = base64url_decode_no_pad(receipt["signature"])
    except (ValueError, TypeError) as exc:
        result.reasons.append(
            f"§11.2 violation: signature is not valid base64url ({exc})"
        )
        return result
    if len(sig_bytes) != ED25519_SIG_BYTES:
        result.reasons.append(
            f"§11.2 violation: decoded signature is {len(sig_bytes)} bytes, "
            f"expected {ED25519_SIG_BYTES}"
        )
        return result

    pk_bytes = bytes.fromhex(pk_hex)
    if len(pk_bytes) != ED25519_KEY_BYTES:
        result.reasons.append(
            f"§11.1 violation: decoded public key is {len(pk_bytes)} bytes, "
            f"expected {ED25519_KEY_BYTES}"
        )
        return result

    try:
        verify_key = nacl.signing.VerifyKey(pk_bytes)
        verify_key.verify(canonical, sig_bytes)
    except nacl.exceptions.BadSignatureError:
        result.reasons.append("§11.2 violation: Ed25519 signature did not verify")
        return result

    nested = receipt.get("delegation_receipts") or []
    result.nested_count = len(nested)
    for index, sub in enumerate(nested):
        sub_result = verify_receipt(sub, depth=depth + 1)
        if not sub_result.valid:
            result.reasons.extend(
                f"§11.5 nested receipt [{index}]: {r}" for r in sub_result.reasons
            )
            return result

    result.valid = True
    return result


# ────────────────────────────────────────────────────────────────────────
# §11.4 content hashing — SHA-256 hex of UTF-8 encoded prompt/result.
# Lowercase hex. The receipt body commits only to the hash; this
# function is the inverse check a verifier runs when they have the
# original content out-of-band.
# ────────────────────────────────────────────────────────────────────────


def content_hash(content: str) -> str:
    """Compute the §11.4 SHA-256 hex digest of a UTF-8 encoded string."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def check_content_hashes(
    receipt: dict[str, Any],
    *,
    prompt: str | None = None,
    result: str | None = None,
) -> list[str]:
    """Re-derive §11.4 hashes from the original content and compare. Returns a
    list of mismatch reasons; empty list ≡ all supplied content matches."""
    reasons: list[str] = []
    if prompt is not None:
        expected = content_hash(prompt)
        actual = receipt.get("prompt_hash")
        if expected != actual:
            reasons.append(
                f"§11.4 prompt_hash mismatch: expected {expected}, got {actual}"
            )
    if result is not None:
        expected = content_hash(result)
        actual = receipt.get("result_hash")
        if expected != actual:
            reasons.append(
                f"§11.4 result_hash mismatch: expected {expected}, got {actual}"
            )
    return reasons


# ────────────────────────────────────────────────────────────────────────
# CLI entry point.
# ────────────────────────────────────────────────────────────────────────


def _load_receipt(
    source: str,
    *,
    bearer: str | None,
    timeout: float,
) -> dict[str, Any]:
    if source == "-":
        return json.loads(sys.stdin.read())
    if source.startswith(("http://", "https://")):
        headers = {"Accept": "application/json"}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        response = requests.get(source, headers=headers, timeout=timeout)
        response.raise_for_status()
        return response.json()
    return json.loads(Path(source).read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Reference verifier for motebit/execution-ledger@1.0 §11 "
            "ExecutionReceipt. Built against the published spec — no "
            "motebit TypeScript is consumed."
        )
    )
    parser.add_argument(
        "source",
        nargs="?",
        help=(
            "Receipt source: a file path, a URL (relay admin archive or any "
            "receipt-serving endpoint), or `-` for stdin. Default: stdin."
        ),
        default="-",
    )
    parser.add_argument(
        "--from-url",
        help="Alias for the positional source when it is a URL.",
        dest="from_url",
    )
    parser.add_argument(
        "--bearer",
        help=(
            "Bearer token for URL fetch (admin-archive endpoints require "
            "authentication; ignored for file/stdin sources)."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="HTTP timeout when fetching from a URL (seconds).",
    )
    parser.add_argument(
        "--prompt-file",
        help="Optional file holding the original prompt — re-derives §11.4 prompt_hash.",
    )
    parser.add_argument(
        "--result-file",
        help="Optional file holding the original result — re-derives §11.4 result_hash.",
    )
    parser.add_argument(
        "--public-key",
        help=(
            "Verification key as 64-char lowercase hex. Used only when the "
            "receipt does not embed `public_key`. Optional per §11.3."
        ),
    )
    args = parser.parse_args()

    source = args.from_url or args.source
    try:
        receipt = _load_receipt(source, bearer=args.bearer, timeout=args.timeout)
    except requests.HTTPError as exc:
        sys.stderr.write(f"fetch failed: HTTP {exc.response.status_code}\n")
        sys.stderr.write(exc.response.text + "\n")
        return 2
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"could not load receipt: {exc}\n")
        return 2

    result = verify_receipt(receipt, public_key_hex=args.public_key)

    hash_reasons: list[str] = []
    if args.prompt_file or args.result_file:
        prompt = (
            Path(args.prompt_file).read_text(encoding="utf-8")
            if args.prompt_file
            else None
        )
        result_str = (
            Path(args.result_file).read_text(encoding="utf-8")
            if args.result_file
            else None
        )
        hash_reasons = check_content_hashes(receipt, prompt=prompt, result=result_str)
        if hash_reasons:
            result.valid = False
            result.reasons.extend(hash_reasons)

    print(json.dumps(result.to_dict(), indent=2))
    return 0 if result.valid else 1


if __name__ == "__main__":
    sys.exit(main())

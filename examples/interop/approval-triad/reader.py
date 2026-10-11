#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Cold reader for the approval -> tool call -> receipt case.

Question it answers, per case: did the executed tool call match its approval?

Standalone: pynacl for Ed25519, an RFC 8785 (JCS) canonicalizer written here
(the same minimal subset as ../../python-receipt-verifier/verify.py), stdlib for
everything else. It imports no motebit code.

For every case in expected.json it recomputes, from the bytes in cases/:
  - the sha256 of every file,
  - the three signatures (approval under the pinned APPROVER key; invocation and
    receipt under the pinned AGENT key; the embedded public_key is not trusted),
  - the relation claims (call_id, tool_name, args_hash, verdict, ordering, run),
  - binding (always not_evaluated: no offline key -> motebit_id binding here),
  - the verdict, failure codes and decisive claim,
then compares ALL of it with expected.json and exits 1 on any disagreement.

    pip install pynacl
    python reader.py                       # run every case, compare expected.json
    python reader.py --expected other.json # compare against another claim file
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import nacl.exceptions
import nacl.signing

HERE = Path(__file__).resolve().parent
SUITE = "motebit-jcs-ed25519-b64-v1"

# The reader's own trust anchors: fixed PUBLIC demo keys (seeds 0x21..0x40 and
# 0x01..0x20). expected.json must state the same pins or the run fails.
PINNED_KEYS = {
    "approver": "e7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0",
    "agent": "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664",
}

CLAIMS = [
    "signature_approval",
    "signature_invocation",
    "signature_receipt",
    "call_id",
    "tool_name",
    "args_hash",
    "verdict",
    "ordering",
    "run",
    "binding",
]
SIGNATURE_CLAIMS = CLAIMS[:3]
RELATION_CLAIMS = ["call_id", "tool_name", "args_hash", "verdict", "ordering", "run"]


# ── RFC 8785 (JCS), the subset these artifacts use: no floats ──────────────


def jcs(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        raise ValueError("floats are not used by these artifacts")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        # RFC 8785 sorts by UTF-16 code units; all keys here are ASCII.
        return "{" + ",".join(jcs(k) + ":" + jcs(value[k]) for k in sorted(value)) + "}"
    raise TypeError(f"unsupported JSON type: {type(value).__name__}")


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * ((-len(s)) % 4))


def signature_state(artifact: dict[str, Any], pinned_hex: str) -> str:
    """'pass' iff the suite is the expected one and the Ed25519 signature over
    JCS(artifact minus `signature`) verifies under the PINNED key."""
    if artifact.get("suite") != SUITE or not isinstance(artifact.get("signature"), str):
        return "fail"
    body = {k: v for k, v in artifact.items() if k != "signature"}
    try:
        key = nacl.signing.VerifyKey(bytes.fromhex(pinned_hex))
        key.verify(jcs(body).encode("utf-8"), b64url_decode(artifact["signature"]))
        return "pass"
    except (nacl.exceptions.BadSignatureError, ValueError):
        return "fail"


def evaluate(case_dir: Path) -> dict[str, Any]:
    approval = json.loads((case_dir / "approval.json").read_text("utf-8"))
    invocation = json.loads((case_dir / "invocation.json").read_text("utf-8"))
    receipt = json.loads((case_dir / "receipt.json").read_text("utf-8"))

    claims: dict[str, str] = {
        "signature_approval": signature_state(approval, PINNED_KEYS["approver"]),
        "signature_invocation": signature_state(invocation, PINNED_KEYS["agent"]),
        "signature_receipt": signature_state(receipt, PINNED_KEYS["agent"]),
    }
    sig_failed = [c for c in SIGNATURE_CLAIMS if claims[c] != "pass"]

    if sig_failed:
        # Relations over unauthenticated bytes say nothing; never report them.
        for c in RELATION_CLAIMS:
            claims[c] = "not_evaluated"
    else:
        ok = {
            # The JOIN key: the approval names the gated call by its id.
            "call_id": approval["approval_id"] == invocation["invocation_id"],
            "tool_name": approval["tool_name"] == invocation["tool_name"],
            "args_hash": approval["args_hash"] == invocation["args_hash"],
            # A completed call needs an approved verdict.
            "verdict": invocation["status"] != "completed" or approval["verdict"] == "approved",
            # Consent must precede the act.
            "ordering": approval["resolved_at"] <= invocation["started_at"],
            "run": approval["run_id"] == invocation["task_id"] == receipt["task_id"],
        }
        for c in RELATION_CLAIMS:
            claims[c] = "pass" if ok[c] else "fail"

    # Neither key is bound to the motebit_id by anything this case checks.
    claims["binding"] = "not_evaluated"

    if sig_failed:
        verdict, codes, decisive = "INVALID", ["signature"], sig_failed[0]
    else:
        failed = [c for c in RELATION_CLAIMS if claims[c] == "fail"]
        if failed:
            verdict, codes, decisive = "MISMATCH", failed, failed[0]
        else:
            verdict, codes, decisive = "MATCH", [], None

    result: dict[str, Any] = {
        "verdict": verdict,
        "claims": claims,
        "codes": codes,
        "decisive": decisive,
    }
    deny = case_dir / "deny-receipt.json"
    if deny.exists():
        # Task D: an agent-signed refusal with no approval. Outside the join;
        # only its signature is read.
        result["unjoined"] = {
            "deny-receipt.json": {
                "signature_receipt": signature_state(
                    json.loads(deny.read_text("utf-8")), PINNED_KEYS["agent"]
                )
            }
        }
    return result


def compare(expected_path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    expected = json.loads(expected_path.read_text("utf-8"))
    problems: list[str] = []
    rows: list[dict[str, Any]] = []

    if expected.get("pinned_keys") != PINNED_KEYS:
        problems.append("pinned_keys: expected.json does not state the reader's pins")
    if expected.get("claims") != CLAIMS:
        problems.append("claims: expected.json claim list differs from the reader's")

    for name, exp in expected.get("cases", {}).items():
        case_dir = HERE / exp.get("dir", "")
        if not case_dir.is_dir():
            problems.append(f"{name}: missing directory {exp.get('dir')!r}")
            continue
        on_disk = sorted(p.name for p in case_dir.glob("*.json"))
        if on_disk != sorted(exp.get("files", {})):
            problems.append(f"{name}: files on disk {on_disk} != expected")
        for fname, sha in exp.get("files", {}).items():
            path = case_dir / fname
            got = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
            if got != sha:
                problems.append(f"{name}/{fname}: sha256 {got} != expected {sha}")

        got = evaluate(case_dir)
        exp_fields = {k: v for k, v in exp.items() if k not in ("dir", "files")}
        for key in sorted(set(exp_fields) | set(got)):
            if exp_fields.get(key) != got.get(key):
                problems.append(
                    f"{name}.{key}: reader {json.dumps(got.get(key))} "
                    f"!= expected {json.dumps(exp_fields.get(key))}"
                )
        rows.append({"case": name, **got})

    for d in sorted(p.name for p in (HERE / "cases").iterdir() if p.is_dir()):
        if not any(e.get("dir") == f"cases/{d}" for e in expected.get("cases", {}).values()):
            problems.append(f"cases/{d}: on disk but not in expected.json")
    return problems, rows


def print_table(rows: list[dict[str, Any]]) -> None:
    short = {"pass": "pass", "fail": "FAIL", "not_evaluated": "n/e"}
    head = ["case", "verdict", "decisive"] + CLAIMS
    abbrev = ["case", "verdict", "decisive", "sig_A", "sig_I", "sig_R",
              "call", "tool", "args", "verd", "order", "run", "bind"]
    table = [abbrev] + [
        [r["case"], r["verdict"], r["decisive"] or "-"]
        + [short[r["claims"][c]] for c in CLAIMS]
        for r in rows
    ]
    widths = [max(len(row[i]) for row in table) for i in range(len(head))]
    for row in table:
        print("  ".join(cell.ljust(w) for cell, w in zip(row, widths)).rstrip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--expected", type=Path, default=HERE / "expected.json")
    args = ap.parse_args()

    problems, rows = compare(args.expected)
    print_table(rows)
    print()
    if problems:
        print(f"DISAGREE: {len(problems)} difference(s) from {args.expected.name}")
        for p in problems:
            print("  - " + p)
        return 1
    print(f"AGREE: {len(rows)} case(s), every field of {args.expected.name} reproduced")
    return 0


if __name__ == "__main__":
    sys.exit(main())

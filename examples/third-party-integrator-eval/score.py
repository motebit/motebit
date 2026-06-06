#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Score a third-party integration attempt against the four DX criteria.

Deterministic, dependency-free, regex-based. Reads every text file under the
given path (or a single file) and grades whether the candidate took the correct
integration path. Prints a JSON scorecard; exits non-zero on failure.

This is a developer-experience regression gate, not a cryptographic check — the
crypto correctness is already proven by examples/python-receipt-verifier. Here
we only ask: did the docs lead the integrator to install the floor instead of
reimplementing it, dispatch on the suite instead of hardcoding one, and report
identity binding instead of conflating it with byte-validity?
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CODE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".md", ".txt"}


def load_text(path: Path) -> str:
    if path.is_file():
        files = [path]
    else:
        files = [p for p in path.rglob("*") if p.is_file() and p.suffix in CODE_SUFFIXES]
    chunks = []
    for f in files:
        try:
            chunks.append(f.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
    return "\n".join(chunks)


def search(pattern: str, text: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE) is not None


def grade(text: str) -> dict:
    # --- raw signals -------------------------------------------------------
    uses_floor = search(r"@motebit/(verifier|crypto|verify|state-export-client)", text)
    raw_crypto = search(r"@noble/ed25519|tweetnacl|\bnacl\b|ed25519\.verify|sign\.detached\.verify", text)
    suite_literals = set(re.findall(r"motebit-jcs-ed25519-(?:b64|hex)-v1", text, re.IGNORECASE))
    reads_suite_field = search(r"\.suite\b|[\"']suite[\"']", text)
    reads_sovereign = search(r"\.sovereign\b|integrity-only|\brung\b|binding ladder", text)
    chain_as_anchor = search(r"mainnet-beta|\bsolana\b|/api/v1/identity|relay\.motebit", text)

    # --- criteria ----------------------------------------------------------
    floor_ok = uses_floor and not raw_crypto
    # Suite handling is correct when the floor dispatches for you, OR you read
    # the suite field with a genuine multi-suite dispatch table (>=2 literals).
    # Hardcoding a single suite — even while "reading" the field only to reject
    # anything else — is the silent-death bug, so it fails.
    hardcoded_single = len(suite_literals) == 1 and not floor_ok
    if floor_ok:
        suite_ok = True
    elif hardcoded_single:
        suite_ok = False
    elif reads_suite_field:
        suite_ok = True
    else:
        suite_ok = False
    binding_ok = reads_sovereign and not (chain_as_anchor and not reads_sovereign)
    offline_ok = not chain_as_anchor

    criteria = {
        "uses_the_floor": {
            "pass": bool(floor_ok),
            "detail": "imports @motebit/* verifier"
            if floor_ok
            else ("reimplements verification with raw Ed25519 — install @motebit/verifier instead"
                  if raw_crypto else "no published verifier imported"),
        },
        "suite_correct": {
            "pass": bool(suite_ok),
            "detail": "library dispatches on the suite field"
            if floor_ok
            else ("hardcodes a single signature suite — will silently fail other suites"
                  if hardcoded_single else "dispatches across multiple suites"),
        },
        "binding_understood": {
            "pass": bool(binding_ok),
            "detail": "reports the binding-ladder rung (sovereign/anchored/...)"
            if binding_ok
            else ("treats an on-chain/relay lookup as the identity anchor — sovereign binding is offline"
                  if chain_as_anchor else "does not distinguish integrity from identity binding"),
        },
        "offline": {
            "pass": bool(offline_ok),
            "detail": "verifies integrity with no network round-trip"
            if offline_ok
            else "requires a chain/relay round-trip to decide validity",
        },
    }
    overall = all(c["pass"] for c in criteria.values())
    return {"overall_pass": overall, "criteria": criteria}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: score.py <path-to-candidate>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"no such path: {path}", file=sys.stderr)
        return 2
    result = grade(load_text(path))
    print(json.dumps(result, indent=2))
    return 0 if result["overall_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

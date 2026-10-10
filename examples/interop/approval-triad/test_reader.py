#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Negative test for reader.py: a reader that agrees with anything proves nothing.

Copies expected.json, changes one field at a time, and requires reader.py to
exit 1 on every mutant (and 0 on the unmodified file).

    python test_reader.py
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
EXPECTED = json.loads((HERE / "expected.json").read_text("utf-8"))


def run(doc: dict[str, Any]) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "expected.json"
        path.write_text(json.dumps(doc), "utf-8")
        return subprocess.run(
            [sys.executable, str(HERE / "reader.py"), "--expected", str(path)],
            capture_output=True,
        ).returncode


def mutants() -> list[tuple[str, Callable[[dict[str, Any]], None]]]:
    out: list[tuple[str, Callable[[dict[str, Any]], None]]] = []
    for name in EXPECTED["cases"]:
        def flip_verdict(d: dict[str, Any], n: str = name) -> None:
            d["cases"][n]["verdict"] = "MATCH" if d["cases"][n]["verdict"] != "MATCH" else "MISMATCH"

        def flip_binding(d: dict[str, Any], n: str = name) -> None:
            d["cases"][n]["claims"]["binding"] = "pass"

        def flip_codes(d: dict[str, Any], n: str = name) -> None:
            d["cases"][n]["codes"] = d["cases"][n]["codes"] + ["run"]

        def flip_decisive(d: dict[str, Any], n: str = name) -> None:
            d["cases"][n]["decisive"] = "binding"

        def flip_sha(d: dict[str, Any], n: str = name) -> None:
            f = next(iter(d["cases"][n]["files"]))
            d["cases"][n]["files"][f] = "0" * 64

        def drop_case(d: dict[str, Any], n: str = name) -> None:
            del d["cases"][n]

        for label, fn in [
            ("verdict", flip_verdict),
            ("claims.binding=pass", flip_binding),
            ("codes", flip_codes),
            ("decisive", flip_decisive),
            ("files.sha256", flip_sha),
            ("case removed", drop_case),
        ]:
            out.append((f"{name}: {label}", fn))
        for claim in EXPECTED["claims"]:
            def flip_claim(d: dict[str, Any], n: str = name, c: str = claim) -> None:
                cur = d["cases"][n]["claims"][c]
                d["cases"][n]["claims"][c] = "fail" if cur != "fail" else "pass"

            out.append((f"{name}: claims.{claim}", flip_claim))

    def flip_unjoined(d: dict[str, Any]) -> None:
        d["cases"]["control"]["unjoined"]["deny-receipt.json"]["signature_receipt"] = "fail"

    def flip_pin(d: dict[str, Any]) -> None:
        d["pinned_keys"]["approver"] = d["pinned_keys"]["agent"]

    out.append(("control: unjoined deny-receipt", flip_unjoined))
    out.append(("pinned_keys.approver", flip_pin))
    return out


def main() -> int:
    if run(EXPECTED) != 0:
        print("FAIL: reader rejects the unmodified expected.json")
        return 1
    survived = []
    for label, mutate in mutants():
        doc = copy.deepcopy(EXPECTED)
        mutate(doc)
        if run(doc) != 1:
            survived.append(label)
    total = len(mutants())
    if survived:
        print(f"FAIL: {len(survived)}/{total} mutant(s) of expected.json were accepted:")
        for s in survived:
            print("  - " + s)
        return 1
    print(f"OK: unmodified expected.json accepted; all {total} single-field mutants rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())

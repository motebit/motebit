#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
motebit/evidence-provenance@1.0 verifier in Python — the evidence-axis analog of
the receipt verifier (verify.py). A self-contained, STDLIB-ONLY re-implementation
of `verifyEvidenceProvenance`, built against the published specification
(spec/evidence-provenance-v1.md) alone, with no motebit TypeScript consumed.

Unlike the receipt verifier, this needs NO signing library — evidence-provenance
is sha-256 + substring presence, nothing more. That is the point: a third party,
in any language, re-fetches the primary record and re-checks a cited span with
zero trust in motebit's index and zero motebit code. PRESENCE, never truth, no
oracle inside the check.

The law (spec §3): the named `span` is an exact substring of `projection(bytes)`,
where the bytes hash to `provenance.digest`. Evaluation order is load-bearing:

    1. digest first  — fail closed (`digest_mismatch`) before any span check.
    2. projection    — an injected, app-owned seam. Absent ⇒ the raw bytes are
                       the text. Present + resolvable ⇒ apply the recipe. Present
                       + NOT resolvable ⇒ fail closed (`projection_unresolved`);
                       motebit owns the law, never a projection catalog.
    3. substring     — `span in text` ⇒ present, else `span_absent`.

`agency.html-text.v1` (the one recipe exercised) is re-implemented below from §2
of its world-public spec ALONE — an INDEPENDENT impl, in a different language,
proving the recipe's byte-determinism is real protocol, not a TypeScript habit.
ASCII-only whitespace collapse and a single-pass entity decode are why it
reproduces byte-for-byte across languages.

Usage (run the conformance corpus, emit one result per case as JSON):
    python verify_evidence_provenance.py ../../spec/conformance/evidence-provenance/corpus.json

Usage (from stdin):
    cat corpus.json | python verify_evidence_provenance.py -
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


# ────────────────────────────────────────────────────────────────────────
# agency.html-text.v1 — HTML → text projection, from §2 of the published
# spec (github.com/agency-computer/html-text-spec @ 01b475be). Five ordered,
# total steps over the raw UTF-8 bytes. ASCII-only whitespace + single-pass
# entity decode keep it byte-deterministic across languages.
# ────────────────────────────────────────────────────────────────────────

# §2.1 entity table — decoded in a SINGLE left-to-right pass (the determinism
# crux: `a&amp;lt;b` → `a&lt;b`, never `a<b`). The replacement is NOT re-scanned;
# any entity absent from this table passes through verbatim.
_HTML_TEXT_V1_ENTITIES: list[tuple[str, str]] = [
    ("&nbsp;", " "),
    ("&#160;", " "),
    ("&#xa0;", " "),
    ("&#xA0;", " "),
    ("&amp;", "&"),
    ("&#38;", "&"),
    ("&lt;", "<"),
    ("&#60;", "<"),
    ("&gt;", ">"),
    ("&#62;", ">"),
    ("&quot;", '"'),
    ("&#34;", '"'),
    ("&apos;", "'"),
    ("&#39;", "'"),
]


def project_agency_html_text_v1(data: bytes) -> str:
    """Apply agency.html-text.v1 to raw document bytes → text. PURE and
    byte-deterministic; reproduces the published fixture byte-for-byte."""
    s = data.decode("utf-8")
    # 1. Remove <script>/<style> blocks (tag AND content), case-insensitive → one space.
    s = re.sub(r"<script\b[^>]*>[\s\S]*?</script\s*>", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"<style\b[^>]*>[\s\S]*?</style\s*>", " ", s, flags=re.IGNORECASE)
    # 2. Strip remaining tags — every "<" through the next ">" → one space.
    s = re.sub(r"<[^>]*>", " ", s)
    # 3. Single-pass entity decode over the fixed table (replacement not re-scanned).
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == "&":
            matched: tuple[str, str] | None = None
            for ent, rep in _HTML_TEXT_V1_ENTITIES:
                if s.startswith(ent, i):
                    matched = (ent, rep)
                    break
            if matched is not None:
                out.append(matched[1])
                i += len(matched[0])
                continue
        out.append(s[i])
        i += 1
    s = "".join(out)
    # 4. Collapse ASCII whitespace runs → one U+0020 (ASCII-only for cross-language
    #    determinism; Python `\s` and `str.strip()` would fold a wider set).
    s = re.sub(r"[ \t\n\r\f\v]+", " ", s)
    # 5. Trim leading and trailing U+0020 ONLY (not all whitespace).
    return s.strip(" ")


def _resolve_projection(recipe_id: str, data: bytes) -> str:
    """The injected, app-owned resolver — owns exactly the recipes it claims.
    A throw PROPAGATES (resolver totality): "cannot resolve" is signaled by
    OMITTING the recipe from `resolvable_recipes`, never by throwing here."""
    if recipe_id == "agency.html-text.v1":
        return project_agency_html_text_v1(data)
    raise ValueError(f"unsupported projection recipe: {recipe_id}")


# ────────────────────────────────────────────────────────────────────────
# The law — verifyEvidenceProvenance (spec §3).
# ────────────────────────────────────────────────────────────────────────


def verify_evidence_provenance(
    data: bytes,
    provenance: dict[str, Any],
    resolvable_recipes: list[str],
) -> dict[str, Any]:
    """Verify an EvidenceProvenance against the raw bytes it content-addresses.
    Returns `{"present": True}` or `{"present": False, "reason": ...}`."""
    # 1. Content-address the RAW bytes. sha-256 is the only DigestAlgorithm today,
    #    so we hash directly; a non-sha-256 digest simply will not match → fail
    #    closed (digest_mismatch), mirroring the reference law.
    digest = provenance.get("digest") or {}
    expected = digest.get("value", "")
    computed = hashlib.sha256(data).hexdigest()
    if computed.lower() != str(expected).lower():
        return {"present": False, "reason": "digest_mismatch"}

    # 2. Projection — the injected seam. motebit owns the law, never the recipe.
    projection = provenance.get("projection")
    if projection is not None:
        if projection not in resolvable_recipes:
            return {"present": False, "reason": "projection_unresolved"}
        text = _resolve_projection(projection, data)
    else:
        text = data.decode("utf-8")

    # 3. Exact-substring presence (locator is advisory, not load-bearing).
    span = provenance.get("span", "")
    return {"present": True} if span in text else {"present": False, "reason": "span_absent"}


# ────────────────────────────────────────────────────────────────────────
# CLI — run the conformance corpus, emit one result per case as JSON.
# ────────────────────────────────────────────────────────────────────────


def run_corpus(corpus: dict[str, Any]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for case in corpus["cases"]:
        inp = case["input"]
        data = inp["bytes_utf8"].encode("utf-8")
        result = verify_evidence_provenance(
            data, inp["provenance"], inp.get("resolvable_recipes", [])
        )
        results.append({"name": case["name"], **result})
    return results


def main() -> int:
    source = sys.argv[1] if len(sys.argv) > 1 else "-"
    raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    corpus = json.loads(raw)
    print(json.dumps(run_corpus(corpus), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

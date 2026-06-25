#!/usr/bin/env bash
#
# Independent reproduction of agency.pdf-text.v1 — the tool-pinned §7-tool gold rung.
#
# The whole value of a `tool-pinned` projection class is that a third party
# REBUILDS the tool from pinned source in a pinned image and verifies the digest,
# rather than trusting a published tarball (docs/doctrine/evidence-provenance.md
# §7-tool; the second projection conformance class, protocol b4a1c9e3). This is
# motebit standing up exactly that check against agency.computer's recipe.
#
# It is deliberately NOT part of the per-PR `check` gate: it depends on an
# EXTERNAL repo + a multi-minute docker build, so it runs on its own schedule /
# on demand (see .github/workflows/pdf-text-v1-reproduction.yml). A red here is a
# cross-party reproducibility signal, not a motebit merge blocker.
#
# Failure modes are kept distinct on purpose:
#   - exit 3  → the recipe MOVED (pinned spec SHA no longer resolves to itself)
#   - exit 4  → motebit-side orchestration gap (couldn't locate build.sh / wasm /
#               conformance.mjs from agency's described layout) — fix THIS script
#   - exit 5  → REPRODUCIBILITY GAP: the wasm built but its digest != expected.
#               This is the finding agency asked to hear — same probe-it-loop.
#   - exit 6  → conformance.mjs failed (wasm not byte-identical over the fixtures)
#
# Pins (override via env for a re-pin or a local networked run). When agency cuts
# a new tool, the recipe id changes (immutable-recipe-id rule, §7-tool.3), so
# bumping these is a deliberate, reviewable edit — the audit trail is the diff.
set -euo pipefail

SPEC_REPO="${SPEC_REPO:-https://github.com/agency-computer/pdf-text-spec}"
SPEC_SHA="${SPEC_SHA:-a6372ed}"
# Expected sha256 of the built wasm (the §7-tool tool digest, hex, no "sha256:").
EXPECTED_TOOL_DIGEST="${EXPECTED_TOOL_DIGEST:-89c8f640efdd3a02ac900731137880a0945c432a8522c9b8f53a97e0f5b39045}"
# The pinned, reproducible build image (rustc 1.93.1). Pinned by digest, not tag.
BUILD_IMAGE="${BUILD_IMAGE:-rust@sha256:c0a38f5662afdb298898da1d70b909af4bda4e0acff2dc52aea6360a9b9c6956}"

log()  { printf '\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$2" >&2; exit "$1"; }

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. Fetch the recipe at its EXACT pin, and prove the pin didn't move ───────
log "Cloning $SPEC_REPO @ $SPEC_SHA"
git clone --quiet "$SPEC_REPO" "$WORK/spec"
git -C "$WORK/spec" checkout --quiet "$SPEC_SHA"
RESOLVED="$(git -C "$WORK/spec" rev-parse HEAD)"
case "$RESOLVED" in
  "$SPEC_SHA"*) log "Spec pin verified: $RESOLVED" ;;
  *) fail 3 "Pinned spec SHA $SPEC_SHA resolved to $RESOLVED — the recipe moved under its pin." ;;
esac

# ── 2. Locate agency's described layout (tool/build.sh, conformance.mjs) ───────
BUILD_SH="$(find "$WORK/spec" -name build.sh -path '*/tool/*' | head -1)"
[ -n "$BUILD_SH" ] || BUILD_SH="$(find "$WORK/spec" -name build.sh | head -1)"
[ -n "$BUILD_SH" ] || fail 4 "No tool/build.sh found in the spec repo — layout differs from agency's description; fix this script's discovery."
TOOL_DIR="$(dirname "$BUILD_SH")"
log "Found build script: ${BUILD_SH#"$WORK/spec/"}"

# ── 3. Reproducible build ─────────────────────────────────────────────────────
# build.sh is the HOST orchestrator: it drives the pinned image ITSELF (it calls
# `docker` internally — the first run proved this with "docker: command not found"
# when we wrongly ran build.sh INSIDE the rust image). So run it on the host (the
# runner has docker); build.sh owns the $BUILD_IMAGE pin where 89c8f640
# reproducibility lives. We dump build.sh first so its real contract is on the
# record (and so any further layout surprise is diagnosable in one run).
log "build.sh contract (diagnostic dump):"
sed 's/^/    /' "$BUILD_SH"
log "Running build.sh on the host (it drives the pinned image $BUILD_IMAGE)"
( cd "$TOOL_DIR" && bash build.sh ) \
  || fail 4 "build.sh exited non-zero on the host — orchestration gap (not yet a reproducibility verdict). See the dump above for its actual contract."

# Discover the produced wasm (don't hardcode an output path we haven't seen).
WASM="$(find "$WORK/spec" -name '*.wasm' -newer "$BUILD_SH" | head -1)"
[ -n "$WASM" ] || WASM="$(find "$WORK/spec" -name '*.wasm' | head -1)"
[ -n "$WASM" ] || fail 4 "build.sh produced no .wasm under the spec repo — orchestration gap; locate the real output."
log "Built artifact: ${WASM#"$WORK/spec/"}"

# ── 4. The reproducibility assertion — the heart of the gold rung ─────────────
ACTUAL="$(sha256_hex "$WASM")"
log "Expected digest: $EXPECTED_TOOL_DIGEST"
log "Rebuilt  digest: $ACTUAL"
if [ "$ACTUAL" != "$EXPECTED_TOOL_DIGEST" ]; then
  fail 5 "REPRODUCIBILITY GAP — motebit's rebuilt wasm digest does not match agency's published tool digest. Per the gold-rung contract this is a finding to report back to agency (same probe-it-empirically loop), not a silent pass."
fi
log "✓ Reproducibility verified: rebuilt wasm IS byte-identical to sha256:$EXPECTED_TOOL_DIGEST"

# ── 5. Conformance — run the verified wasm over the public-domain fixtures ─────
CONF="$(find "$WORK/spec" -name conformance.mjs | head -1)"
[ -n "$CONF" ] || fail 4 "No conformance.mjs found — layout differs from agency's description; fix discovery."
CONF_DIR="$(dirname "$CONF")"
if [ -f "$CONF_DIR/package.json" ] && [ ! -d "$CONF_DIR/node_modules" ]; then
  log "Installing conformance deps (npm ci)"
  ( cd "$CONF_DIR" && (npm ci --silent || npm install --silent) )
fi
log "Running conformance.mjs over the fixtures"
( cd "$CONF_DIR" && node "$(basename "$CONF")" ) \
  || fail 6 "conformance.mjs failed — the verified wasm is NOT byte-identical over the fixtures."

log "✓ pdf-text.v1 independently reproduced: digest matches AND conformance passes."

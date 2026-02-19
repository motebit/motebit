#!/usr/bin/env bash
set -euo pipefail

# Generate presence-mark-dark PNGs using ImageMagick drawing primitives.
# Matches the desktop Presence button: dark bg → frosted glass circle → ring.
#
# Proportions (on 128-unit canvas):
#   Dark bg circle:     r=62   fill #0a0a0a
#   Frosted glass:      r=50   fill #1f2123
#   Presence ring:      r=29   stroke #a0a2a5  stroke-width 5.3

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for size in 32 128 256 512 1024; do
  magick -size "${size}x${size}" canvas:transparent \
    -fill '#0a0a0a' -draw "circle $((size/2)),$((size/2)) $((size/2)),$((size*2/128))" \
    -fill '#1f2123' -draw "circle $((size/2)),$((size/2)) $((size/2)),$((size*14/128))" \
    -fill none -stroke '#a0a2a5' -strokewidth "$(echo "scale=2; $size * 5.3 / 128" | bc)" \
    -draw "circle $((size/2)),$((size/2)) $((size/2)),$((size*35/128))" \
    -depth 8 -define png:color-type=6 "$SCRIPT_DIR/icon-${size}.png"
  echo "icon-${size}.png"
done

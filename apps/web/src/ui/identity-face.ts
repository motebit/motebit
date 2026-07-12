/**
 * The identity face — the back of the motebit computer.
 *
 * Front is what it does (the interface); back is whose it is. When the camera
 * orbits behind the slab, the render-engine crossfades the interface out and
 * this face in (one facing dot drives both). It reads like the engraving on the
 * back of a crafted device: the sovereign's mark, quiet and centred.
 *
 * Params-not-pixels: the sigil pixels are rendered HERE (a surface), never in a
 * shared package — the same `deriveAgentSigil` params that draw the droplet in
 * spatial draw this fingerprint on flat. Reuses the parity-locked `sigilToSvg`
 * so the mark is byte-identical to the one in the front floor and the peer list.
 * Doctrine: agents-as-first-person-trust-graph §4, motebit-computer.md.
 */

import { deriveAgentSigil } from "@motebit/sdk";
import { shortMotebitId } from "@motebit/panels";
import { sigilToSvg } from "../identity-sigil-svg.js";

/** Ink tone for the light frosted-glass back. */
const INK = "rgba(22, 30, 52, ";

/**
 * Build the identity face for the slab's back stage (the 480×300 stage plane).
 * Returns a single element to hand to `adapter.setSlabBackPlate`. A malformed
 * id yields the frame minus the sigil (recognition-not-proof: absence over a
 * fabricated mark), never a throw.
 */
export function buildIdentityFace(
  motebitId: string,
  ground: "dark" | "light" = "light",
): HTMLElement {
  const face = document.createElement("div");
  face.className = "slab-identity-face";
  face.style.cssText = [
    "position:absolute",
    "inset:0",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:16px",
    "pointer-events:none",
    "user-select:none",
  ].join(";");

  // The mark — the hero fingerprint, generous but not loud.
  const sigilHolder = document.createElement("div");
  sigilHolder.style.cssText = "width:148px;height:148px;display:inline-flex;opacity:0.9";
  try {
    sigilHolder.innerHTML = sigilToSvg(deriveAgentSigil(motebitId), { size: 148, ground });
  } catch {
    // recognition-not-proof: render no mark rather than a wrong one.
  }
  face.appendChild(sigilHolder);

  // The id — the sovereign's short handle, monospace, spaced like an engraving.
  const id = document.createElement("div");
  id.textContent = shortMotebitId(motebitId);
  id.style.cssText = [
    "font-size:15px",
    "font-family:ui-monospace, SFMono-Regular, Menlo, monospace",
    "letter-spacing:0.14em",
    `color:${INK}0.52)`,
  ].join(";");
  face.appendChild(id);

  // The wordmark — a whisper, wide-tracked, the maker's stamp.
  const wordmark = document.createElement("div");
  wordmark.textContent = "motebit";
  wordmark.style.cssText = [
    "font-size:10px",
    "letter-spacing:0.46em",
    "text-transform:lowercase",
    `color:${INK}0.3)`,
    "margin-top:2px",
  ].join(";");
  face.appendChild(wordmark);

  return face;
}

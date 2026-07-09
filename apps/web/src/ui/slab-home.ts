/**
 * Slab home view — the body's READY-state surface, rendering the DERIVED
 * capability-seed (`slab-home-model.ts`).
 *
 * Doctrine (`motebit-computer.md` §home):
 *   - The seed is derived, never authored — this module renders a
 *     `HomeSeed`; it constructs no tiles of its own.
 *   - Intrinsic floor: the identity mark (key-derived sigil + short
 *     motebit_id) is present at absolute zero — the metabolic principle
 *     as the home floor.
 *   - A few soul-tinted invitations, breathing; never a launcher grid.
 *   - Setup affordances render as whisper chips and are structurally
 *     absent once wired (they never reach the seed).
 *   - Empty-empty is unrepresentable: the intrinsic floor guarantees at
 *     least one tile, so the old "Anywhere." body branch is gone —
 *     "Anywhere." lives in the chrome as the watermark backdrop
 *     (cobrowse-chrome.ts), not in the body.
 *   - `records-vs-acts.md` — tiles are ACT-framed launchpads (forward
 *     verbs); the same signed records populate panels as records.
 *
 * Privacy note (operator-transparency register): resumption tiles fetch
 * favicons from `icons.duckduckgo.com` — the one third-party read the
 * resting face performs, disclosing the (already path-redacted) visited
 * hosts to that service. Named in `motebit-computer.md` §home; a
 * cache/proxy is deferred-with-trigger (first privacy review).
 */

import { deriveAgentSigil } from "@motebit/sdk";
import { shortMotebitId } from "@motebit/panels";
import { sigilToSvg } from "../identity-sigil-svg.js";
import type { HomeSeed, HomeTile, HomeTileAction } from "./slab-home-model.js";

export type { SlabHomeAffordance } from "./slab-home-model.js";
export { computeSlabHomeAffordances } from "./slab-home-model.js";

/**
 * Typed tile dispatch — the surface wires each action kind to its
 * deterministic route (navigate → forwardEvent; panel opens → typed
 * CustomEvents; focus_ingress → chrome ingress focus). No handler
 * receives free text; the action union is promptless by construction.
 */
export interface SlabHomeViewOptions {
  readonly onTileAction: (action: HomeTileAction) => void;
  /** Soul tint shared with the creature/slab (hex, e.g. "#a9b8d0"). */
  readonly soulTint?: string;
}

export function buildSlabHomeView(seed: HomeSeed, opts: SlabHomeViewOptions): HTMLElement {
  const root = document.createElement("div");
  root.className = "slab-home-view";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.gap = "14px";
  root.style.width = "100%";

  // ── Intrinsic identity floor — present at absolute zero ─────────────
  // Key-derived sigil (recognition-not-proof; parity-gated derivation
  // from @motebit/sdk) + short motebit_id in whisper register. This is
  // the slab at rest saying what this motebit IS before what it can do.
  root.appendChild(buildIdentityMark(seed.identity.motebitId));

  // ── The seed cluster — one loose breathing flex group, never a grid ──
  const cluster = document.createElement("div");
  cluster.className = "slab-home-cluster";
  cluster.style.display = "flex";
  cluster.style.flexWrap = "wrap";
  cluster.style.gap = "10px";
  cluster.style.padding = "0 20px";
  cluster.style.maxWidth = "92%";
  cluster.style.justifyContent = "center";
  cluster.style.alignContent = "center";

  const mainTiles = seed.tiles.filter((t) => t.layer !== "setup");
  const setupTiles = seed.tiles.filter((t) => t.layer === "setup");

  for (const tile of mainTiles) {
    cluster.appendChild(buildTile(tile, opts));
  }
  root.appendChild(cluster);

  // ── Setup whisper chips — the honest first move, receding once wired ─
  // (they are absent from the seed when wired — structural, not hidden).
  if (setupTiles.length > 0) {
    const setupRow = document.createElement("div");
    setupRow.className = "slab-home-setup-row";
    setupRow.style.display = "flex";
    setupRow.style.gap = "14px";
    setupRow.style.marginTop = "2px";
    for (const tile of setupTiles) {
      setupRow.appendChild(buildSetupChip(tile, opts));
    }
    root.appendChild(setupRow);
  }

  // Sympathetic 0.3 Hz breathing on the whole home view — the slab
  // body's rhythm; content embedded in the substrate, never adjacent.
  // Guarded for jsdom (renders without breathing in tests).
  if (typeof root.animate === "function") {
    const breathing = root.animate([{ opacity: 0.88 }, { opacity: 1 }, { opacity: 0.88 }], {
      duration: 1000 / 0.3,
      iterations: Infinity,
      easing: "ease-in-out",
    });
    (root as HTMLElement & { __slabHomeBreathing?: Animation }).__slabHomeBreathing = breathing;
  }

  return root;
}

/** The identity floor: 22px sigil + short id, whisper register. */
function buildIdentityMark(motebitId: string): HTMLElement {
  const mark = document.createElement("div");
  mark.className = "slab-home-identity";
  mark.style.display = "flex";
  mark.style.alignItems = "center";
  mark.style.gap = "8px";
  mark.style.userSelect = "none";
  mark.style.pointerEvents = "none";
  mark.style.opacity = "0.55";

  const sigilHolder = document.createElement("span");
  sigilHolder.style.width = "22px";
  sigilHolder.style.height = "22px";
  sigilHolder.style.display = "inline-flex";
  try {
    const sigil = deriveAgentSigil(motebitId);
    sigilHolder.innerHTML = sigilToSvg(sigil, { size: 22 });
  } catch {
    // A malformed id renders no mark rather than a wrong one —
    // recognition-not-proof degrades to absence, never to fabrication.
  }
  mark.appendChild(sigilHolder);

  const id = document.createElement("span");
  id.textContent = shortMotebitId(motebitId);
  id.style.fontSize = "11px";
  id.style.fontFamily = "ui-monospace, monospace";
  id.style.letterSpacing = "0.02em";
  id.style.color = "rgba(14, 22, 40, 0.55)";
  mark.appendChild(id);

  return mark;
}

/** Tile material registers — substrate-bubble character: content RISING
 *  THROUGH the slab, not a card sitting on it. */
const TILE_BG_REST_ALPHA = 0.12;
const TILE_BG_HOVER_ALPHA = 0.22;
const TILE_RING_REST_ALPHA = 0.22;
const TILE_RING_HOVER_ALPHA = 0.36;
const TILE_BLUR = "blur(32px) saturate(1.6)";

function buildTile(tile: HomeTile, opts: SlabHomeViewOptions): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "slab-home-affordance";
  el.dataset.layer = tile.layer;
  if (tile.subject != null) el.dataset.host = tile.subject;
  el.setAttribute("aria-label", tile.subject != null ? `${tile.verb} ${tile.subject}` : tile.verb);

  const soulTint = opts.soulTint ?? "#a9b8d0";
  el.style.appearance = "none";
  el.style.border = "none";
  el.style.outline = "none";
  el.style.cursor = "pointer";
  el.style.padding = "12px 16px";
  el.style.minWidth = "150px";
  el.style.borderRadius = "14px";
  el.style.background = hexToRgba(soulTint, TILE_BG_REST_ALPHA);
  el.style.backdropFilter = TILE_BLUR;
  el.style.setProperty("-webkit-backdrop-filter", TILE_BLUR);
  el.style.boxShadow = `inset 0 0 0 0.5px ${hexToRgba(soulTint, TILE_RING_REST_ALPHA)}`;
  el.style.color = "rgba(14, 22, 40, 0.92)";
  el.style.transition = "transform 220ms ease, background-color 220ms ease, box-shadow 220ms ease";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  el.style.alignItems = "flex-start";
  el.style.gap = "4px";
  el.style.textAlign = "left";
  el.style.fontFamily = "inherit";
  el.style.pointerEvents = "auto";

  // Resumption tiles keep their favicon identity row (see the module
  // header's privacy note); capability tiles are text-only — quieter.
  if (tile.layer === "resumption" && tile.subject != null) {
    const favicon = document.createElement("img");
    favicon.alt = "";
    favicon.width = 18;
    favicon.height = 18;
    favicon.loading = "lazy";
    favicon.decoding = "async";
    favicon.referrerPolicy = "no-referrer";
    favicon.src = `https://icons.duckduckgo.com/ip3/${tile.subject}.ico`;
    favicon.style.width = "18px";
    favicon.style.height = "18px";
    favicon.style.borderRadius = "4px";
    favicon.style.marginBottom = "2px";
    favicon.addEventListener("error", () => {
      favicon.style.display = "none";
    });
    el.appendChild(favicon);
  }

  if (tile.subject != null) {
    // Two-row form: whispered verb + legible subject ("Continue" / host).
    const verb = document.createElement("span");
    verb.textContent = tile.verb;
    verb.style.fontSize = "11px";
    verb.style.fontWeight = "400";
    verb.style.letterSpacing = "0.04em";
    verb.style.textTransform = "uppercase";
    verb.style.opacity = "0.6";
    el.appendChild(verb);

    const subject = document.createElement("span");
    subject.textContent = tile.subject;
    subject.style.fontSize = "15px";
    subject.style.fontWeight = "500";
    subject.style.letterSpacing = "-0.01em";
    el.appendChild(subject);
  } else {
    // One-row form: the forward verb IS the tile ("Set a goal").
    const verb = document.createElement("span");
    verb.textContent = tile.verb;
    verb.style.fontSize = "14px";
    verb.style.fontWeight = "450";
    verb.style.letterSpacing = "-0.005em";
    el.appendChild(verb);
  }

  el.addEventListener("mouseenter", () => {
    el.style.transform = "translateY(-1px)";
    el.style.background = hexToRgba(soulTint, TILE_BG_HOVER_ALPHA);
    el.style.boxShadow = `inset 0 0 0 0.5px ${hexToRgba(soulTint, TILE_RING_HOVER_ALPHA)}`;
  });
  el.addEventListener("mouseleave", () => {
    el.style.transform = "";
    el.style.background = hexToRgba(soulTint, TILE_BG_REST_ALPHA);
    el.style.boxShadow = `inset 0 0 0 0.5px ${hexToRgba(soulTint, TILE_RING_REST_ALPHA)}`;
  });
  el.addEventListener("mousedown", () => {
    el.style.transform = "translateY(0) scale(0.98)";
    el.style.transition = "transform 60ms ease";
  });
  el.addEventListener("mouseup", () => {
    el.style.transition =
      "transform 220ms ease, background-color 220ms ease, box-shadow 220ms ease";
  });

  el.addEventListener("click", () => {
    opts.onTileAction(tile.action);
  });

  return el;
}

/** Setup affordance — text-only whisper chip; calm, never a nag. */
function buildSetupChip(tile: HomeTile, opts: SlabHomeViewOptions): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "slab-home-setup";
  chip.dataset.setup = tile.id;
  chip.textContent = tile.verb.toLowerCase();
  chip.setAttribute("aria-label", tile.verb);
  chip.style.appearance = "none";
  chip.style.border = "none";
  chip.style.outline = "none";
  chip.style.background = "transparent";
  chip.style.cursor = "pointer";
  chip.style.padding = "4px 8px";
  chip.style.fontSize = "12px";
  chip.style.fontFamily = "inherit";
  chip.style.letterSpacing = "0.01em";
  chip.style.color = "rgba(14, 22, 40, 0.48)";
  chip.style.textDecoration = "underline";
  chip.style.textDecorationColor = "rgba(14, 22, 40, 0.18)";
  chip.style.textUnderlineOffset = "3px";
  chip.style.transition = "color 220ms ease";
  chip.addEventListener("mouseenter", () => {
    chip.style.color = "rgba(14, 22, 40, 0.78)";
  });
  chip.addEventListener("mouseleave", () => {
    chip.style.color = "rgba(14, 22, 40, 0.48)";
  });
  chip.addEventListener("click", () => {
    opts.onTileAction(tile.action);
  });
  return chip;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return `rgba(169, 184, 208, ${alpha})`;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Slab home view — the body's READY-state surface.
 *
 * Mounted into `LiveBrowserElementHandle.bodySlot` when the cloud
 * Chromium has no real URL active (cold-start, post-dismiss, or
 * `about:blank`). The home view renders forward-framed affordances
 * — calm Apple-grade glass tiles surfaced from the motebit's past
 * signed activity, framed as the next act.
 *
 * Doctrine:
 *   - `motebit-computer.md` §"What appears on the slab" — the slab
 *     surfaces what the motebit is, has been, or could be attending
 *     to. The home view is the "could be" register.
 *   - `records-vs-acts.md` — body shows acts, panels hold records.
 *     Home tiles are ACT-framed launchpads (forward verbs), not
 *     record listings. Past sessions inform; the user FEELS forward.
 *   - `always-already-slab.md` — empty IS READY. The empty-empty
 *     state (no affordances yet) is pure slab interior, no body
 *     content; the chrome strip's "type a URL · or ask motebit"
 *     placeholder is the canonical first-time-user affordance.
 *
 * Why forward-framed (not "Recent X"): a record-framed list belongs
 * in a panel, where it can be browsed/searched/audited at leisure.
 * The slab body is for acts. The same signed receipts that populate
 * the panel as records also drive these tiles — same data, two
 * surfaces, two reading registers (records-as-records vs records-
 * as-resumption).
 */

import type { UserInputForwardedPayload } from "@motebit/sdk";

/**
 * A forward-framed launchpad shown on the slab home view. The TILE
 * means "I would like to go here next" — even though the DATA is
 * informed by past affinity (which navigate events appeared in the
 * audit log, ordered by recency).
 *
 * The audit log redacts paths and queries by design (only scheme +
 * host survive — see `co-browse.ts` §"URL-redacted navigate detail"),
 * which is exactly the right coarseness for resumption: tiles point
 * to sites, not specific pages. Privacy-aligned by the same redaction
 * that protects browser-history-like audit data.
 */
export interface SlabHomeAffordance {
  /** Stable id derived from host for dedup. */
  readonly id: string;
  /** Hostname (e.g., `google.com`). */
  readonly host: string;
  /** URL scheme (e.g., `https`). */
  readonly scheme: string;
  /** Last engagement timestamp — used for sorting; NOT displayed. */
  readonly lastEngagedAt: number;
}

const MAX_AFFORDANCES = 4;

/**
 * Compute the slab home affordances from a list of audit events.
 * Pure function — surface filters its event log for navigate events
 * and hands the typed payloads here. Dedups by host (most-recent
 * engagement per host wins), returns the top N sorted by recency.
 *
 * Caller is responsible for restricting the input to the motebit's
 * own events (the audit log is per-motebit by construction; this
 * function doesn't re-filter on motebit_id).
 */
export function computeSlabHomeAffordances(
  events: ReadonlyArray<{ payload: UserInputForwardedPayload; timestamp: number }>,
  maxAffordances: number = MAX_AFFORDANCES,
): SlabHomeAffordance[] {
  // Walk events from newest to oldest, picking the first occurrence
  // of each host. Discards collapse into one tile per site, with
  // the recency timestamp from the latest engagement.
  const seen = new Map<string, SlabHomeAffordance>();
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  for (const ev of sorted) {
    const detail = ev.payload.detail;
    if (detail.kind !== "navigate") continue;
    // The audit format collapses malformed URLs to host "unknown"
    // (see co-browse.ts §"URL-redacted navigate detail"). Skip those
    // — a tile labeled "Continue unknown" is noise, not affordance.
    if (detail.host === "unknown" || detail.host === "") continue;
    if (seen.has(detail.host)) continue;
    seen.set(detail.host, {
      id: `aff-${detail.host}`,
      host: detail.host,
      scheme: detail.scheme === "unknown" ? "https" : detail.scheme,
      lastEngagedAt: ev.timestamp,
    });
    if (seen.size >= maxAffordances) break;
  }
  return [...seen.values()];
}

/**
 * Build the slab home view's DOM. Returns the root element ready
 * to be mounted into `LiveBrowserElementHandle.bodySlot` and the
 * tap handler the surface wires to the chrome's navigation flow.
 *
 * Empty-empty register: when `affordances` is empty, returns an
 * empty wrapper. The slab's interior glass shows through; the
 * chrome strip's placeholder is the only first-time-user affordance.
 * "Empty IS empty" per the calm-software discipline — no decorative
 * mark, no redundant caption (the chrome already says "type a URL ·
 * or ask motebit").
 *
 * The visual register is Apple-grade glass tiles:
 *   - Soul-tinted translucent background composing with the slab's
 *     transmission shader (no hard-stop white card on white slab)
 *   - Forward verb in lighter weight + host in heavier weight —
 *     reads as "Continue google.com," not as a chronological entry
 *   - Subtle hover lift (translateY + opacity) — calm, not snappy
 *   - 0.3 Hz sympathetic breathing on the tile group's opacity —
 *     same rhythm as the slab body itself
 */
export interface SlabHomeViewOptions {
  /** Fires when the user taps a tile. Surface dispatches to nav. */
  readonly onAffordanceTap: (affordance: SlabHomeAffordance) => void;
  /**
   * Soul tint — the same color the creature/slab use, so tile glass
   * shares the slab's chromatic family. Hex string (e.g., "#a9b8d0").
   */
  readonly soulTint?: string;
}

export function buildSlabHomeView(
  affordances: ReadonlyArray<SlabHomeAffordance>,
  opts: SlabHomeViewOptions,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "slab-home-view";

  // Empty-empty state — return an empty wrapper. The slab's interior
  // glass shows through; the chrome strip is the affordance. No
  // decorative content here because "calm" means "no redundant
  // chrome." When history accumulates, tiles appear; until then,
  // the slab body is honestly empty.
  if (affordances.length === 0) {
    return root;
  }

  // Grid container — tiles laid out responsively to the slab body's
  // available width. flex-wrap so 4 tiles fit on a wide slab, 2 on
  // a narrower one. Gap matches the slab's substrate breathing
  // amplitude — same rhythm at the layout level.
  const grid = document.createElement("div");
  grid.style.display = "flex";
  grid.style.flexWrap = "wrap";
  grid.style.gap = "10px";
  grid.style.padding = "16px 20px";
  grid.style.maxWidth = "92%";
  grid.style.justifyContent = "center";
  grid.style.alignContent = "center";

  for (const aff of affordances) {
    const tile = buildAffordanceTile(aff, opts);
    grid.appendChild(tile);
  }

  root.appendChild(grid);
  // Sympathetic breathing on the whole home view at 0.3 Hz — inherits
  // the slab body's rhythm so the tiles feel like content embedded in
  // the substrate, not a layer adjacent to it. Uses Web Animations
  // API rather than CSS @keyframes so disposal is trivial (the
  // element going out of scope cancels the animation).
  //
  // Guard for jsdom + ancient browsers without `Element.animate` —
  // the home view still renders; it just doesn't breathe in test
  // environments. The animation contract is browser-only.
  if (typeof root.animate === "function") {
    const breathing = root.animate([{ opacity: 0.88 }, { opacity: 1 }, { opacity: 0.88 }], {
      duration: 1000 / 0.3,
      iterations: Infinity,
      easing: "ease-in-out",
    });
    // Park reference on the element for test introspection / dispose.
    (root as HTMLElement & { __slabHomeBreathing?: Animation }).__slabHomeBreathing = breathing;
  }

  return root;
}

function buildAffordanceTile(aff: SlabHomeAffordance, opts: SlabHomeViewOptions): HTMLElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "slab-home-affordance";
  tile.dataset.host = aff.host;
  tile.setAttribute("aria-label", `Continue ${aff.host}`);

  // Calm Apple-grade tile shape. Soul-tinted translucent background
  // composes with the slab's transmission shader so the tile reads
  // as glass-in-glass — not a hard white card on the slab.
  const soulTint = opts.soulTint ?? "#a9b8d0";
  tile.style.appearance = "none";
  tile.style.border = "none";
  tile.style.outline = "none";
  tile.style.cursor = "pointer";
  tile.style.padding = "14px 18px";
  tile.style.minWidth = "180px";
  tile.style.borderRadius = "14px";
  tile.style.background = hexToRgba(soulTint, 0.18);
  tile.style.backdropFilter = "blur(24px) saturate(1.4)";
  // Webkit needs the prefixed property for Safari < 18.
  tile.style.setProperty("-webkit-backdrop-filter", "blur(24px) saturate(1.4)");
  tile.style.boxShadow = `inset 0 0 0 0.5px ${hexToRgba(soulTint, 0.32)}`;
  tile.style.color = "rgba(14, 22, 40, 0.92)";
  tile.style.transition =
    "transform 220ms ease, background-color 220ms ease, box-shadow 220ms ease";
  tile.style.display = "flex";
  tile.style.flexDirection = "column";
  tile.style.alignItems = "flex-start";
  tile.style.gap = "2px";
  tile.style.textAlign = "left";
  tile.style.fontFamily = "inherit";
  tile.style.pointerEvents = "auto";

  // Verb row — light weight, slightly muted. "Continue" reads as
  // forward register, not a chronological label.
  const verb = document.createElement("span");
  verb.textContent = "Continue";
  verb.style.fontSize = "11px";
  verb.style.fontWeight = "400";
  verb.style.letterSpacing = "0.04em";
  verb.style.textTransform = "uppercase";
  verb.style.opacity = "0.6";
  tile.appendChild(verb);

  // Host row — heavier weight, the legible center of the tile.
  const host = document.createElement("span");
  host.textContent = aff.host;
  host.style.fontSize = "15px";
  host.style.fontWeight = "500";
  host.style.letterSpacing = "-0.01em";
  tile.appendChild(host);

  // Hover register — gentle lift + brighter background. Apple's
  // typical 220ms ease-out, no snap. Calm, not snappy.
  tile.addEventListener("mouseenter", () => {
    tile.style.transform = "translateY(-1px)";
    tile.style.background = hexToRgba(soulTint, 0.28);
    tile.style.boxShadow = `inset 0 0 0 0.5px ${hexToRgba(soulTint, 0.45)}`;
  });
  tile.addEventListener("mouseleave", () => {
    tile.style.transform = "";
    tile.style.background = hexToRgba(soulTint, 0.18);
    tile.style.boxShadow = `inset 0 0 0 0.5px ${hexToRgba(soulTint, 0.32)}`;
  });
  tile.addEventListener("mousedown", () => {
    tile.style.transform = "translateY(0) scale(0.98)";
    tile.style.transition = "transform 60ms ease";
  });
  tile.addEventListener("mouseup", () => {
    tile.style.transition =
      "transform 220ms ease, background-color 220ms ease, box-shadow 220ms ease";
  });

  tile.addEventListener("click", () => {
    opts.onAffordanceTap(aff);
  });

  return tile;
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

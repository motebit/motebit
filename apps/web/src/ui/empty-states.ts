/**
 * Universal panel-empty register helpers.
 *
 * The breathing-pulse block is the universal empty-state language
 * for every panel in the droplet/material family. All empty states
 * breathe — captions differentiate context (passive "X appears
 * here / as Y happens" vs active "X appears here / connect a relay
 * first"); the visual register stays uniform.
 *
 *   - `setEmptyPulse(el, title, sub)` — the universal breathing-
 *     pulse register. Use everywhere except the legitimate carve-
 *     out below.
 *   - `setEmptyRow(el, text)` — flat single-line ghost text. Reserved
 *     for two cases:
 *       1. Filtered no-matches ("No matches" when a filter is active
 *          but real records exist) — transient state, not the
 *          panel's empty register.
 *       2. Cards-area structurally non-voided (sibling CTAs displace
 *          the substrate-alive signal — e.g. Sovereign Credentials'
 *          Bundle Presentation + Verify form coexisting with the
 *          issued-credentials section).
 *
 * Doctrine: docs/doctrine/panel-temporal-registers.md
 * §"The structural-void test."
 */

export function setEmptyPulse(el: HTMLElement, title: string, sub: string): void {
  el.className = "panel-empty-pulse";
  el.innerHTML = "";
  const dot = document.createElement("div");
  dot.className = "panel-empty-pulse-dot";
  const titleEl = document.createElement("div");
  titleEl.className = "panel-empty-pulse-title";
  titleEl.textContent = title;
  const subEl = document.createElement("div");
  subEl.className = "panel-empty-pulse-sub";
  subEl.textContent = sub;
  el.appendChild(dot);
  el.appendChild(titleEl);
  el.appendChild(subEl);
  el.style.display = "";
}

export function setEmptyRow(el: HTMLElement, text: string): void {
  el.className = "panel-empty-row";
  el.innerHTML = "";
  el.textContent = text;
  el.style.display = "";
}

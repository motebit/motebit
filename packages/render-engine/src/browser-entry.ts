/**
 * Browser-bundle entry point.
 *
 * This file is the input to `scripts/build-browser.mjs`, which produces an
 * IIFE (`dist/browser.iife.js`) that exposes the package's browser-safe
 * surface as a single global: `window.MotebitRE`.
 *
 * The IIFE is consumed by surfaces that need render-engine code INSIDE a
 * WebView string (mobile's `CREATURE_HTML`), where the usual module import
 * path doesn't exist — the script runs in a WKWebView, not in the React
 * Native bundler.
 *
 * Exports here must be browser-safe:
 *   - three (imported by consumer, declared external in the build)
 *   - pure JS / data shapes (expression.ts)
 *   - Three.js renderers (credential-satellites.ts)
 *   - creature geometry/animation (creature.ts) — mobile's WebView uses
 *     this to stop duplicating the creature inline (Stage 2).
 *
 * Do NOT add Node-only imports here. If a new scene primitive has Node
 * dependencies, put them behind a separate entry — don't leak them into
 * the browser bundle.
 */

export * from "./expression.js";
export * from "./credential-satellites.js";
export * from "./creature.js";
export * from "./spec.js";

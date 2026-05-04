/**
 * Node-only entry point for `@motebit/skills`.
 *
 * `fs-adapter.ts` eagerly imports `node:fs` and `node:path`. Re-exporting
 * it from the top-level `index.ts` would force any consumer that imports
 * `@motebit/skills` (even just for `SkillRegistry` or `SkillSelector`)
 * to pull `fs-adapter.ts` into its module graph. In production builds
 * this is fine — bundlers tree-shake unused exports — but in vite's
 * dev mode (and any environment that evaluates ES modules eagerly),
 * the browser sees `node:fs` resolution stubs that throw on property
 * access at module-evaluation time.
 *
 * Splitting the entry point isolates the Node-only surface behind a
 * separate import path: `@motebit/skills/node-fs`. CLI and desktop
 * sidecar consumers route through here; web/mobile/desktop-renderer
 * import from `@motebit/skills` directly without dragging Node fs
 * into the browser bundle.
 *
 * See `packages/skills/CLAUDE.md` rule 4 — the cross-surface adapter
 * pattern requires this split to keep the platform-specific adapters
 * in their respective surface families without pulling browser-hostile
 * imports into the shared registry surface.
 */

export {
  NodeFsSkillStorageAdapter,
  resolveDirectorySkillSource,
  type NodeFsSkillStorageAdapterOptions,
} from "./fs-adapter.js";

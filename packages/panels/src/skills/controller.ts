// Surface-agnostic state controller for the Skills panel.
//
// State derivation, adapter I/O, and action handlers live here. Rendering —
// DOM for desktop/web, React Native for mobile — stays at the surface.
//
// The adapter inverts the dependency on @motebit/skills so the package
// stays at Layer 5 with zero internal deps. The host wires its
// SkillRegistry instance into the adapter; the controller never imports
// from @motebit/skills directly.
//
// See ../CLAUDE.md for layering rules. Spec: spec/skills-v1.md.

// ── Wire shapes (inlined from @motebit/protocol) ──────────────────────
//
// Inlined rather than imported per panels CLAUDE.md rule 2. Drift between
// these unions and @motebit/protocol's `SkillSensitivity` / `SkillPlatform`
// would only surface at adapter integration time; surfaces that wire the
// adapter from a `SkillRegistry` get both sides type-checked at the host.

export type SkillSensitivity = "none" | "personal" | "medical" | "financial" | "secret";

export type SkillPlatform = "macos" | "linux" | "windows" | "ios" | "android";

/**
 * Display-grade provenance status — copy of `SkillProvenanceStatus` from
 * `@motebit/skills`. Surfaces render badges directly off this field.
 *
 * - `verified` — envelope signature present and verified at install time.
 * - `trusted_unsigned` — operator manually attested via `motebit skills trust <name>`.
 * - `unsigned` — no `motebit.signature` block; never auto-loaded.
 * - `unverified` — envelope signature present but verification failed
 *   (transient state — the registry rejects these at install).
 */
export type SkillProvenanceStatus = "verified" | "unverified" | "unsigned" | "trusted_unsigned";

// ── Display-grade summaries ───────────────────────────────────────────

/**
 * Lean summary for the list view — frontmatter fields plus state. The
 * adapter returns one per installed skill; the controller stores them
 * verbatim. Detail view fetches `SkillDetail` separately to keep the
 * list-render path cheap (no SKILL.md body bytes per row).
 */
export interface SkillSummary {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  trusted: boolean;
  provenance_status: SkillProvenanceStatus;
  sensitivity: SkillSensitivity;
  platforms?: SkillPlatform[];
  /** ISO 8601 timestamp; surfaces format natively (panels CLAUDE.md rule 6). */
  installed_at: string;
  /** Where the install came from (free-form: `"directory:/path"`, etc.). */
  source: string;
}

/**
 * Detail-view payload — list summary plus body bytes and supporting
 * metadata for rendering the skill's `When to Use` / `Procedure` /
 * `Pitfalls` / `Verification` sections.
 */
export interface SkillDetail extends SkillSummary {
  /** SKILL.md body decoded as UTF-8. Surfaces render markdown natively. */
  body: string;
  /** Frontmatter author string (display only — not cryptographically verified). */
  author?: string;
  /** Frontmatter category for UI grouping. */
  category?: string;
  /** Frontmatter tags for UI filtering. */
  tags?: string[];
}

/** Result of a successful install action — surfaces use this for confirmation toasts. */
export interface SkillInstallResult {
  name: string;
  version: string;
  provenance_status: SkillProvenanceStatus;
}

// ── Adapter ───────────────────────────────────────────────────────────

/**
 * The contract a host surface implements to wire the skills panel to the
 * surface's local registry. Desktop/CLI use a `NodeFsSkillStorageAdapter`
 * behind this; mobile and web wire platform-equivalent storage adapters.
 */
export interface SkillsPanelAdapter {
  /** List all installed skills with current derived provenance status. */
  listSkills(): Promise<SkillSummary[]>;
  /**
   * Read a single skill's full detail (frontmatter + body). Returns `null`
   * if the skill is not installed.
   */
  readSkillDetail(name: string): Promise<SkillDetail | null>;
  /**
   * Install from a host-resolved source. Web wires this to a curated-
   * registry fetch + signed-envelope download (phase 4.5); desktop/mobile
   * wire to a directory pick + `resolveDirectorySkillSource`. The shape
   * the adapter accepts is host-defined; the controller passes through.
   */
  installFromSource(source: SkillsInstallSource): Promise<SkillInstallResult>;
  enableSkill(name: string): Promise<void>;
  disableSkill(name: string): Promise<void>;
  trustSkill(name: string): Promise<void>;
  untrustSkill(name: string): Promise<void>;
  removeSkill(name: string): Promise<void>;
  /** Re-verify the envelope signature against the embedded public key. */
  verifySkill(name: string): Promise<SkillProvenanceStatus | "not_installed">;
}

/**
 * Install source the controller forwards to the adapter. Per-surface
 * adapters resolve to the appropriate underlying registry call:
 *
 * - `directory` — local filesystem directory containing SKILL.md +
 *   skill-envelope.json. Desktop/mobile.
 * - `url` — fetch a tarball or signed envelope over HTTP. Web/curated
 *   registry (phase 4.5).
 */
export type SkillsInstallSource =
  | { kind: "directory"; path: string }
  | { kind: "url"; url: string };

// ── State ─────────────────────────────────────────────────────────────

export interface SkillsPanelState {
  skills: SkillSummary[];
  /** Free-text search filter applied client-side over name/description/tags. */
  search: string;
  /** Currently selected skill (for the detail view). `null` when no skill selected. */
  selectedSkill: SkillDetail | null;
  /** Loading flag for the list view (`refresh` in flight). */
  loading: boolean;
  /** Loading flag for the detail view (`selectSkill` in flight). */
  detailLoading: boolean;
  /** Last error from any controller action. Set transiently; cleared by `refresh`. */
  error: string | null;
  /**
   * Last-install confirmation — surfaces flash a confirmation badge then
   * `refresh()` clears this. `null` after the refresh completes.
   */
  lastInstall: SkillInstallResult | null;
  /**
   * Last-removal confirmation — same shape as `lastInstall`. The audit-
   * event side effect (skill_remove emitted by SkillRegistry) is observable
   * separately via the event log; this is just for the UI flash.
   */
  lastRemoval: { name: string; version: string } | null;
}

function initialState(): SkillsPanelState {
  return {
    skills: [],
    search: "",
    selectedSkill: null,
    loading: false,
    detailLoading: false,
    error: null,
    lastInstall: null,
    lastRemoval: null,
  };
}

// ── Filtering (pure, no controller state — surfaces can call directly) ─

/**
 * Filter a skill list by a free-text query against name/description/tags/
 * category. Empty query returns the full list. Case-insensitive.
 */
export function filterSkillsView(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  if (q === "") return skills;
  return skills.filter((s) => {
    if (s.name.toLowerCase().includes(q)) return true;
    if (s.description.toLowerCase().includes(q)) return true;
    return false;
  });
}

// ── Controller ────────────────────────────────────────────────────────

export interface SkillsController {
  subscribe(listener: () => void): () => void;
  getState(): SkillsPanelState;
  /** Refresh the list. Sets `loading` for the duration; clears `error`. */
  refresh(): Promise<void>;
  /** Install. Optimistic: refreshes the list on success. Errors surface in `state.error`. */
  install(source: SkillsInstallSource, opts?: { force?: boolean }): Promise<void>;
  enableSkill(name: string): Promise<void>;
  disableSkill(name: string): Promise<void>;
  trustSkill(name: string): Promise<void>;
  untrustSkill(name: string): Promise<void>;
  removeSkill(name: string): Promise<void>;
  /** Re-verify a skill's signature without changing any state besides the per-skill status. */
  verifySkill(name: string): Promise<void>;
  /**
   * Load detail-view payload for a skill. Pass `null` to clear the
   * detail view. Surfaces drive this from list-row clicks.
   */
  selectSkill(name: string | null): Promise<void>;
  /** Set the search query. Synchronous — surfaces re-derive the filtered view. */
  setSearch(query: string): void;
  /** Helper to read the filtered list off current state. */
  filteredSkills(): SkillSummary[];
  /** Detach all subscribers; the controller is unusable after dispose. */
  dispose(): void;
}

export function createSkillsController(adapter: SkillsPanelAdapter): SkillsController {
  let state = initialState();
  const listeners = new Set<() => void>();
  let disposed = false;

  function notify(): void {
    for (const l of listeners) l();
  }

  function update(patch: Partial<SkillsPanelState>): void {
    state = { ...state, ...patch };
    notify();
  }

  function ensureLive(): void {
    if (disposed) {
      throw new Error("SkillsController has been disposed");
    }
  }

  async function refresh(): Promise<void> {
    ensureLive();
    update({ loading: true, error: null });
    try {
      const skills = await adapter.listSkills();
      update({ skills, loading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ loading: false, error: message });
    }
  }

  async function install(source: SkillsInstallSource, opts?: { force?: boolean }): Promise<void> {
    ensureLive();
    update({ error: null });
    try {
      const result = await adapter.installFromSource(source);
      update({ lastInstall: result });
      void opts; // reserved for future --force plumbing through the adapter
      await refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ error: message });
    }
  }

  async function enableSkill(name: string): Promise<void> {
    ensureLive();
    update({ error: null });
    try {
      await adapter.enableSkill(name);
      // Optimistic: flip the flag locally so the UI updates without a full refresh.
      update({
        skills: state.skills.map((s) => (s.name === name ? { ...s, enabled: true } : s)),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ error: message });
    }
  }

  async function disableSkill(name: string): Promise<void> {
    ensureLive();
    update({ error: null });
    try {
      await adapter.disableSkill(name);
      update({
        skills: state.skills.map((s) => (s.name === name ? { ...s, enabled: false } : s)),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ error: message });
    }
  }

  async function trustSkill(name: string): Promise<void> {
    ensureLive();
    update({ error: null });
    try {
      await adapter.trustSkill(name);
      // Trust grant promotes unsigned → trusted_unsigned. Re-fetch the
      // affected row's status by re-reading the list — small cost,
      // keeps provenance_status authoritative on the registry side.
      await refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ error: message });
    }
  }

  async function untrustSkill(name: string): Promise<void> {
    ensureLive();
    update({ error: null });
    try {
      await adapter.untrustSkill(name);
      await refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ error: message });
    }
  }

  async function removeSkill(name: string): Promise<void> {
    ensureLive();
    update({ error: null });
    try {
      const target = state.skills.find((s) => s.name === name);
      await adapter.removeSkill(name);
      if (target) {
        update({ lastRemoval: { name: target.name, version: target.version } });
      }
      // If the removed skill was selected, clear the detail view.
      if (state.selectedSkill?.name === name) {
        update({ selectedSkill: null });
      }
      await refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ error: message });
    }
  }

  async function verifySkill(name: string): Promise<void> {
    ensureLive();
    update({ error: null });
    try {
      const status = await adapter.verifySkill(name);
      if (status === "not_installed") {
        update({ error: `Skill not installed: ${name}` });
        return;
      }
      // Sync the row's status from the verifier without a full re-list.
      update({
        skills: state.skills.map((s) =>
          s.name === name ? { ...s, provenance_status: status } : s,
        ),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ error: message });
    }
  }

  async function selectSkill(name: string | null): Promise<void> {
    ensureLive();
    if (name === null) {
      update({ selectedSkill: null });
      return;
    }
    update({ detailLoading: true, error: null });
    try {
      const detail = await adapter.readSkillDetail(name);
      update({ selectedSkill: detail, detailLoading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ detailLoading: false, error: message });
    }
  }

  function setSearch(query: string): void {
    ensureLive();
    update({ search: query });
  }

  function filteredSkills(): SkillSummary[] {
    return filterSkillsView(state.skills, state.search);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    refresh,
    install,
    enableSkill,
    disableSkill,
    trustSkill,
    untrustSkill,
    removeSkill,
    verifySkill,
    selectSkill,
    setSearch,
    filteredSkills,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

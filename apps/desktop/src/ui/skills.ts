import {
  createSkillsController,
  RegistryBackedSkillsPanelAdapter,
  type RequestInstallConsentFn,
  type SkillBundleShape,
  type SkillDetail,
  type SkillSummary,
  type SkillsPanelAdapter,
  type SkillsPanelState,
} from "@motebit/panels";
import {
  IdbSkillAuditSink,
  IdbSkillStorageAdapter,
  openMotebitDB,
} from "@motebit/browser-persistence";
import { SkillRegistry } from "@motebit/skills";

import { TauriIpcSkillsPanelAdapter } from "../skills-ipc";
import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";

// === DOM Refs ===

const skillsPanel = document.getElementById("skills-panel") as HTMLDivElement;
const skillsBackdrop = document.getElementById("skills-backdrop") as HTMLDivElement;
const skillsList = document.getElementById("skills-list") as HTMLDivElement;
const skillsCount = document.getElementById("skills-count") as HTMLSpanElement;
const skillsSearch = document.getElementById("skills-search") as HTMLInputElement;
const skillsInstallInput = document.getElementById("skills-install-input") as HTMLInputElement;
const skillsInstallBtn = document.getElementById("skills-install-btn") as HTMLButtonElement;
const skillsDetailWrap = document.getElementById("skills-detail-wrap") as HTMLDivElement;
const skillsDetailBody = document.getElementById("skills-detail-body") as HTMLDivElement;
const skillsDetailClose = document.getElementById("skills-detail-close") as HTMLButtonElement;

// === Skills Panel ===

export interface SkillsAPI {
  open(): void;
  close(): void;
}

const PROVENANCE_LABEL: Record<string, string> = {
  verified: "verified",
  trusted_unsigned: "trusted",
  unsigned: "unsigned",
  unverified: "unverified",
};

const SENSITIVITY_LABEL: Record<string, string> = {
  none: "",
  personal: "personal",
  medical: "medical",
  financial: "financial",
  secret: "secret",
};

export function initSkills(ctx: DesktopContext): SkillsAPI {
  // Build a placeholder adapter that defers `invoke` lookup until the
  // first call. The desktop config (and hence `invoke`) isn't ready
  // when this module initializes — `loadDesktopConfig` runs later in
  // bootstrap. Wrapping each call lets us surface a clean "Skills
  // unavailable outside Tauri" error instead of crashing on null.
  const adapter: SkillsPanelAdapter = makeLazyAdapter(ctx);
  const ctrl = createSkillsController(adapter);

  ctrl.subscribe(() => {
    render(ctrl.getState());
  });

  function open(): void {
    skillsPanel.classList.add("open");
    skillsBackdrop.classList.add("open");
    renderDevModeBanner(ctx);
    // Directory installs require the Tauri sidecar's host-fs access;
    // in dev-mode (no Tauri) the path input is dead-on-arrival because
    // the InRendererSkillsPanelAdapter only accepts `kind: "url"`. Hide
    // the install bar entirely in dev mode — there is no `kind: "url"`
    // browse UI on the desktop renderer, so the dev-mode panel is
    // read-only-of-existing-installs by design (operator runs the
    // production Tauri build to install). Keeps the UI honest about
    // what the runtime can do.
    const installBar = document.querySelector<HTMLDivElement>(".skills-install-bar");
    if (installBar !== null) {
      installBar.style.display = isTauriRuntime(ctx) ? "" : "none";
    }
    void ctrl.refresh();
  }

  function close(): void {
    skillsPanel.classList.remove("open");
    skillsBackdrop.classList.remove("open");
    void ctrl.selectSkill(null);
  }

  // === Render ===

  function render(state: SkillsPanelState): void {
    skillsCount.textContent = String(state.skills.length);
    skillsList.innerHTML = "";

    if (state.error !== null && state.skills.length === 0) {
      const banner = document.createElement("div");
      banner.className = "skills-empty";
      banner.textContent = formatErrorForList(state.error);
      skillsList.appendChild(banner);
      return;
    }

    const filtered = ctrl.filteredSkills();
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "skills-empty";
      empty.textContent = state.search.trim() !== "" ? "No matches" : "No skills installed yet";
      skillsList.appendChild(empty);
      return;
    }

    for (const skill of filtered) {
      skillsList.appendChild(renderSkillRow(skill));
    }

    if (state.selectedSkill !== null) {
      renderDetail(state.selectedSkill);
      skillsDetailWrap.style.display = "";
    } else {
      skillsDetailWrap.style.display = "none";
    }
  }

  function renderSkillRow(skill: SkillSummary): HTMLDivElement {
    const item = document.createElement("div");
    item.className = "skill-item" + (skill.enabled ? "" : " skill-disabled");
    item.dataset.skillName = skill.name;

    const header = document.createElement("div");
    header.className = "skill-header";

    const title = document.createElement("span");
    title.className = "skill-name";
    title.textContent = skill.name;
    header.appendChild(title);

    const version = document.createElement("span");
    version.className = "skill-version";
    version.textContent = `v${skill.version}`;
    header.appendChild(version);

    const provenance = document.createElement("span");
    provenance.className = `skill-prov skill-prov-${skill.provenance_status}`;
    provenance.textContent = PROVENANCE_LABEL[skill.provenance_status] ?? skill.provenance_status;
    provenance.title = provenanceHover(skill.provenance_status);
    header.appendChild(provenance);

    const sensitivityLabel = SENSITIVITY_LABEL[skill.sensitivity] ?? "";
    if (sensitivityLabel !== "") {
      const sensitivity = document.createElement("span");
      sensitivity.className = `skill-sens skill-sens-${skill.sensitivity}`;
      sensitivity.textContent = sensitivityLabel;
      header.appendChild(sensitivity);
    }

    item.appendChild(header);

    const description = document.createElement("div");
    description.className = "skill-description";
    description.textContent = skill.description;
    item.appendChild(description);

    const meta = document.createElement("div");
    meta.className = "skill-meta";

    const installedAt = new Date(skill.installed_at).getTime();
    if (Number.isFinite(installedAt)) {
      const time = document.createElement("span");
      time.textContent = formatTimeAgo(installedAt);
      meta.appendChild(time);
    }

    if (skill.platforms !== undefined && skill.platforms.length > 0) {
      const platforms = document.createElement("span");
      platforms.textContent = skill.platforms.join(", ");
      meta.appendChild(platforms);
    }

    item.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "skill-actions";

    const toggle = document.createElement("button");
    toggle.className = "skill-action-btn";
    toggle.textContent = skill.enabled ? "Disable" : "Enable";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      void (skill.enabled ? ctrl.disableSkill(skill.name) : ctrl.enableSkill(skill.name));
    });
    actions.appendChild(toggle);

    // Show the trust toggle for any non-verified skill: unsigned (promote
    // to auto-loadable), unverified (operator-attested override of a
    // tampered-but-known-acceptable skill, e.g. key rotation pending),
    // and trusted_unsigned (revoke a prior grant). Verified skills don't
    // need the toggle — their provenance is cryptographic.
    if (skill.provenance_status !== "verified") {
      const trustBtn = document.createElement("button");
      trustBtn.className = "skill-action-btn";
      trustBtn.textContent = skill.trusted ? "Untrust" : "Trust";
      trustBtn.title = skill.trusted
        ? "Revoke manual trust grant"
        : "Promote unsigned skill to auto-loadable (logged as audit event)";
      trustBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void (skill.trusted ? ctrl.untrustSkill(skill.name) : ctrl.trustSkill(skill.name));
      });
      actions.appendChild(trustBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "skill-action-btn skill-action-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void ctrl.removeSkill(skill.name);
    });
    actions.appendChild(removeBtn);

    item.appendChild(actions);

    item.addEventListener("click", () => {
      void ctrl.selectSkill(skill.name);
    });

    return item;
  }

  function renderDetail(detail: SkillDetail): void {
    skillsDetailBody.innerHTML = "";

    const title = document.createElement("h3");
    title.className = "skill-detail-title";
    title.textContent = `${detail.name} v${detail.version}`;
    skillsDetailBody.appendChild(title);

    if (detail.author !== undefined && detail.author !== "") {
      const author = document.createElement("div");
      author.className = "skill-detail-author";
      author.textContent = `by ${detail.author}`;
      skillsDetailBody.appendChild(author);
    }

    const desc = document.createElement("p");
    desc.className = "skill-detail-description";
    desc.textContent = detail.description;
    skillsDetailBody.appendChild(desc);

    const body = document.createElement("pre");
    body.className = "skill-detail-body";
    // The body is markdown; render as preformatted text for now. The
    // interior markdown renderer (used in chat) lives in @motebit/sdk
    // — wiring it in here is a phase 4.2.x polish, not a 4.2 blocker.
    body.textContent = detail.body;
    skillsDetailBody.appendChild(body);
  }

  // === Install ===

  async function handleInstall(): Promise<void> {
    const path = skillsInstallInput.value.trim();
    if (path === "") {
      ctx.showToast("Paste a directory path containing SKILL.md");
      return;
    }
    skillsInstallBtn.disabled = true;
    try {
      await ctrl.install({ kind: "directory", path });
      const result = ctrl.getState().lastInstall;
      if (result !== null) {
        skillsInstallInput.value = "";
        ctx.showToast(`Installed ${result.name} v${result.version} (${result.provenance_status})`);
      } else {
        const err = ctrl.getState().error;
        const formatted = err !== null ? formatInstallError(err) : "Install failed";
        // Empty = silent path (consent-declined modal closes silently).
        if (formatted !== "") ctx.showToast(formatted);
      }
    } finally {
      skillsInstallBtn.disabled = false;
    }
  }

  // === Listeners ===

  skillsInstallBtn.addEventListener("click", () => {
    void handleInstall();
  });
  skillsInstallInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleInstall();
    }
  });

  let skillsSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  skillsSearch.addEventListener("input", () => {
    if (skillsSearchTimeout) clearTimeout(skillsSearchTimeout);
    skillsSearchTimeout = setTimeout(() => {
      ctrl.setSearch(skillsSearch.value.trim());
    }, 200);
  });

  skillsDetailClose.addEventListener("click", () => {
    void ctrl.selectSkill(null);
  });

  // The HUD-button entry was removed 2026-05-04 — the canonical 3-1-3
  // HUD doesn't include Skills. Settings → Intelligence "Skills" link
  // is the discoverability path now; settings.ts dispatches
  // `motebit:open-skills` when the user clicks it. Custom-event wiring
  // avoids leaking the skills module through every consumer's import
  // graph.
  document.addEventListener("motebit:open-skills", () => open());
  document.getElementById("skills-close-btn")?.addEventListener("click", close);
  skillsBackdrop.addEventListener("click", close);

  return { open, close };
}

// === Helpers ===

/**
 * Resolve to the right adapter at first use:
 *
 *   • Tauri available → `TauriIpcSkillsPanelAdapter` (production path).
 *     Skills install through the Node sidecar; `~/.motebit/skills/`
 *     owns the bytes; the webview never touches envelope material.
 *   • Tauri absent (`vite dev` without the desktop shell) →
 *     `InRendererSkillsPanelAdapter` over IDB-backed `SkillRegistry`.
 *     Same shape web ships; install + verification run in this
 *     renderer context, which is the structurally weaker isolation
 *     boundary documented in `packages/skills/CLAUDE.md` rule 5.
 *
 * The fallback degrades the privilege boundary in dev mode only — the
 * production Tauri path is unchanged. The status banner above the panel
 * surfaces the trade-off so a developer is never confused about why
 * dev-mode skills don't appear in `~/.motebit/skills/` (different
 * storage namespace, by design).
 */
function makeLazyAdapter(ctx: DesktopContext): SkillsPanelAdapter {
  let cached: SkillsPanelAdapter | null = null;

  async function resolve(): Promise<SkillsPanelAdapter> {
    if (cached !== null) return cached;
    const config = ctx.getConfig();
    if (config?.isTauri === true && config.invoke != null) {
      cached = new TauriIpcSkillsPanelAdapter(config.invoke);
      return cached;
    }
    // Dev-mode fallback: IDB-backed registry in the renderer routed
    // through the shared `RegistryBackedSkillsPanelAdapter` from
    // @motebit/panels (same adapter web ships). Sensitive-tier skills
    // route through `showConsentModal` per packages/skills/CLAUDE.md
    // rule 5 — desktop's renderer in dev-mode collapses install +
    // verification + fs-write into one process, same trade-off as web.
    // Audit events (registry-emitted trust/remove + adapter-emitted
    // consent grants) flow through `IdbSkillAuditSink` into the
    // shared IDB `skill_audit` store — durable trail for the dev-mode
    // path. Production Tauri sidecar has its own audit dispatch
    // through the registry's audit option (see src-tauri/sidecar/skills.js).
    const db = await openMotebitDB();
    const auditSink = new IdbSkillAuditSink(db);
    await auditSink.preload();
    const registry = new SkillRegistry(new IdbSkillStorageAdapter(db), {
      audit: auditSink.record,
    });
    cached = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: async (url: string): Promise<SkillBundleShape> => {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) {
          throw new Error(`Relay returned ${resp.status}: ${resp.statusText}`);
        }
        return (await resp.json()) as SkillBundleShape;
      },
      requestInstallConsent: showConsentModal,
      audit: auditSink.record,
      surface: "desktop-dev",
    });
    return cached;
  }

  return {
    listSkills: async () => (await resolve()).listSkills(),
    readSkillDetail: async (name) => (await resolve()).readSkillDetail(name),
    installFromSource: async (source) => (await resolve()).installFromSource(source),
    enableSkill: async (name) => (await resolve()).enableSkill(name),
    disableSkill: async (name) => (await resolve()).disableSkill(name),
    trustSkill: async (name) => (await resolve()).trustSkill(name),
    untrustSkill: async (name) => (await resolve()).untrustSkill(name),
    removeSkill: async (name) => (await resolve()).removeSkill(name),
    verifySkill: async (name) => (await resolve()).verifySkill(name),
  };
}

/**
 * True iff the desktop shell is the Tauri runtime. Used to surface the
 * dev-mode banner (and only the dev-mode banner) at panel open. Reads
 * the same config the lazy adapter routes on, so the banner and the
 * adapter selection can never disagree.
 */
function isTauriRuntime(ctx: DesktopContext): boolean {
  const config = ctx.getConfig();
  return config?.isTauri === true && config.invoke != null;
}

const DEV_MODE_BANNER_ID = "skills-dev-mode-banner";

/**
 * Render (or remove) the dev-mode banner. Idempotent — called on every
 * panel open. The banner sits above the toolbar so it's always visible,
 * never below-the-fold. In production (Tauri running) the banner is
 * removed if it was previously present (defense-in-depth — the Tauri
 * runtime check could in principle change between opens).
 */
function renderDevModeBanner(ctx: DesktopContext): void {
  const existing = document.getElementById(DEV_MODE_BANNER_ID);
  if (isTauriRuntime(ctx)) {
    existing?.remove();
    return;
  }
  if (existing !== null) return;
  const banner = document.createElement("div");
  banner.id = DEV_MODE_BANNER_ID;
  banner.className = "skills-dev-mode-banner";
  banner.textContent =
    "Dev mode — skills stored in browser-private storage (not synced to ~/.motebit/skills). Install via the production Tauri build.";
  const panelHeader = document.querySelector("#skills-panel .skills-panel-header");
  if (panelHeader !== null && panelHeader.parentElement !== null) {
    panelHeader.parentElement.insertBefore(banner, panelHeader.nextSibling);
  }
}

// ── Sensitive-tier install consent modal ─────────────────────────────
//
// Desktop's dev-mode fallback collapses install + verification into the
// renderer (no Tauri sidecar boundary). Sensitive-tier skills
// (medical/financial/secret) route through this consent prompt before
// the registry's install path runs. Markup lives in apps/desktop/index.html;
// this function shows it, attaches one-shot Approve/Cancel handlers,
// and resolves a Promise<boolean> the adapter awaits. Decline is
// silent (calm-software default).
//
// Production Tauri path (TauriIpcSkillsPanelAdapter) does NOT reach
// here — sidecar isolation makes the prompt unnecessary on that path.

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

const showConsentModal: RequestInstallConsentFn = (request) =>
  new Promise<boolean>((resolve) => {
    const modal = document.getElementById("skills-consent-modal") as HTMLDivElement | null;
    const backdrop = document.getElementById("skills-consent-backdrop") as HTMLDivElement | null;
    const titleEl = document.getElementById("skills-consent-title") as HTMLDivElement | null;
    const bodyEl = document.getElementById("skills-consent-body") as HTMLDivElement | null;
    const approveBtn = document.getElementById(
      "skills-consent-approve",
    ) as HTMLButtonElement | null;
    const cancelBtn = document.getElementById("skills-consent-cancel") as HTMLButtonElement | null;
    if (
      modal === null ||
      backdrop === null ||
      titleEl === null ||
      bodyEl === null ||
      approveBtn === null ||
      cancelBtn === null
    ) {
      // Markup missing → fail-closed for sensitive skills.
      resolve(false);
      return;
    }
    titleEl.textContent = `Install ${request.skillName} v${request.skillVersion}?`;
    bodyEl.innerHTML = `
      <p class="skills-consent-tier">This skill declares it works with <strong>${escapeHtml(request.sensitivity)}</strong> data.</p>
      <p class="skills-consent-trade">Dev-mode runs install and verification in the renderer — there is no Tauri sidecar isolation. The selector still blocks auto-load of <strong>${escapeHtml(request.sensitivity)}</strong>-tier skills against external AI providers; bytes will live in browser-private storage on this device.</p>
      <p class="skills-consent-desc">${escapeHtml(request.description)}</p>
    `;
    modal.classList.add("open");
    backdrop.classList.add("open");

    const cleanup = (): void => {
      modal.classList.remove("open");
      backdrop.classList.remove("open");
      approveBtn.removeEventListener("click", onApprove);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeydown);
    };
    const onApprove = (): void => {
      cleanup();
      resolve(true);
    };
    const onCancel = (): void => {
      cleanup();
      resolve(false);
    };
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    approveBtn.addEventListener("click", onApprove);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeydown);
    cancelBtn.focus();
  });

function provenanceHover(status: string): string {
  switch (status) {
    case "verified":
      return "Signed and verified — auto-loadable";
    case "trusted_unsigned":
      return "Operator-attested unsigned skill — auto-loadable, displayed as unverified";
    case "unsigned":
      return "No signature — not auto-loaded; click Trust to promote";
    case "unverified":
      return "Signature failed verification";
    default:
      return status;
  }
}

function formatErrorForList(error: string): string {
  // Translate the IPC reason: prefix into something user-actionable.
  // Format from skills-ipc.ts: "<reason>: <message>".
  const colon = error.indexOf(":");
  if (colon === -1) return error;
  const reason = error.slice(0, colon).trim();
  const message = error.slice(colon + 1).trim();
  if (reason === "sidecar_unavailable") {
    return `Skills unavailable — ${message || "sidecar process could not start"}`;
  }
  if (reason === "protocol_error") {
    return `Skills sidecar protocol error — ${message}`;
  }
  return error;
}

function formatInstallError(error: string): string {
  const colon = error.indexOf(":");
  if (colon === -1) return error;
  const reason = error.slice(0, colon).trim();
  const message = error.slice(colon + 1).trim();
  switch (reason) {
    case "duplicate_name":
      return "Already installed (use force-install for upgrade)";
    case "verification_failed":
      return "Signature verification failed — refusing to install";
    case "size_limit_exceeded":
      return "Skill exceeds size limit";
    case "manifest_envelope_mismatch":
      return "SKILL.md and skill-envelope.json disagree";
    case "malformed_source":
      return `Could not read skill — ${message}`;
    case "consent_declined":
      // Silent path — modal close is the user-visible feedback.
      return "";
    default:
      return message !== "" ? message : error;
  }
}

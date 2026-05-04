/**
 * Skills panel — full lifecycle on web.
 *
 * Two sections:
 *
 *   • **Installed** — IDB-backed registry (`SkillRegistry` over
 *     `IdbSkillStorageAdapter`). Per-row enable/disable + trust/untrust
 *     + remove. Clicking a row opens the local detail (body bytes are
 *     already on disk).
 *
 *   • **Browse** — public-read view of `/api/v1/skills/discover`.
 *     Per-row Install button fetches the byte-identical bundle from
 *     `/api/v1/skills/:submitter/:name/:version` and hands it to the
 *     controller's `installFromSource({ kind: "url" })`. Click opens
 *     the existing detail with copy-command + verify-locally.
 *
 * Privilege boundary: install + envelope-bytes verification run in this
 * same renderer context as the panel UI. There is no sidecar isolation
 * analogue in browsers — the platform sandbox is the only boundary.
 * See `packages/skills/CLAUDE.md` rule 5 for the cross-surface contract.
 *
 * Spec: spec/skills-v1.md, spec/skills-registry-v1.md.
 */

import {
  createSkillsController,
  filterSkillsView,
  type SkillSummary,
  type SkillsController,
} from "@motebit/panels";
import type { SkillRegistryBundle, SkillRegistryEntry, SkillRegistryListing } from "@motebit/sdk";
import { verifySkillBundle, type SkillVerifyResult } from "@motebit/encryption";

import { RegistryBackedSkillsPanelAdapter } from "../skills-adapter";
import type { WebContext } from "../types";
import { DEFAULT_RELAY_URL, loadSyncUrl } from "../storage";

// ---------------------------------------------------------------------------
// Helpers (decode + format)
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function shortSubmitter(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 14)}…${did.slice(-6)}`;
}

function formatTimeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function resolveRelayUrl(): string {
  const configured = loadSyncUrl();
  return (configured ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
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

const SKILLS_ROUTE_PREFIX = "/skills";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SkillsPanelAPI {
  open(): void;
  close(): void;
  /** Open if the current URL points at /skills. Called once at bootstrap. */
  openIfRouted(): void;
}

export function initSkillsPanel(ctx: WebContext): SkillsPanelAPI {
  const panel = document.getElementById("skills-panel") as HTMLDivElement;
  const backdrop = document.getElementById("skills-backdrop") as HTMLDivElement;
  const closeBtn = document.getElementById("skills-close-btn") as HTMLButtonElement;
  const list = document.getElementById("skills-list") as HTMLDivElement;
  const countBadge = document.getElementById("skills-count") as HTMLSpanElement;
  const search = document.getElementById("skills-search") as HTMLInputElement;
  const includeUnfeatured = document.getElementById(
    "skills-include-unfeatured",
  ) as HTMLInputElement;
  const detail = document.getElementById("skills-detail") as HTMLDivElement;
  const detailBody = document.getElementById("skills-detail-body") as HTMLDivElement;
  const detailBack = document.getElementById("skills-detail-back") as HTMLButtonElement;

  // Browse-section state — discover endpoint + search query.
  let browseEntries: SkillRegistryEntry[] = [];
  let searchQuery = "";

  // Installed-section controller — null until the registry is ready
  // (bootstrap may still be in flight on first open). The renderer
  // tolerates null and shows an "unavailable" line.
  let controller: SkillsController | null = null;
  let unsubscribe: (() => void) | null = null;

  function tryAttachController(): SkillsController | null {
    if (controller !== null) return controller;
    const registry = ctx.app.getSkillRegistry();
    if (registry === null) return null;
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: async (url: string) => {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) {
          throw new Error(`Relay returned ${resp.status}: ${resp.statusText}`);
        }
        return (await resp.json()) as SkillRegistryBundle;
      },
    });
    controller = createSkillsController(adapter);
    unsubscribe = controller.subscribe(() => {
      renderAll();
    });
    return controller;
  }

  function open(): void {
    panel.classList.add("open");
    backdrop.classList.add("open");
    if (window.location.pathname !== SKILLS_ROUTE_PREFIX) {
      window.history.pushState({ skills: true }, "", SKILLS_ROUTE_PREFIX);
    }
    void refresh();
  }

  function close(): void {
    panel.classList.remove("open");
    backdrop.classList.remove("open");
    detail.style.display = "none";
    if (window.location.pathname.startsWith(SKILLS_ROUTE_PREFIX)) {
      window.history.pushState({}, "", "/");
    }
  }

  function openIfRouted(): void {
    if (window.location.pathname.startsWith(SKILLS_ROUTE_PREFIX)) {
      open();
    }
  }

  document.addEventListener("motebit:open-skills", () => open());

  // -------------------------------------------------------------------------
  // Refresh — pulls Installed (controller) + Browse (HTTP) in parallel.
  // -------------------------------------------------------------------------

  async function refresh(): Promise<void> {
    list.innerHTML = renderEmpty("Loading…");
    countBadge.textContent = "…";

    const ctrl = tryAttachController();
    const installedTask = ctrl !== null ? ctrl.refresh() : Promise.resolve();
    const browseTask = refreshBrowse();
    await Promise.all([installedTask, browseTask]);
    renderAll();
  }

  async function refreshBrowse(): Promise<void> {
    const url = new URL(`${resolveRelayUrl()}/api/v1/skills/discover`);
    if (includeUnfeatured.checked) url.searchParams.set("include_unfeatured", "true");
    if (searchQuery !== "") url.searchParams.set("q", searchQuery);
    url.searchParams.set("limit", "100");

    let resp: Response;
    try {
      resp = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    } catch {
      browseEntries = [];
      return;
    }
    if (!resp.ok) {
      browseEntries = [];
      return;
    }
    try {
      const listing = (await resp.json()) as SkillRegistryListing;
      browseEntries = listing.entries;
    } catch {
      browseEntries = [];
    }
  }

  // -------------------------------------------------------------------------
  // Render — sections rebuilt from the latest controller state + browse
  // entries. Two-section layout, installed-first.
  // -------------------------------------------------------------------------

  function renderAll(): void {
    const ctrl = controller;
    const installed = ctrl !== null ? filterSkillsView(ctrl.getState().skills, searchQuery) : [];
    const filteredBrowse = filterBrowseView(browseEntries, searchQuery);

    countBadge.textContent = String(installed.length);

    const sections: string[] = [];

    sections.push(`
      <div class="skills-section-header">Installed</div>
      ${
        ctrl === null
          ? renderEmpty("Skills storage is starting up…")
          : installed.length === 0
            ? renderEmpty(
                searchQuery !== ""
                  ? "No installed skills match your search."
                  : "No skills installed yet. Browse and install one below.",
              )
            : `<div class="skills-installed-list">${installed.map(renderInstalledRow).join("")}</div>`
      }
    `);

    sections.push(`
      <div class="skills-section-header">Browse</div>
      ${
        filteredBrowse.length === 0
          ? renderEmpty(
              browseEntries.length === 0
                ? "No published skills on this relay yet."
                : "No browse results match your search.",
            )
          : `<div class="skills-browse-list">${filteredBrowse.map(renderBrowseRow).join("")}</div>`
      }
    `);

    list.innerHTML = sections.join("");
    wireRowHandlers();
  }

  function filterBrowseView(entries: SkillRegistryEntry[], query: string): SkillRegistryEntry[] {
    const q = query.trim().toLowerCase();
    if (q === "") return entries;
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.submitter_motebit_id.toLowerCase().includes(q),
    );
  }

  function renderInstalledRow(skill: SkillSummary): string {
    const provLabel = PROVENANCE_LABEL[skill.provenance_status] ?? skill.provenance_status;
    const sensLabel = SENSITIVITY_LABEL[skill.sensitivity] ?? "";
    const installedAt = new Date(skill.installed_at).getTime();
    const installedRel = Number.isFinite(installedAt) ? formatTimeAgo(installedAt) : "";
    const showTrust = skill.provenance_status !== "verified";
    return `
      <div class="skill-row skill-row-installed${skill.enabled ? "" : " skill-disabled"}"
           data-installed-name="${escapeHtml(skill.name)}">
        <div class="skill-row-header">
          <span class="skill-row-name">${escapeHtml(skill.name)}</span>
          <span class="skill-row-version">v${escapeHtml(skill.version)}</span>
          <span class="skill-prov skill-prov-${escapeHtml(skill.provenance_status)}">${escapeHtml(provLabel)}</span>
          ${sensLabel === "" ? "" : `<span class="skill-sens skill-sens-${escapeHtml(skill.sensitivity)}">${escapeHtml(sensLabel)}</span>`}
        </div>
        <div class="skill-row-description">${escapeHtml(skill.description)}</div>
        <div class="skill-row-meta">
          ${installedRel === "" ? "" : `<span>${escapeHtml(installedRel)}</span>`}
          ${skill.platforms != null && skill.platforms.length > 0 ? `<span>${escapeHtml(skill.platforms.join(", "))}</span>` : ""}
        </div>
        <div class="skill-actions">
          <button class="skill-action-btn" data-action="toggle-enabled">${skill.enabled ? "Disable" : "Enable"}</button>
          ${showTrust ? `<button class="skill-action-btn" data-action="toggle-trusted" title="${skill.trusted ? "Revoke manual trust grant" : "Promote unsigned skill to auto-loadable"}">${skill.trusted ? "Untrust" : "Trust"}</button>` : ""}
          <button class="skill-action-btn skill-action-remove" data-action="remove">Remove</button>
        </div>
      </div>
    `;
  }

  function renderBrowseRow(entry: SkillRegistryEntry): string {
    const featuredBadge = entry.featured
      ? '<span class="skill-prov skill-prov-verified">verified · featured</span>'
      : '<span class="skill-prov skill-prov-verified">verified</span>';
    const sensLabel = SENSITIVITY_LABEL[entry.sensitivity] ?? "";
    return `
      <div class="skill-row skill-row-browse"
           data-submitter="${escapeHtml(entry.submitter_motebit_id)}"
           data-name="${escapeHtml(entry.name)}"
           data-version="${escapeHtml(entry.version)}">
        <div class="skill-row-header">
          <span class="skill-row-name">${escapeHtml(entry.name)}</span>
          <span class="skill-row-version">v${escapeHtml(entry.version)}</span>
          ${featuredBadge}
          ${sensLabel === "" ? "" : `<span class="skill-sens skill-sens-${escapeHtml(entry.sensitivity)}">${escapeHtml(sensLabel)}</span>`}
        </div>
        <div class="skill-row-description">${escapeHtml(entry.description)}</div>
        <div class="skill-row-meta">
          <span>${escapeHtml(shortSubmitter(entry.submitter_motebit_id))}</span>
          <span>${escapeHtml(formatTimeAgo(entry.submitted_at))}</span>
          ${entry.platforms ? `<span>${entry.platforms.map(escapeHtml).join(", ")}</span>` : ""}
        </div>
        <div class="skill-actions">
          <button class="skill-action-btn" data-action="install">Install</button>
        </div>
      </div>
    `;
  }

  function renderEmpty(html: string): string {
    return `<div class="skills-empty">${html}</div>`;
  }

  function wireRowHandlers(): void {
    for (const row of Array.from(list.querySelectorAll<HTMLDivElement>(".skill-row-installed"))) {
      const name = row.dataset.installedName ?? "";
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button") !== null) return;
        void showInstalledDetail(name);
      });
      const buttons = row.querySelectorAll<HTMLButtonElement>("button[data-action]");
      for (const btn of Array.from(buttons)) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          void handleInstalledAction(name, btn.dataset.action ?? "");
        });
      }
    }

    for (const row of Array.from(list.querySelectorAll<HTMLDivElement>(".skill-row-browse"))) {
      const submitter = row.dataset.submitter ?? "";
      const name = row.dataset.name ?? "";
      const version = row.dataset.version ?? "";
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button") !== null) return;
        void showBrowseDetail(submitter, name, version);
      });
      const installBtn = row.querySelector<HTMLButtonElement>('button[data-action="install"]');
      if (installBtn !== null) {
        installBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void handleInstall(submitter, name, version, installBtn);
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Installed-row actions
  // -------------------------------------------------------------------------

  async function handleInstalledAction(name: string, action: string): Promise<void> {
    const ctrl = controller;
    if (ctrl === null) return;
    const skill = ctrl.getState().skills.find((s) => s.name === name);
    if (skill === undefined) return;
    switch (action) {
      case "toggle-enabled":
        await (skill.enabled ? ctrl.disableSkill(name) : ctrl.enableSkill(name));
        ctx.showToast(skill.enabled ? `Disabled ${name}` : `Enabled ${name}`);
        return;
      case "toggle-trusted":
        await (skill.trusted ? ctrl.untrustSkill(name) : ctrl.trustSkill(name));
        ctx.showToast(skill.trusted ? `Trust revoked for ${name}` : `Trust granted to ${name}`);
        return;
      case "remove":
        await ctrl.removeSkill(name);
        ctx.showToast(`Removed ${name}`);
        return;
    }
  }

  async function handleInstall(
    submitter: string,
    name: string,
    version: string,
    btn: HTMLButtonElement,
  ): Promise<void> {
    const ctrl = tryAttachController();
    if (ctrl === null) {
      ctx.showToast("Skills storage unavailable");
      return;
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Installing…";
    const url = `${resolveRelayUrl()}/api/v1/skills/${encodeURIComponent(submitter)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    try {
      await ctrl.install({ kind: "url", url });
      const result = ctrl.getState().lastInstall;
      if (result !== null) {
        ctx.showToast(`Installed ${result.name} v${result.version}`);
      } else {
        const err = ctrl.getState().error;
        ctx.showToast(err !== null ? formatInstallError(err) : "Install failed");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = original ?? "Install";
    }
  }

  // -------------------------------------------------------------------------
  // Detail views — installed (local body) vs. browse (relay bundle).
  // -------------------------------------------------------------------------

  async function showInstalledDetail(name: string): Promise<void> {
    const ctrl = controller;
    if (ctrl === null) return;
    detail.style.display = "flex";
    detailBody.innerHTML = renderEmpty("Loading…");
    await ctrl.selectSkill(name);
    const selected = ctrl.getState().selectedSkill;
    if (selected === null) {
      detailBody.innerHTML = renderEmpty("Skill not found.");
      return;
    }
    detailBody.innerHTML = `
      <h3 class="skills-detail-title">${escapeHtml(selected.name)} <span class="skill-row-version">v${escapeHtml(selected.version)}</span></h3>
      ${selected.author !== undefined && selected.author !== "" ? `<div class="skills-detail-author">by ${escapeHtml(selected.author)}</div>` : ""}
      <p class="skills-detail-description">${escapeHtml(selected.description)}</p>
      <pre class="skills-detail-md">${escapeHtml(selected.body)}</pre>
    `;
  }

  async function showBrowseDetail(submitter: string, name: string, version: string): Promise<void> {
    detail.style.display = "flex";
    detailBody.innerHTML = renderEmpty("Loading…");
    const url = `${resolveRelayUrl()}/api/v1/skills/${encodeURIComponent(submitter)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (err: unknown) {
      detailBody.innerHTML = renderEmpty(
        `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!resp.ok) {
      detailBody.innerHTML = renderEmpty(`Relay returned ${resp.status}: ${resp.statusText}`);
      return;
    }
    let bundle: SkillRegistryBundle;
    try {
      bundle = (await resp.json()) as SkillRegistryBundle;
    } catch {
      detailBody.innerHTML = renderEmpty("Relay returned non-JSON detail.");
      return;
    }
    const body = decodeBody(bundle.body);
    detailBody.innerHTML = `
      <h3 class="skills-detail-title">${escapeHtml(name)} <span class="skill-row-version">v${escapeHtml(version)}</span></h3>
      <div class="skills-detail-author">by ${escapeHtml(shortSubmitter(submitter))}</div>
      <p class="skills-detail-description">${escapeHtml(bundle.envelope.manifest.description)}</p>
      <div class="skills-detail-actions">
        <button class="skill-action-btn" id="skills-detail-install-btn">Install</button>
      </div>
      <div class="skills-verify-block" id="skills-verify-block">
        <button class="skills-verify-btn" id="skills-verify-btn">verify locally</button>
        <span class="skills-verify-hint">re-runs envelope signature + body/file hashes against the bytes the relay just served (no relay trust required)</span>
      </div>
      <div class="skills-verify-result" id="skills-verify-result" style="display:none"></div>
      <pre class="skills-detail-md">${escapeHtml(body)}</pre>
    `;
    const installBtn = document.getElementById(
      "skills-detail-install-btn",
    ) as HTMLButtonElement | null;
    if (installBtn !== null) {
      installBtn.addEventListener("click", () => {
        void handleInstall(submitter, name, version, installBtn);
      });
    }
    wireVerifyButton(bundle);
  }

  function wireVerifyButton(bundle: SkillRegistryBundle): void {
    const verifyBtn = document.getElementById("skills-verify-btn") as HTMLButtonElement | null;
    const verifyResult = document.getElementById("skills-verify-result") as HTMLDivElement | null;
    if (verifyBtn === null || verifyResult === null) return;
    verifyBtn.addEventListener("click", () => {
      verifyBtn.disabled = true;
      verifyBtn.textContent = "verifying…";
      verifyResult.style.display = "block";
      verifyResult.innerHTML = `<div class="skills-verify-pending">running envelope + hash checks in this browser…</div>`;
      const bodyBytes = base64ToBytes(bundle.body);
      const fileBytes: Record<string, Uint8Array> = {};
      for (const [path, b64] of Object.entries(bundle.files ?? {})) {
        try {
          fileBytes[path] = base64ToBytes(b64);
        } catch {
          // missing → verifySkillBundle reports "missing"
        }
      }
      void verifySkillBundle({ envelope: bundle.envelope, body: bodyBytes, files: fileBytes })
        .then((result) => {
          verifyResult.innerHTML = renderVerifyResult(result);
          verifyResult.classList.remove("skills-verify-failed", "skills-verify-passed");
          verifyResult.classList.add(
            result.valid ? "skills-verify-passed" : "skills-verify-failed",
          );
          verifyBtn.textContent = result.valid ? "verified" : "verify failed";
        })
        .catch((err: unknown) => {
          verifyResult.innerHTML = renderEmpty(
            `Verification crashed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
          );
          verifyBtn.textContent = "verify error";
        });
    });
  }

  function renderVerifyResult(result: SkillVerifyResult): string {
    const headerLabel = result.valid
      ? "✓ verified locally"
      : `✗ verification failed${result.errors?.[0] ? ": " + escapeHtml(result.errors[0].message.split("—")[0]?.trim() ?? "") : ""}`;
    const heading = `<div class="skills-verify-heading">${headerLabel}</div>`;
    const envIcon = result.steps.envelope.valid ? "✓" : "✗";
    const envLine = `<div class="skills-verify-step">${envIcon} envelope signature — ${escapeHtml(result.steps.envelope.reason)}</div>`;
    const bodyStep = result.steps.body_hash;
    const bodyLine =
      bodyStep === null
        ? `<div class="skills-verify-step">— body hash not checked</div>`
        : `<div class="skills-verify-step">${bodyStep.valid ? "✓" : "✗"} body hash — sha256 of decoded body ${bodyStep.valid ? "matches" : "differs from"} envelope.body_hash</div>`;
    const fileLines = result.steps.files
      .map((f) => {
        const icon = f.valid ? "✓" : "✗";
        const detail =
          f.reason === "missing"
            ? "envelope declares this file but the bundle didn't ship it"
            : f.valid
              ? "matches"
              : "differs from envelope.files[].hash";
        return `<div class="skills-verify-step">${icon} ${escapeHtml(f.path)} — ${escapeHtml(detail)}</div>`;
      })
      .join("");
    return `${heading}${envLine}${bodyLine}${fileLines}`;
  }

  function decodeBody(b64: string): string {
    try {
      const bytes = base64ToBytes(b64);
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "(could not decode body)";
    }
  }

  function formatInstallError(error: string): string {
    const colon = error.indexOf(":");
    if (colon === -1) return error;
    const reason = error.slice(0, colon).trim();
    const message = error.slice(colon + 1).trim();
    switch (reason) {
      case "duplicate_name":
        return "Already installed";
      case "verification_failed":
        return "Signature verification failed — refusing to install";
      case "size_limit_exceeded":
        return "Skill exceeds size limit";
      case "manifest_envelope_mismatch":
        return "SKILL.md and skill-envelope.json disagree";
      default:
        return message !== "" ? message : error;
    }
  }

  // -------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  detailBack.addEventListener("click", () => {
    detail.style.display = "none";
  });

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = search.value.trim();
      void refresh();
    }, 250);
  });

  includeUnfeatured.addEventListener("change", () => {
    void refresh();
  });

  window.addEventListener("popstate", () => {
    if (!window.location.pathname.startsWith(SKILLS_ROUTE_PREFIX)) {
      panel.classList.remove("open");
      backdrop.classList.remove("open");
      detail.style.display = "none";
    } else {
      panel.classList.add("open");
      backdrop.classList.add("open");
    }
  });

  // Held in scope so `unsubscribe` is reachable for tests / hot-reload
  // teardown if needed. Not currently called externally.
  void unsubscribe;

  return { open, close, openIfRouted };
}

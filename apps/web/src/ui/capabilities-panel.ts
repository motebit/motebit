/**
 * Capabilities panel — capability-primitive surface per
 * `docs/doctrine/panel-temporal-registers.md` (substrate-vs-accumulation).
 * Hosts two sibling sub-tabs:
 *
 *   • **Skills** — agentskills.io procedural-knowledge bundles. Two
 *     sections inside this tab: Installed (IDB-backed registry, per-row
 *     enable/disable + trust + remove) and Browse (relay
 *     `/api/v1/skills/discover`, per-row install). The skills controller
 *     (`createSkillsController`) is untouched by the rename.
 *
 *   • **Connections** — MCP tool servers. HTTP-only on web (stdio is
 *     desktop-only). Per-row Trust / Remove; "Add Server" form for
 *     new connections. Persistence stays at `motebit:mcp_servers`
 *     localStorage; this surface owns the UI, not the storage path.
 *
 * Skills + MCP are siblings, not merged: different shapes, different
 * storage, different lifecycles, different packages. The Capabilities
 * panel hosts both controllers; it does not absorb them.
 *
 * Privilege boundary (Skills): install + envelope-bytes verification run
 * in this same renderer context as the panel UI. There is no sidecar
 * isolation analogue in browsers — the platform sandbox is the only
 * boundary. See `packages/skills/CLAUDE.md` rule 5.
 *
 * Spec: spec/skills-v1.md, spec/skills-registry-v1.md.
 */

import {
  createSkillsController,
  filterSkillsView,
  RegistryBackedSkillsPanelAdapter,
  type RequestInstallConsentFn,
  type SkillBundleShape,
  type SkillSummary,
  type SkillsController,
} from "@motebit/panels";
import type { SkillRegistryBundle, SkillRegistryEntry, SkillRegistryListing } from "@motebit/sdk";
import { verifySkillBundle, type SkillVerifyResult } from "@motebit/encryption";
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

const CAPABILITIES_ROUTE_PREFIX = "/capabilities";

type SubTab = "skills" | "connections";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CapabilitiesPanelAPI {
  open(): void;
  close(): void;
  /** Open if the current URL points at /capabilities. Called once at bootstrap. */
  openIfRouted(): void;
}

export function initCapabilitiesPanel(ctx: WebContext): CapabilitiesPanelAPI {
  const panel = document.getElementById("capabilities-panel") as HTMLDivElement;
  const backdrop = document.getElementById("capabilities-backdrop") as HTMLDivElement;
  const closeBtn = document.getElementById("capabilities-close-btn") as HTMLButtonElement;

  // Sub-tab buttons + panes (Skills active by default).
  const tabBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>(".capabilities-tab"));
  const skillsPane = document.getElementById("cap-pane-skills") as HTMLDivElement;
  const connectionsPane = document.getElementById("cap-pane-connections") as HTMLDivElement;

  // Skills sub-tab DOM (existing).
  const list = document.getElementById("skills-list") as HTMLDivElement;
  const countBadge = document.getElementById("skills-count") as HTMLSpanElement;
  const search = document.getElementById("skills-search") as HTMLInputElement;
  const includeUnfeatured = document.getElementById(
    "skills-include-unfeatured",
  ) as HTMLInputElement;
  const detail = document.getElementById("skills-detail") as HTMLDivElement;
  const detailBody = document.getElementById("skills-detail-body") as HTMLDivElement;
  const detailBack = document.getElementById("skills-detail-back") as HTMLButtonElement;

  // Connections sub-tab DOM — MCP. Each is `null` in test scaffolds that
  // only stub the Skills tab; the connections wiring no-ops cleanly when
  // any element is missing.
  const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement | null;
  const mcpAddToggle = document.getElementById("mcp-add-toggle") as HTMLButtonElement | null;
  const mcpAddForm = document.getElementById("mcp-add-form") as HTMLDivElement | null;
  const mcpAddCancel = document.getElementById("mcp-add-cancel") as HTMLButtonElement | null;
  const mcpAddName = document.getElementById("mcp-add-name") as HTMLInputElement | null;
  const mcpAddUrl = document.getElementById("mcp-add-url") as HTMLInputElement | null;
  const mcpAddTrusted = document.getElementById("mcp-add-trusted") as HTMLInputElement | null;
  const mcpAddMotebit = document.getElementById("mcp-add-motebit") as HTMLInputElement | null;
  const mcpAddBtn = document.getElementById("mcp-add-btn") as HTMLButtonElement | null;
  const mcpEmpty = document.getElementById("mcp-empty") as HTMLDivElement | null;

  // Browse-section state — discover endpoint + search query.
  let browseEntries: SkillRegistryEntry[] = [];
  // Browse-side error message (relay unreachable, non-200, or malformed
  // JSON). Cleared on successful refresh; surfaced as a "could not reach"
  // line in the Browse section so a relay outage is never silent. The
  // Installed section is independent — its errors flow through the
  // controller's `state.error`.
  let browseError: string | null = null;
  let searchQuery = "";

  // Installed-section controller — null until the registry is ready
  // (bootstrap may still be in flight on first open). The renderer
  // tolerates null and shows an "unavailable" line.
  let controller: SkillsController | null = null;
  let unsubscribe: (() => void) | null = null;

  let activeTab: SubTab = "skills";

  function tryAttachController(): SkillsController | null {
    if (controller !== null) return controller;
    const registry = ctx.app.getSkillRegistry();
    if (registry === null) return null;
    const auditSink = ctx.app.getSkillAuditSink();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: async (url: string): Promise<SkillBundleShape> => {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) {
          throw new Error(`Relay returned ${resp.status}: ${resp.statusText}`);
        }
        return (await resp.json()) as SkillRegistryBundle;
      },
      requestInstallConsent: showConsentModal,
      // Same sink the registry's audit option holds — adapter-emitted
      // `skill_consent_granted` and registry-emitted `skill_trust_grant`
      // / `skill_remove` flow into one durable stream.
      audit: auditSink !== null ? auditSink.record : undefined,
      surface: "web",
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
    if (window.location.pathname !== CAPABILITIES_ROUTE_PREFIX) {
      window.history.pushState({ capabilities: true }, "", CAPABILITIES_ROUTE_PREFIX);
    }
    void refresh();
  }

  // Teardown for an in-flight sensitive-skill consent modal. Set while the
  // modal is open (showConsentModal below), cleared when it resolves. The
  // consent modal is a child of THIS panel's install flow — it must never
  // outlive the panel. Without this, closing the panel (close button,
  // backdrop, or browser Back) left the "Install Sensitive Skill?" modal +
  // its full-screen backdrop floating over plain chat with a dangling
  // pending promise (prod #293). Calling it fail-closed DECLINES the
  // pending install (consistent with the fail-closed default for sensitive
  // skills at showConsentModal's markup-missing branch).
  let dismissActiveConsent: (() => void) | null = null;

  function close(): void {
    dismissActiveConsent?.();
    panel.classList.remove("open");
    backdrop.classList.remove("open");
    detail.style.display = "none";
    if (window.location.pathname.startsWith(CAPABILITIES_ROUTE_PREFIX)) {
      window.history.pushState({}, "", "/");
    }
  }

  function openIfRouted(): void {
    if (window.location.pathname.startsWith(CAPABILITIES_ROUTE_PREFIX)) {
      open();
    }
  }

  document.addEventListener("motebit:open-capabilities", () => open());

  // -------------------------------------------------------------------------
  // Sub-tab switching — mirrors the Agents Known/Discover pattern.
  // -------------------------------------------------------------------------

  function switchTab(tab: SubTab): void {
    activeTab = tab;
    for (const btn of tabBtns) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    skillsPane.style.display = tab === "skills" ? "" : "none";
    connectionsPane.style.display = tab === "connections" ? "" : "none";
    if (tab === "skills") {
      void refresh();
    } else {
      renderMcpServers();
    }
  }

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => switchTab((btn.dataset.tab as SubTab) ?? "skills"));
  }

  // -------------------------------------------------------------------------
  // Refresh — pulls Installed (controller) + Browse (HTTP) in parallel.
  // -------------------------------------------------------------------------

  async function refresh(): Promise<void> {
    list.innerHTML = "";
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
    } catch (err: unknown) {
      browseEntries = [];
      browseError = `Could not reach the relay (${resolveRelayUrl()}). ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (!resp.ok) {
      browseEntries = [];
      browseError = `Relay returned ${resp.status}: ${resp.statusText}`;
      return;
    }
    try {
      const listing = (await resp.json()) as SkillRegistryListing;
      browseEntries = listing.entries;
      browseError = null;
    } catch (err: unknown) {
      browseEntries = [];
      browseError = `Relay returned non-JSON: ${err instanceof Error ? err.message : String(err)}`;
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
            ? renderEmpty(searchQuery !== "" ? "No matches" : "Installed skills appear here")
            : `<div class="skills-installed-list">${installed.map(renderInstalledRow).join("")}</div>`
      }
    `);

    sections.push(`
      <div class="skills-section-header">Browse</div>
      ${
        browseError !== null
          ? renderEmpty(escapeHtml(browseError))
          : filteredBrowse.length === 0
            ? renderEmpty(
                browseEntries.length === 0
                  ? "Published skills appear here as the registry grows"
                  : "No matches",
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
        const formatted = err !== null ? formatInstallError(err) : "Install failed";
        // Empty string = silent path (e.g. user-declined consent — modal
        // already closed, no toast needed per calm-software UI rule).
        if (formatted !== "") ctx.showToast(formatted);
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
    detailBody.innerHTML = "";
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
    detailBody.innerHTML = "";
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
      case "consent_declined":
        // Silent path — the modal closed, the user saw the close.
        // Returning an empty string suppresses the toast in the install
        // handler. See SkillConsentDeclined in @motebit/panels.
        return "";
      default:
        return message !== "" ? message : error;
    }
  }

  // -------------------------------------------------------------------------
  // Connections sub-tab — MCP server management. Lifted from settings.ts
  // (commit-1 of the Capabilities migration); persistence path
  // (`motebit:mcp_servers` localStorage) stays put — the UI moved, the
  // storage didn't.
  // -------------------------------------------------------------------------

  function hideMcpForm(): void {
    if (mcpAddForm === null) return;
    mcpAddForm.style.display = "none";
    if (mcpAddName !== null) mcpAddName.value = "";
    if (mcpAddUrl !== null) mcpAddUrl.value = "";
    if (mcpAddTrusted !== null) mcpAddTrusted.checked = false;
    if (mcpAddMotebit !== null) mcpAddMotebit.checked = false;
  }

  function renderMcpServers(): void {
    if (mcpServerList === null) return;
    const servers = ctx.app.getMcpServers();
    mcpServerList.innerHTML = "";
    if (servers.length === 0) {
      if (mcpEmpty !== null) mcpEmpty.style.display = "";
      return;
    }
    if (mcpEmpty !== null) mcpEmpty.style.display = "none";
    for (const server of servers) {
      const item = document.createElement("div");
      item.className = "mcp-server-item";

      const dot = document.createElement("span");
      dot.className = `mcp-server-dot ${server.connected ? "connected" : "disconnected"}`;
      item.appendChild(dot);

      const name = document.createElement("span");
      name.className = "mcp-server-name";
      name.textContent = server.name;
      item.appendChild(name);

      const tools = document.createElement("span");
      tools.className = "mcp-server-tools";
      tools.textContent = `${server.toolCount} tools`;
      item.appendChild(tools);

      const actions = document.createElement("div");
      actions.className = "mcp-server-actions";

      const trustBtn = document.createElement("button");
      trustBtn.textContent = server.trusted ? "Untrust" : "Trust";
      trustBtn.addEventListener("click", () => {
        ctx.app.setMcpServerTrust(server.name, !server.trusted);
        renderMcpServers();
      });
      actions.appendChild(trustBtn);

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        void ctx.app.removeMcpServer(server.name).then(() => renderMcpServers());
      });
      actions.appendChild(removeBtn);

      item.appendChild(actions);
      mcpServerList.appendChild(item);
    }
  }

  if (mcpAddToggle !== null && mcpAddForm !== null) {
    mcpAddToggle.addEventListener("click", () => {
      const opening = mcpAddForm.style.display === "none";
      mcpAddForm.style.display = opening ? "" : "none";
      if (opening && mcpAddName !== null) mcpAddName.focus();
    });
  }
  if (mcpAddCancel !== null) {
    mcpAddCancel.addEventListener("click", hideMcpForm);
  }
  if (mcpAddBtn !== null) {
    mcpAddBtn.addEventListener("click", () => {
      const name = mcpAddName?.value.trim() ?? "";
      const url = mcpAddUrl?.value.trim() ?? "";
      if (!name || !url) {
        ctx.showToast("Name and URL are required");
        return;
      }
      mcpAddBtn.disabled = true;
      mcpAddBtn.textContent = "Connecting...";
      void ctx.app
        .addMcpServer({
          name,
          transport: "http",
          url,
          trusted: mcpAddTrusted?.checked ?? false,
          motebit: mcpAddMotebit?.checked ?? false,
        })
        .then(() => {
          hideMcpForm();
          renderMcpServers();
          ctx.showToast(`Connected to ${name}`);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.showToast(`MCP failed: ${msg}`);
        })
        .finally(() => {
          mcpAddBtn.disabled = false;
          mcpAddBtn.textContent = "Add";
        });
    });
  }

  // -------------------------------------------------------------------------
  // Consent modal — sensitive-tier install (medical / financial / secret).
  // The HTML markup lives in apps/web/index.html; this function shows
  // the modal, attaches one-shot Approve/Cancel handlers, and resolves
  // a Promise<boolean> the adapter awaits before calling registry.install.
  // Returns false on backdrop click, ESC, or Cancel (calm-software default
  // — when in doubt, abort, not install).
  // -------------------------------------------------------------------------

  const consentModal = document.getElementById("skills-consent-modal") as HTMLDivElement | null;
  const consentBackdrop = document.getElementById(
    "skills-consent-backdrop",
  ) as HTMLDivElement | null;
  const consentTitle = document.getElementById("skills-consent-title") as HTMLDivElement | null;
  const consentBody = document.getElementById("skills-consent-body") as HTMLDivElement | null;
  const consentApprove = document.getElementById(
    "skills-consent-approve",
  ) as HTMLButtonElement | null;
  const consentCancel = document.getElementById(
    "skills-consent-cancel",
  ) as HTMLButtonElement | null;

  const showConsentModal: RequestInstallConsentFn = (request) =>
    new Promise<boolean>((resolve) => {
      if (
        consentModal === null ||
        consentBackdrop === null ||
        consentTitle === null ||
        consentBody === null ||
        consentApprove === null ||
        consentCancel === null
      ) {
        // Markup missing — treat as decline (fail-closed for sensitive skills).
        resolve(false);
        return;
      }
      consentTitle.textContent = `Install ${request.skillName} v${request.skillVersion}?`;
      consentBody.innerHTML = `
        <p class="skills-consent-tier">This skill declares it works with <strong>${escapeHtml(request.sensitivity)}</strong> data.</p>
        <p class="skills-consent-trade">On this surface, install and verification run in the same context as the panel UI — the browser sandbox is the only privilege boundary. The selector still blocks auto-load of <strong>${escapeHtml(request.sensitivity)}</strong>-tier skills against external AI providers, but the skill bytes will live in browser-private storage on this device.</p>
        <p class="skills-consent-desc">${escapeHtml(request.description)}</p>
      `;
      consentModal.classList.add("open");
      consentBackdrop.classList.add("open");

      const cleanup = (): void => {
        consentModal.classList.remove("open");
        consentBackdrop.classList.remove("open");
        consentApprove.removeEventListener("click", onApprove);
        consentCancel.removeEventListener("click", onCancel);
        consentBackdrop.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKeydown);
        dismissActiveConsent = null;
      };
      const onApprove = (): void => {
        cleanup();
        resolve(true);
      };
      const onCancel = (): void => {
        cleanup();
        resolve(false);
      };
      // Panel-teardown escape hatch: if the panel closes (button, backdrop,
      // browser Back) while this modal is open, close() / popstate call this
      // to tear the modal down and DECLINE the install fail-closed — the
      // modal can never outlive the flow that owns it.
      dismissActiveConsent = onCancel;
      const onKeydown = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      };
      consentApprove.addEventListener("click", onApprove);
      consentCancel.addEventListener("click", onCancel);
      consentBackdrop.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKeydown);
      // Focus the cancel button by default — calm-software bias toward
      // the safe action; user must take a positive step to install.
      consentCancel.focus();
    });

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
    if (!window.location.pathname.startsWith(CAPABILITIES_ROUTE_PREFIX)) {
      // Browser Back off the panel route — same teardown as close():
      // the in-flight consent modal must not survive the panel.
      dismissActiveConsent?.();
      panel.classList.remove("open");
      backdrop.classList.remove("open");
      detail.style.display = "none";
    } else {
      panel.classList.add("open");
      backdrop.classList.add("open");
    }
  });

  // The controller subscription lives for the lifetime of this panel
  // (one per page load — bootstrap calls `initCapabilitiesPanel` once).
  // No teardown path is exposed because there's no consumer for one
  // today; if the panel ever needs reinitialization (hot-reload, web
  // worker swap, surface tear-down), expose `unsubscribe` on the
  // returned API and call it before re-init.
  void unsubscribe;
  void activeTab;

  return { open, close, openIfRouted };
}

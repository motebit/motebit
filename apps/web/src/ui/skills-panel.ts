/**
 * Skills registry browser — public-read view of `/api/v1/skills/discover`.
 *
 * URL-driven entry: visiting `motebit.com/skills` opens the panel; closing
 * the panel pops back to `/`. No HUD button — the registry is primarily a
 * public-facing browse surface for external visitors. Regular motebit
 * users navigate to `/skills` only when they want to browse.
 *
 * Public-read endpoints — no auth header. The relay's CORS is `*` so
 * the browser fetch works cross-origin without credential scaffolding.
 *
 * Spec: spec/skills-registry-v1.md.
 */

import type { WebContext } from "../types";
import { DEFAULT_RELAY_URL, loadSyncUrl } from "../storage";
import type { SkillRegistryBundle, SkillRegistryEntry, SkillRegistryListing } from "@motebit/sdk";
import { verifySkillBundle, type SkillVerifyResult } from "@motebit/encryption";

/**
 * Decode base64 (URL-safe or standard) to bytes. The relay serves
 * `SkillRegistryBundle` body + files as base64 strings; the canonical
 * `verifySkillBundle` primitive in `@motebit/crypto` accepts raw
 * `Uint8Array`, so the browser does the decode here. Tolerant of both
 * alphabets so callers don't have to normalize.
 */
function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface SkillsPanelAPI {
  open(): void;
  close(): void;
  /** Open if the current URL points at /skills. Called once at bootstrap. */
  openIfRouted(): void;
}

const SENSITIVITY_LABEL: Record<string, string> = {
  none: "",
  personal: "personal",
  medical: "medical",
  financial: "financial",
  secret: "secret",
};

const SKILLS_ROUTE_PREFIX = "/skills";

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function resolveRelayUrl(): string {
  // Prefer the user's configured relay (sync URL) when present so a
  // motebit user browsing on their own relay sees their own catalog.
  // Fall back to the default for visitors who haven't configured one.
  const configured = loadSyncUrl();
  return (configured ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
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

function shortSubmitter(did: string): string {
  // Compact a long `did:key:z6Mk…` to head + tail so the row is readable
  // without losing the unique suffix.
  if (did.length <= 24) return did;
  return `${did.slice(0, 14)}…${did.slice(-6)}`;
}

export function initSkillsPanel(ctx: WebContext): SkillsPanelAPI {
  void ctx; // ctx held for symmetry with other panels; not needed for public-read fetches

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

  let entries: SkillRegistryEntry[] = [];
  let searchQuery = "";
  let listingTotal = 0;

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

  async function refresh(): Promise<void> {
    const url = new URL(`${resolveRelayUrl()}/api/v1/skills/discover`);
    if (includeUnfeatured.checked) {
      url.searchParams.set("include_unfeatured", "true");
    }
    if (searchQuery !== "") {
      url.searchParams.set("q", searchQuery);
    }
    url.searchParams.set("limit", "100");

    list.innerHTML = renderEmpty("Loading…");
    countBadge.textContent = "…";

    let resp: Response;
    try {
      resp = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    } catch (err: unknown) {
      list.innerHTML = renderEmpty(
        `Could not reach the relay (${resolveRelayUrl()}). ${err instanceof Error ? err.message : String(err)}`,
      );
      countBadge.textContent = "0";
      return;
    }

    if (!resp.ok) {
      list.innerHTML = renderEmpty(`Relay returned ${resp.status}: ${resp.statusText}`);
      countBadge.textContent = "0";
      return;
    }

    let listing: SkillRegistryListing;
    try {
      listing = (await resp.json()) as SkillRegistryListing;
    } catch (err: unknown) {
      list.innerHTML = renderEmpty(
        `Relay returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      countBadge.textContent = "0";
      return;
    }

    entries = listing.entries;
    listingTotal = listing.total;
    countBadge.textContent = String(entries.length);
    renderList();
  }

  function renderList(): void {
    if (entries.length === 0) {
      const onPublishHint = `<code>motebit skills publish skills/&lt;name&gt;</code>`;
      const detailHint = includeUnfeatured.checked
        ? "No skills published to this relay yet."
        : "No featured skills yet. Toggle <em>show all</em> to view every submission, or run:";
      list.innerHTML = renderEmpty(
        `${detailHint}${includeUnfeatured.checked ? "" : "<br/>" + onPublishHint}`,
      );
      return;
    }

    const rows = entries.map(renderRow).join("");
    list.innerHTML = rows;

    // Wire click handlers to each row.
    for (const row of Array.from(list.querySelectorAll<HTMLDivElement>(".skill-row"))) {
      const submitter = row.dataset.submitter ?? "";
      const name = row.dataset.name ?? "";
      const version = row.dataset.version ?? "";
      row.addEventListener("click", () => {
        void showDetail(submitter, name, version);
      });
    }
  }

  function renderRow(entry: SkillRegistryEntry): string {
    // Every entry in the registry is signed-and-verified by definition —
    // submission rejects unsigned and verification-failed envelopes
    // (spec/skills-registry-v1.md §6.2). The featured flag is the
    // operator's curation, orthogonal to the cryptographic provenance.
    const featuredBadge = entry.featured
      ? '<span class="skill-prov skill-prov-verified">verified · featured</span>'
      : '<span class="skill-prov skill-prov-verified">verified</span>';
    return `
      <div class="skill-row"
           data-submitter="${escapeHtml(entry.submitter_motebit_id)}"
           data-name="${escapeHtml(entry.name)}"
           data-version="${escapeHtml(entry.version)}">
        <div class="skill-row-header">
          <span class="skill-row-name">${escapeHtml(entry.name)}</span>
          <span class="skill-row-version">v${escapeHtml(entry.version)}</span>
          ${featuredBadge}
          ${renderSensitivityBadge(entry.sensitivity)}
        </div>
        <div class="skill-row-description">${escapeHtml(entry.description)}</div>
        <div class="skill-row-meta">
          <span>${escapeHtml(shortSubmitter(entry.submitter_motebit_id))}</span>
          <span>${escapeHtml(formatTimeAgo(entry.submitted_at))}</span>
          ${entry.platforms ? `<span>${entry.platforms.map(escapeHtml).join(", ")}</span>` : ""}
        </div>
      </div>
    `;
  }

  function renderSensitivityBadge(sensitivity: string): string {
    const label = SENSITIVITY_LABEL[sensitivity] ?? "";
    if (label === "") return "";
    return `<span class="skill-sens skill-sens-${escapeHtml(sensitivity)}">${escapeHtml(label)}</span>`;
  }

  function renderEmpty(html: string): string {
    return `<div class="skills-empty">${html}</div>`;
  }

  /**
   * Render the local-verify checklist. Each step shows ✓ or ✗ — the user
   * can see exactly which axis (signature / body / per-file) passed or
   * failed. The header carries the verdict and the canonical reason
   * shape (e.g. `ed25519_mismatch`) for users who want to dig in.
   *
   * Consumes the canonical `SkillVerifyResult` from `@motebit/crypto`
   * — same shape the CLI's `motebit-verify` JSON output prints, so
   * users debugging across surfaces see identical step semantics.
   */
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

  async function showDetail(submitter: string, name: string, version: string): Promise<void> {
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

    const installAddress = `${submitter}/${name}@${version}`;
    const installCmd = `motebit skills install ${installAddress}`;
    const body = decodeBody(bundle.body);

    detailBody.innerHTML = `
      <h3 class="skills-detail-title">${escapeHtml(name)} <span class="skill-row-version">v${escapeHtml(version)}</span></h3>
      <div class="skills-detail-author">by ${escapeHtml(shortSubmitter(submitter))}</div>
      <p class="skills-detail-description">${escapeHtml(bundle.envelope.manifest.description)}</p>
      <div class="skills-install-block" id="skills-install-block">
        <button class="skills-install-copy" id="skills-install-copy">copy</button>
        ${escapeHtml(installCmd)}
      </div>
      <div class="skills-verify-block" id="skills-verify-block">
        <button class="skills-verify-btn" id="skills-verify-btn">verify locally</button>
        <span class="skills-verify-hint">re-runs envelope signature + body/file hashes against the bytes the relay just served (no relay trust required)</span>
      </div>
      <div class="skills-verify-result" id="skills-verify-result" style="display:none"></div>
      <pre class="skills-detail-md">${escapeHtml(body)}</pre>
    `;

    const copyBtn = document.getElementById("skills-install-copy") as HTMLButtonElement | null;
    if (copyBtn !== null) {
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard
          .writeText(installCmd)
          .then(() => {
            copyBtn.textContent = "copied";
            window.setTimeout(() => {
              copyBtn.textContent = "copy";
            }, 1200);
          })
          .catch(() => {
            copyBtn.textContent = "copy failed";
          });
      });
    }

    // "verify locally" — re-derives every hash and re-runs the envelope
    // signature check using the noble-based primitives in @motebit/crypto.
    // Closes the relay-as-trust-root gap on the most public motebit
    // surface (services/relay/CLAUDE.md rule 6). The relay served these
    // bytes; the user's own browser proves whether they match what the
    // publisher signed.
    const verifyBtn = document.getElementById("skills-verify-btn") as HTMLButtonElement | null;
    const verifyResult = document.getElementById("skills-verify-result") as HTMLDivElement | null;
    if (verifyBtn !== null && verifyResult !== null) {
      verifyBtn.addEventListener("click", () => {
        verifyBtn.disabled = true;
        verifyBtn.textContent = "verifying…";
        verifyResult.style.display = "block";
        verifyResult.innerHTML = `<div class="skills-verify-pending">running envelope + hash checks in this browser…</div>`;
        // Decode base64 bytes and delegate to the canonical
        // verifySkillBundle primitive in @motebit/crypto. Same code
        // path the CLI directory walker runs after reading bytes from
        // disk — single source of truth across surfaces.
        const bodyBytes = base64ToBytes(bundle.body);
        const fileBytes: Record<string, Uint8Array> = {};
        for (const [path, b64] of Object.entries(bundle.files ?? {})) {
          try {
            fileBytes[path] = base64ToBytes(b64);
          } catch {
            // Leave undefined → verifySkillBundle reports "missing".
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
  }

  function decodeBody(b64: string): string {
    try {
      const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        "=",
      );
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "(could not decode body)";
    }
  }

  // === Listeners ===

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

  // Browser back/forward navigation — close the panel if the user
  // navigates away from /skills.
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

  // listingTotal is derived from the discover response and could surface
  // in a future "showing X of N" footer; held for now to avoid losing the
  // value on each render pass.
  void listingTotal;

  return { open, close, openIfRouted };
}

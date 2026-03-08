/**
 * Render a verified motebit identity as a profile card.
 */

import type { MotebitIdentityFile } from "./parse.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateId(id: string): string {
  if (id.length <= 16) return id;
  return id.slice(0, 8) + "..." + id.slice(-4);
}

function fingerprint(pubKeyHex: string): string {
  // Show first 8 and last 8 hex chars as a visual fingerprint
  if (pubKeyHex.length <= 20) return pubKeyHex;
  return pubKeyHex.slice(0, 8) + "..." + pubKeyHex.slice(-8);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function riskLabel(risk: string): string {
  const labels: Record<string, string> = {
    R0_READ: "Read only",
    R1_DRAFT: "Draft / suggest",
    R2_WRITE: "Write / modify",
    R3_EXECUTE: "Execute / run",
    R4_MONEY: "Financial / irreversible",
  };
  return labels[risk] ?? risk;
}

function trustModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    minimal: "Minimal",
    guarded: "Guarded",
    full: "Full",
  };
  return labels[mode] ?? mode;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderProfileCard(
  container: HTMLElement,
  identity: MotebitIdentityFile,
  valid: boolean,
): void {
  const gov = identity.governance;
  const priv = identity.privacy;
  const mem = identity.memory;

  const statusClass = valid ? "status-valid" : "status-invalid";
  const statusIcon = valid ? "&#10003;" : "&#10007;";
  const statusText = valid ? "Signature verified" : "Invalid signature";

  const devicesHtml = identity.devices.length > 0
    ? `<div class="card-section">
        <h3>Devices</h3>
        <div class="devices-list">
          ${identity.devices.map(d => `
            <div class="device-row">
              <span class="device-name">${escapeHtml(d.name)}</span>
              <span class="device-id">${escapeHtml(truncateId(d.device_id))}</span>
            </div>
          `).join("")}
        </div>
      </div>`
    : "";

  const retentionHtml = Object.entries(priv.retention_days)
    .map(([level, days]) => `
      <div class="retention-row">
        <span class="retention-level">${escapeHtml(level)}</span>
        <span class="retention-days">${String(days)}d</span>
      </div>
    `).join("");

  container.innerHTML = `
    <div class="profile-card">
      <div class="card-header">
        <div class="card-header-top">
          <div class="spec-badge">${escapeHtml(identity.spec)}</div>
          <div class="verification-badge ${statusClass}">
            <span class="status-icon">${statusIcon}</span>
            <span>${statusText}</span>
          </div>
        </div>
        <h2 class="motebit-id-display">
          <span class="id-text" title="${escapeHtml(identity.motebit_id)}">${escapeHtml(truncateId(identity.motebit_id))}</span>
          <button class="copy-btn" data-copy="${escapeHtml(identity.motebit_id)}" title="Copy full ID">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </h2>
        <div class="meta-row">
          <span class="meta-label">Public key</span>
          <span class="meta-value mono">${escapeHtml(fingerprint(identity.identity.public_key))}</span>
          <button class="copy-btn copy-btn-small" data-copy="${escapeHtml(identity.identity.public_key)}" title="Copy full public key">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
        <div class="meta-row">
          <span class="meta-label">Created</span>
          <span class="meta-value">${escapeHtml(formatDate(identity.created_at))}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Owner</span>
          <span class="meta-value mono">${escapeHtml(truncateId(identity.owner_id))}</span>
        </div>
      </div>

      <div class="card-section">
        <h3>Governance</h3>
        <div class="governance-grid">
          <div class="gov-item">
            <span class="gov-label">Trust mode</span>
            <span class="gov-value trust-mode-${escapeHtml(gov.trust_mode)}">${escapeHtml(trustModeLabel(gov.trust_mode))}</span>
          </div>
          <div class="gov-item">
            <span class="gov-label">Auto-approve up to</span>
            <span class="gov-value">${escapeHtml(riskLabel(gov.max_risk_auto))}</span>
          </div>
          <div class="gov-item">
            <span class="gov-label">Require approval above</span>
            <span class="gov-value">${escapeHtml(riskLabel(gov.require_approval_above))}</span>
          </div>
          <div class="gov-item">
            <span class="gov-label">Deny above</span>
            <span class="gov-value">${escapeHtml(riskLabel(gov.deny_above))}</span>
          </div>
          <div class="gov-item">
            <span class="gov-label">Operator mode</span>
            <span class="gov-value">${gov.operator_mode ? "Enabled" : "Disabled"}</span>
          </div>
        </div>
      </div>

      <div class="card-section">
        <h3>Privacy</h3>
        <div class="privacy-info">
          <div class="meta-row">
            <span class="meta-label">Default sensitivity</span>
            <span class="meta-value">${escapeHtml(priv.default_sensitivity)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Fail closed</span>
            <span class="meta-value">${priv.fail_closed ? "Yes" : "No"}</span>
          </div>
        </div>
        <div class="retention-grid">
          ${retentionHtml}
        </div>
      </div>

      <div class="card-section">
        <h3>Memory</h3>
        <div class="memory-grid">
          <div class="meta-row">
            <span class="meta-label">Half-life</span>
            <span class="meta-value">${String(mem.half_life_days)} days</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Confidence threshold</span>
            <span class="meta-value">${String(mem.confidence_threshold)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Per-turn limit</span>
            <span class="meta-value">${String(mem.per_turn_limit)}</span>
          </div>
        </div>
      </div>

      ${devicesHtml}
    </div>
  `;

  // Wire copy buttons
  container.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const text = btn.dataset["copy"];
      if (text) {
        void navigator.clipboard.writeText(text).then(() => {
          btn.classList.add("copied");
          setTimeout(() => btn.classList.remove("copied"), 1500);
        });
      }
    });
  });
}

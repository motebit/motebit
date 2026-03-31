import type { DesktopAIConfig, InvokeFn, McpServerConfig, PolicyConfig } from "../index";
import type { NameCollision } from "../mcp-discovery";
import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import { parseJsonSafe, classifyDecision, ipcString } from "./audit-utils";
import { addMessage } from "./chat";
import type { ColorPickerAPI } from "./color-picker";
import type { VoiceAPI } from "./voice";
import type { PairingAPI } from "./pairing";
import { saveFocus, restoreFocus, focusFirst } from "./focus";
import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  OLLAMA_SUGGESTED_MODELS,
  PROXY_MODELS,
} from "@motebit/sdk";

// === DOM Refs ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const settingsProvider = document.getElementById("settings-provider") as HTMLSelectElement;
const settingsModel = document.getElementById("settings-model") as HTMLInputElement;
const settingsModelSelect = document.getElementById("settings-model-select") as HTMLSelectElement;
const settingsModelCustom = document.getElementById("settings-model-custom") as HTMLInputElement;
const settingsApiKey = document.getElementById("settings-apikey") as HTMLInputElement;
const settingsApiKeyToggle = document.getElementById("settings-apikey-toggle") as HTMLButtonElement;
const settingsMaxTokens = document.getElementById("settings-max-tokens") as HTMLSelectElement;
const settingsOperatorMode = document.getElementById("settings-operator-mode") as HTMLInputElement;
const mcpServerList = document.getElementById("mcp-server-list") as HTMLDivElement;
const persistenceThreshold = document.getElementById(
  "settings-persistence-threshold",
) as HTMLInputElement;
const persistenceThresholdValue = document.getElementById(
  "persistence-threshold-value",
) as HTMLSpanElement;
const rejectSecrets = document.getElementById("settings-reject-secrets") as HTMLInputElement;
const maxCalls = document.getElementById("settings-max-calls") as HTMLInputElement;

const settingsWhisperApiKey = document.getElementById(
  "settings-whisper-apikey",
) as HTMLInputElement;
const settingsWhisperApiKeyToggle = document.getElementById(
  "settings-whisper-apikey-toggle",
) as HTMLButtonElement;
const settingsVoiceAutoSend = document.getElementById(
  "settings-voice-autosend",
) as HTMLInputElement;
const settingsVoiceResponse = document.getElementById(
  "settings-voice-response",
) as HTMLInputElement;
const settingsTtsVoice = document.getElementById("settings-tts-voice") as HTMLSelectElement;

// === PIN Dialog DOM Refs ===

const pinBackdrop = document.getElementById("pin-backdrop") as HTMLDivElement;
const pinInput = document.getElementById("pin-input") as HTMLInputElement;
const pinConfirmInput = document.getElementById("pin-confirm-input") as HTMLInputElement;
const pinConfirmText = document.getElementById("pin-confirm-text") as HTMLDivElement;
const pinHint = document.getElementById("pin-hint") as HTMLDivElement;
const pinError = document.getElementById("pin-error") as HTMLDivElement;
const pinTitle = document.getElementById("pin-title") as HTMLDivElement;

// === MCP Add Form DOM Refs ===

const mcpAddToggle = document.getElementById("mcp-add-toggle") as HTMLButtonElement;
const mcpAddForm = document.getElementById("mcp-add-form") as HTMLDivElement;
const mcpTransport = document.getElementById("mcp-transport") as HTMLSelectElement;
const mcpCommandField = document.getElementById("mcp-command-field") as HTMLDivElement;
const mcpUrlField = document.getElementById("mcp-url-field") as HTMLDivElement;
const mcpMotebitCheckbox = document.getElementById("mcp-motebit") as HTMLInputElement;
const mcpPublicKeyField = document.getElementById("mcp-publickey-field") as HTMLDivElement;
const mcpPublicKeyInput = document.getElementById("mcp-publickey") as HTMLInputElement;

// === Settings State ===

let hasApiKeyInKeyring = false;
let hasWhisperKeyInKeyring = false;
let selectedApprovalPreset = "balanced";
let mcpServersConfig: McpServerConfig[] = [];
let discoveryCollisions: NameCollision[] = [];
let pinMode: "setup" | "verify" | "reset" = "verify";

interface PendingSave {
  provider: DesktopAIConfig["provider"];
  model?: string;
  apiKey?: string;
  isTauri: boolean;
}
let pendingSettingsSave: PendingSave | null = null;

// Model lists imported from @motebit/sdk (single source of truth).
// Desktop uses OLLAMA_SUGGESTED_MODELS as its local Ollama dropdown list.
const OLLAMA_MODELS = OLLAMA_SUGGESTED_MODELS as readonly string[];

// === Approval Presets ===

const APPROVAL_PRESET_CONFIGS: Record<string, Partial<PolicyConfig>> = {
  cautious: { maxRiskLevel: 3, requireApprovalAbove: 0, denyAbove: 3 },
  balanced: { maxRiskLevel: 3, requireApprovalAbove: 1, denyAbove: 3 },
  autonomous: { maxRiskLevel: 4, requireApprovalAbove: 3, denyAbove: 4 },
};

// === Settings API ===

export interface SettingsAPI {
  open(): void;
  openToTab(tabName: string): void;
  close(): void;
  updateModelIndicator(): void;
  getHasApiKeyInKeyring(): boolean;
  setHasApiKeyInKeyring(v: boolean): void;
  getHasWhisperKeyInKeyring(): boolean;
  setHasWhisperKeyInKeyring(v: boolean): void;
  getSelectedApprovalPreset(): string;
  setSelectedApprovalPreset(v: string): void;
  getMcpServersConfig(): McpServerConfig[];
  setMcpServersConfig(v: McpServerConfig[]): void;
  setDiscoveryCollisions(v: NameCollision[]): void;
  isPinDialogOpen(): boolean;
  closePinDialog(): void;
  isRotateKeyDialogOpen(): boolean;
  closeRotateKeyDialog(): void;
}

export interface SettingsDeps {
  colorPicker: ColorPickerAPI;
  voice: VoiceAPI;
  pairing: PairingAPI;
  scrollToRunId?: (runId: string) => boolean;
}

export function initSettings(ctx: DesktopContext, deps: SettingsDeps): SettingsAPI {
  const { colorPicker, voice, pairing, scrollToRunId } = deps;
  let pendingRotation = false;

  // === Tab Switching ===

  function switchTab(tabName: string): void {
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      const isActive = (tab as HTMLElement).dataset.tab === tabName;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
    document.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.classList.toggle("active", pane.id === `pane-${tabName}`);
    });
    if (tabName === "identity") populateIdentityTab();
    if (tabName === "governance") populateGovernanceTab();
    if (tabName === "billing") populateBillingTab();
  }

  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = (tab as HTMLElement).dataset.tab;
      if (name != null && name !== "") switchTab(name);
    });
  });

  // === Model Selector ===

  function populateModelSelect(provider: string, currentModel?: string): void {
    settingsModelSelect.innerHTML = "";
    const models: readonly string[] =
      provider === "openai"
        ? OPENAI_MODELS
        : provider === "ollama"
          ? OLLAMA_MODELS
          : provider === "proxy"
            ? PROXY_MODELS
            : ANTHROPIC_MODELS;

    // Show/hide API key field based on provider (hidden for ollama and proxy)
    const apiKeyField = settingsApiKey.closest<HTMLElement>(".settings-field");
    if (apiKeyField != null) {
      apiKeyField.style.display = provider === "ollama" || provider === "proxy" ? "none" : "";
    }

    for (const model of models) {
      const opt = document.createElement("option");
      opt.value = model;
      opt.textContent = model;
      settingsModelSelect.appendChild(opt);
    }

    if (provider === "ollama") {
      const customOpt = document.createElement("option");
      customOpt.value = "__custom__";
      customOpt.textContent = "Custom...";
      settingsModelSelect.appendChild(customOpt);
    }

    // Pre-select current model
    if (currentModel != null && currentModel !== "") {
      const hasModel = models.includes(currentModel);
      if (hasModel) {
        settingsModelSelect.value = currentModel;
        settingsModelCustom.style.display = "none";
      } else if (provider === "ollama") {
        settingsModelSelect.value = "__custom__";
        settingsModelCustom.value = currentModel;
        settingsModelCustom.style.display = "block";
      } else {
        // Anthropic with unknown model — add it as an option
        const opt = document.createElement("option");
        opt.value = currentModel;
        opt.textContent = currentModel;
        settingsModelSelect.insertBefore(opt, settingsModelSelect.firstChild);
        settingsModelSelect.value = currentModel;
        settingsModelCustom.style.display = "none";
      }
    } else {
      settingsModelCustom.style.display = "none";
    }

    syncModelHiddenField();
  }

  function syncModelHiddenField(): void {
    if (settingsModelSelect.value === "__custom__") {
      settingsModel.value = settingsModelCustom.value.trim();
    } else {
      settingsModel.value = settingsModelSelect.value;
    }
  }

  settingsModelSelect.addEventListener("change", () => {
    settingsModelCustom.style.display =
      settingsModelSelect.value === "__custom__" ? "block" : "none";
    if (settingsModelSelect.value === "__custom__") {
      settingsModelCustom.focus();
    }
    syncModelHiddenField();
  });

  settingsModelCustom.addEventListener("input", syncModelHiddenField);

  settingsProvider.addEventListener("change", () => {
    populateModelSelect(settingsProvider.value);
  });

  // === Model Indicator + Provider Status ===

  const modelIndicator = document.getElementById("model-indicator") as HTMLDivElement;
  const providerStatusEl = document.getElementById("provider-status") as HTMLDivElement;
  const providerDot = document.getElementById("provider-status-dot") as HTMLSpanElement;
  const providerText = document.getElementById("provider-status-text") as HTMLSpanElement;

  function updateModelIndicator(): void {
    const model = ctx.app.currentModel;
    const provider = ctx.app.currentProvider;
    modelIndicator.textContent = model ?? "";

    // Update provider status in settings panel
    providerDot.className = "provider-dot";
    if (provider === "ollama" && model) {
      providerStatusEl.style.display = "flex";
      providerDot.classList.add("green");
      providerText.textContent = `Local (Ollama: ${model})`;
    } else if (provider === "anthropic" && model) {
      providerStatusEl.style.display = "flex";
      providerDot.classList.add("blue");
      providerText.textContent = `Cloud (Anthropic: ${model})`;
    } else {
      providerStatusEl.style.display = "flex";
      providerDot.classList.add("yellow");
      providerText.textContent = "No provider configured";
    }
  }

  // === Approval Presets ===

  function selectApprovalPreset(preset: string): void {
    selectedApprovalPreset = preset;
    document.querySelectorAll(".preset-option").forEach((el) => {
      const match = (el as HTMLElement).dataset.preset === preset;
      el.classList.toggle("selected", match);
      const radio: HTMLInputElement | null = el.querySelector("input[type=radio]");
      if (radio != null) radio.checked = match;
    });
  }

  document.querySelectorAll(".preset-option").forEach((el) => {
    el.addEventListener("click", () => {
      const preset = (el as HTMLElement).dataset.preset;
      if (preset != null && preset !== "") selectApprovalPreset(preset);
    });
  });

  persistenceThreshold.addEventListener("input", () => {
    persistenceThresholdValue.textContent = parseFloat(persistenceThreshold.value).toFixed(2);
  });

  // === Identity Tab ===

  function populateIdentityTab(): void {
    const info = ctx.app.getIdentityInfo();
    (document.getElementById("identity-motebit-id") as HTMLElement).textContent =
      info.motebitId || "-";
    (document.getElementById("identity-device-id") as HTMLElement).textContent =
      info.deviceId || "-";
    (document.getElementById("identity-did") as HTMLElement).textContent = info.did || "-";
    (document.getElementById("identity-public-key") as HTMLElement).textContent = info.publicKey
      ? info.publicKey.slice(0, 16) + "..."
      : "-";
    const syncBadge = document.getElementById("identity-sync-status") as HTMLElement;
    const syncState = ctx.app.syncStatus;
    const statusLabels: Record<string, string> = {
      disconnected: "Not connected",
      connecting: "Connecting\u2026",
      connected: "Connected",
      syncing: "Syncing\u2026",
      conflict: "Conflict",
      error: "Error",
    };
    syncBadge.className = `sync-badge ${syncState.status}`;
    syncBadge.textContent = statusLabels[syncState.status] ?? syncState.status;

    // Populate credentials and budget from relay
    void populateCredentialsAndBudget(info.motebitId);
  }

  async function populateCredentialsAndBudget(motebitId: string): Promise<void> {
    const config = ctx.getConfig();
    const syncUrl = config?.syncUrl;
    if (!syncUrl || !motebitId) return;

    const headers: Record<string, string> = {};
    if (config.syncMasterToken) {
      headers["Authorization"] = `Bearer ${config.syncMasterToken}`;
    }

    // Fetch credentials — merge relay + local peer-issued credentials
    try {
      type CredEntry = {
        credential_id: string;
        credential_type: string;
        credential: Record<string, unknown>;
        issued_at: number;
      };

      // Start with locally-persisted peer-issued credentials
      const localCreds = ctx.app.getLocalCredentials();

      // Merge with relay credentials if available
      let relayCreds: CredEntry[] = [];
      try {
        const credRes = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/credentials`, {
          headers,
        });
        if (credRes.ok) {
          const data = (await credRes.json()) as { credentials: CredEntry[] };
          relayCreds = data.credentials ?? [];
        }
      } catch {
        // Relay fetch failed — local credentials still display
      }

      // Deduplicate by issuer + type + timestamp
      const seen = new Set<string>();
      const merged: CredEntry[] = [];
      for (const c of [...localCreds, ...relayCreds].sort((a, b) => b.issued_at - a.issued_at)) {
        const issuerVal = c.credential.issuer;
        const issuerKey = typeof issuerVal === "string" ? issuerVal : "";
        const key = `${issuerKey}:${c.credential_type}:${c.issued_at}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(c);
        }
      }
      const creds = merged;

      // Check revocation status for all credentials via batch endpoint
      const revokedSet = new Set<string>();
      if (creds.length > 0) {
        try {
          const batchRes = await fetch(`${syncUrl}/api/v1/credentials/batch-status`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ credential_ids: creds.map((c) => c.credential_id) }),
          });
          if (batchRes.ok) {
            const batchData = (await batchRes.json()) as {
              results: Array<{ credential_id: string; revoked: boolean }>;
            };
            for (const r of batchData.results) {
              if (r.revoked) revokedSet.add(r.credential_id);
            }
          }
        } catch {
          /* batch check failed — display without revocation status */
        }
      }

      const countEl = document.getElementById("credentials-count") as HTMLElement;
      const revokedCount = revokedSet.size;
      countEl.textContent =
        `${creds.length} credential${creds.length !== 1 ? "s" : ""}` +
        (revokedCount > 0 ? ` (${revokedCount} revoked)` : "");

      // Type badges
      const badgesEl = document.getElementById("credentials-type-badges") as HTMLElement;
      badgesEl.innerHTML = "";
      const typeCounts: Record<string, number> = {};
      for (const c of creds) {
        typeCounts[c.credential_type] = (typeCounts[c.credential_type] ?? 0) + 1;
      }
      const typeColors: Record<string, string> = {
        reputation: "#4caf50",
        trust: "#ff9800",
        gradient: "#2196f3",
        capability: "#9c27b0",
      };
      for (const [type, count] of Object.entries(typeCounts)) {
        const badge = document.createElement("span");
        const color = typeColors[type] ?? "#616161";
        badge.style.cssText = `color:${color};font-size:11px;padding:1px 6px;border-radius:3px;border:1px solid ${color}`;
        badge.textContent = `${type}: ${count}`;
        badgesEl.appendChild(badge);
      }

      // Credential list
      const listEl = document.getElementById("credentials-list") as HTMLElement;
      listEl.innerHTML = "";
      for (const c of creds.slice(0, 20)) {
        const isRevoked = revokedSet.has(c.credential_id);
        const row = document.createElement("div");
        row.style.cssText =
          "font-size:11px;padding:4px 0;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;align-items:center;" +
          (isRevoked ? "opacity:0.5;text-decoration:line-through;" : "");
        const left = document.createElement("span");
        left.textContent = c.credential_id.slice(0, 12) + "...";
        left.style.color = "var(--text-secondary)";
        const right = document.createElement("div");
        right.style.cssText = "display:flex;gap:4px;align-items:center;";
        if (isRevoked) {
          const revBadge = document.createElement("span");
          revBadge.style.cssText = "color:#f44336;font-size:9px;font-weight:600;";
          revBadge.textContent = "REVOKED";
          right.appendChild(revBadge);
        }
        const typeSpan = document.createElement("span");
        const color = typeColors[c.credential_type] ?? "#616161";
        typeSpan.style.cssText = `color:${color};font-size:10px;font-weight:600;`;
        typeSpan.textContent = c.credential_type;
        right.appendChild(typeSpan);
        row.appendChild(left);
        row.appendChild(right);
        listEl.appendChild(row);
      }

      // Enable present button
      const presentBtn = document.getElementById("credentials-present-btn") as HTMLButtonElement;
      presentBtn.disabled = creds.length === 0;
    } catch {
      // Credentials fetch failed — leave defaults
    }

    // Fetch budget
    try {
      const budgetRes = await fetch(`${syncUrl}/agent/${motebitId}/budget`, { headers });
      if (budgetRes.ok) {
        const data = (await budgetRes.json()) as {
          summary: { total_locked: number; total_settled: number };
          allocations: Array<{
            allocation_id: string;
            amount_locked: number;
            status: string;
            created_at: number;
            amount_settled?: number;
            settlement_status?: string;
          }>;
        };
        (document.getElementById("budget-locked") as HTMLElement).textContent = String(
          data.summary.total_locked,
        );
        (document.getElementById("budget-settled") as HTMLElement).textContent = String(
          data.summary.total_settled,
        );

        const budgetListEl = document.getElementById("budget-list") as HTMLElement;
        budgetListEl.innerHTML = "";
        for (const a of (data.allocations ?? []).slice(0, 15)) {
          const row = document.createElement("div");
          row.style.cssText =
            "font-size:11px;padding:3px 0;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;";
          const left = document.createElement("span");
          left.textContent = `${a.allocation_id.slice(0, 8)}... ${a.amount_locked}`;
          left.style.color = "var(--text-secondary)";
          const right = document.createElement("span");
          const settled = a.settlement_status === "settled";
          right.style.color = settled ? "#4caf50" : "#ff9800";
          right.style.fontSize = "10px";
          right.style.fontWeight = "600";
          right.textContent = a.status;
          row.appendChild(left);
          row.appendChild(right);
          budgetListEl.appendChild(row);
        }
      }
    } catch {
      // Budget fetch failed — leave defaults
    }

    // Fetch virtual account balance + recent transactions
    try {
      const balanceRes = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/balance`, { headers });
      if (balanceRes.ok) {
        const data = (await balanceRes.json()) as {
          balance: number;
          currency: string;
          transactions: Array<{
            transaction_id: string;
            type: string;
            amount: number;
            balance_after: number;
            description?: string;
            created_at: number;
          }>;
        };
        (document.getElementById("balance-amount") as HTMLElement).textContent =
          data.balance.toFixed(2);
        (document.getElementById("balance-currency") as HTMLElement).textContent =
          data.currency ?? "USD";

        const txListEl = document.getElementById("balance-transactions") as HTMLElement;
        txListEl.innerHTML = "";
        for (const tx of (data.transactions ?? []).slice(0, 5)) {
          const row = document.createElement("div");
          row.style.cssText =
            "font-size:11px;padding:3px 0;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;align-items:center;";
          const left = document.createElement("span");
          left.style.color = "var(--text-secondary)";
          left.textContent = `${tx.type}${tx.description ? " — " + tx.description : ""}`;
          const right = document.createElement("span");
          const isCredit = tx.amount > 0;
          right.style.cssText = `font-size:10px;font-weight:600;color:${isCredit ? "#4caf50" : "#ef5350"};`;
          right.textContent = `${isCredit ? "+" : ""}${tx.amount.toFixed(2)}`;
          row.appendChild(left);
          row.appendChild(right);
          txListEl.appendChild(row);
        }
      }
    } catch {
      // Balance fetch failed — leave defaults
    }
  }

  // Copy buttons
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = (btn as HTMLElement).dataset.copy;
      if (targetId == null || targetId === "") return;
      const el = document.getElementById(targetId);
      if (el) {
        void navigator.clipboard.writeText(el.textContent || "").then(() => {
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = prev;
          }, 1500);
        });
      }
    });
  });

  // Present Credentials button
  document.getElementById("credentials-present-btn")!.addEventListener("click", () => {
    const config = ctx.getConfig();
    const syncUrl = config?.syncUrl;
    const info = ctx.app.getIdentityInfo();
    if (!syncUrl || !info.motebitId) return;
    const btn = document.getElementById("credentials-present-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Generating...";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.syncMasterToken) {
      headers["Authorization"] = `Bearer ${config.syncMasterToken}`;
    }
    void fetch(`${syncUrl}/api/v1/agents/${info.motebitId}/presentation`, {
      method: "POST",
      headers,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as { presentation: Record<string, unknown> };
        const vpEl = document.getElementById("credentials-vp-result") as HTMLElement;
        vpEl.style.display = "";
        vpEl.textContent = JSON.stringify(data.presentation, null, 2);
      })
      .catch(() => {
        ctx.showToast("Presentation generation failed");
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = "Present Credentials";
      });
  });

  // Export button
  document.getElementById("settings-export")!.addEventListener("click", () => {
    void ctx.app.exportAllData().then((json) => {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `motebit-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // Documentation button
  document.getElementById("settings-docs")!.addEventListener("click", () => {
    window.open("https://docs.motebit.com", "_blank");
  });

  // Export Identity File button
  document.getElementById("settings-export-identity")!.addEventListener("click", () => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content = await ctx.app.exportIdentityFile(invoke as InvokeFn);
        if (content == null || content === "") {
          ctx.showToast("Export failed — keypair not available");
          return;
        }
        const blob = new Blob([content], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "motebit.md";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 250);
      } catch {
        ctx.showToast("Identity export failed");
      }
    })();
  });

  // Verify Identity File button
  document.getElementById("settings-verify-identity")!.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,text/markdown";
    input.addEventListener("change", () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;
        const content = await file.text();
        const result = await ctx.app.verifyIdentityFile(content);
        const el = document.getElementById("verify-result")!;
        el.style.display = "block";
        el.classList.remove("verify-valid", "verify-invalid");
        if (result.valid) {
          el.classList.add("verify-valid");
          el.textContent = "Valid signature — identity verified";
        } else {
          el.classList.add("verify-invalid");
          el.textContent = `Invalid — ${result.error != null && result.error !== "" ? result.error : "signature mismatch"}`;
        }
        setTimeout(() => {
          el.style.display = "none";
        }, 8000);
      })();
    });
    input.click();
  });

  // === Key Rotation ===

  const rotateKeyBackdrop = document.getElementById("rotate-key-backdrop") as HTMLDivElement;
  const rotateKeyReason = document.getElementById("rotate-key-reason") as HTMLInputElement;
  const rotateKeyError = document.getElementById("rotate-key-error") as HTMLDivElement;
  const rotateKeyResult = document.getElementById("rotate-key-result") as HTMLDivElement;
  const rotateKeyConfirm = document.getElementById("rotate-key-confirm") as HTMLButtonElement;

  function showRotateKeyDialog(): void {
    rotateKeyReason.value = "";
    rotateKeyError.textContent = "";
    rotateKeyResult.style.display = "none";
    rotateKeyResult.textContent = "";
    rotateKeyConfirm.disabled = false;
    rotateKeyConfirm.textContent = "Rotate";
    rotateKeyBackdrop.classList.add("open");
    requestAnimationFrame(() => rotateKeyReason.focus());
  }

  function closeRotateKeyDialog(): void {
    rotateKeyBackdrop.classList.remove("open");
  }

  async function handleRotateKeyConfirm(): Promise<void> {
    rotateKeyError.textContent = "";
    rotateKeyConfirm.disabled = true;
    rotateKeyConfirm.textContent = "Rotating\u2026";

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const reason = rotateKeyReason.value.trim() || undefined;
      const result = await ctx.app.rotateKey(invoke as InvokeFn, reason);

      // Show result briefly, then close and update identity display
      rotateKeyResult.style.display = "block";
      rotateKeyResult.textContent = `${result.oldKeyFingerprint}\u2026 \u2192 ${result.newKeyFingerprint}\u2026\nRotation #${result.rotationCount}`;

      // Update identity display with new key
      populateIdentityTab();

      setTimeout(() => {
        closeRotateKeyDialog();
      }, 2000);
    } catch (err: unknown) {
      rotateKeyError.textContent = err instanceof Error ? err.message : String(err);
      rotateKeyConfirm.disabled = false;
      rotateKeyConfirm.textContent = "Rotate";
    }
  }

  document.getElementById("settings-rotate-key")!.addEventListener("click", () => {
    const config = ctx.getConfig();
    if (config?.isTauri !== true || config.invoke == null) {
      addMessage("system", "Key rotation requires Tauri (not available in dev mode)");
      return;
    }

    // If operator mode is enabled, require PIN verification first
    if (ctx.app.isOperatorMode) {
      pendingRotation = true;
      showPinDialog("verify");
      return;
    }

    showRotateKeyDialog();
  });

  document.getElementById("rotate-key-cancel")!.addEventListener("click", closeRotateKeyDialog);
  document.getElementById("rotate-key-confirm")!.addEventListener("click", () => {
    void handleRotateKeyConfirm();
  });
  rotateKeyReason.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handleRotateKeyConfirm();
    if (e.key === "Escape") closeRotateKeyDialog();
  });

  // === Governance Audit Activity ===

  function buildAuditRow(entry: Record<string, unknown>): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "audit-row";

    const header = document.createElement("div");
    header.className = "audit-row-header";

    const toolName = document.createElement("span");
    toolName.className = "audit-tool-name";
    toolName.textContent = ipcString(entry.tool, "unknown");
    header.appendChild(toolName);

    const badgeClass = classifyDecision(entry.decision);
    const badge = document.createElement("span");
    badge.className = `audit-decision-badge ${badgeClass}`;
    badge.textContent = badgeClass;
    header.appendChild(badge);

    // Injection indicator
    const injData = parseJsonSafe(entry.injection) as Record<string, unknown> | null;
    if (injData != null && injData.detected === true) {
      const injBadge = document.createElement("span");
      injBadge.className = "audit-decision-badge denied";
      injBadge.textContent = "injection";
      header.appendChild(injBadge);
    }

    const time = document.createElement("span");
    time.className = "audit-time";
    time.textContent = formatTimeAgo(Number(entry.timestamp) || 0);
    header.appendChild(time);

    row.appendChild(header);

    // Expandable detail
    const detail = document.createElement("div");
    detail.className = "audit-row-detail";

    const argsStr = typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args ?? "");
    const truncArgs = argsStr.length > 200 ? argsStr.slice(0, 200) + "..." : argsStr;
    const argsDiv = document.createElement("div");
    argsDiv.className = "audit-detail-args";
    argsDiv.textContent = truncArgs;
    detail.appendChild(argsDiv);

    const resultData = parseJsonSafe(entry.result) as Record<string, unknown> | null;
    const resultDiv = document.createElement("div");
    resultDiv.className = "audit-detail-result";
    if (resultData != null && typeof resultData === "object") {
      const ok =
        resultData.ok !== undefined
          ? ipcString(resultData.ok)
          : resultData.error != null
            ? "failed"
            : "ok";
      const dur = resultData.durationMs != null ? `${ipcString(resultData.durationMs)}ms` : "";
      resultDiv.textContent = [ok, dur].filter((s) => s !== "").join(" · ");
    } else {
      resultDiv.textContent = ipcString(entry.result);
    }
    if (resultDiv.textContent) detail.appendChild(resultDiv);

    const copyBtn = document.createElement("button");
    copyBtn.className = "audit-copy-btn";
    copyBtn.textContent = "Copy JSON";
    const entryJson = JSON.stringify(entry, null, 2);
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(entryJson).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          copyBtn.textContent = "Copy JSON";
        }, 1500);
      });
    });
    detail.appendChild(copyBtn);

    row.appendChild(detail);
    row.addEventListener("click", () => {
      row.classList.toggle("expanded");
    });
    return row;
  }

  // === Billing Tab ===

  const LOW_BALANCE_THRESHOLD = 5;
  const TOPUP_AMOUNTS = [5, 10, 25];

  function populateBillingTab(): void {
    const balanceEl = document.getElementById("billing-balance");
    const statusEl = document.getElementById("billing-status");
    const topupEl = document.getElementById("billing-topup");
    const topupBtnsEl = document.getElementById("billing-topup-buttons");
    const actionsEl = document.getElementById("billing-actions");
    const messageEl = document.getElementById("billing-message");
    if (!balanceEl || !actionsEl) return;

    const syncUrl = ctx.app.getSyncUrl();
    const motebitId = ctx.app.motebitId;
    if (!syncUrl || !motebitId) {
      balanceEl.textContent = "";
      if (statusEl)
        statusEl.textContent = "Connect to a relay in Identity settings to manage billing.";
      return;
    }

    balanceEl.textContent = "Loading…";

    void fetch(`${syncUrl}/api/v1/subscriptions/${motebitId}/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            subscribed?: boolean;
            subscription_status?: string;
            balance_usd?: number;
            active_until?: number;
          } | null,
        ) => {
          if (!data) {
            balanceEl.textContent = "";
            if (statusEl) statusEl.textContent = "Could not reach relay";
            return;
          }

          const balanceUsd = data.balance_usd ?? 0;
          balanceEl.textContent = `$${balanceUsd.toFixed(2)} remaining`;

          const isSubscribed = data.subscribed === true;

          if (isSubscribed) {
            // Show top-up when balance is low
            if (topupEl && topupBtnsEl && balanceUsd < LOW_BALANCE_THRESHOLD) {
              topupEl.style.display = "";
              topupBtnsEl.innerHTML = "";
              for (const amt of TOPUP_AMOUNTS) {
                const btn = document.createElement("button");
                btn.style.cssText =
                  "padding:5px 14px;border:1px solid var(--border-light);border-radius:6px;background:transparent;color:var(--text-heading);font-size:12px;cursor:pointer;font-family:inherit;";
                btn.textContent = `+$${amt}`;
                btn.addEventListener("click", () => void openDesktopTopup(syncUrl, motebitId, amt));
                topupBtnsEl.appendChild(btn);
              }
            } else if (topupEl) {
              topupEl.style.display = "none";
            }

            if (data.subscription_status === "cancelling") {
              const until =
                data.active_until != null
                  ? ` on ${new Date(data.active_until).toLocaleDateString()}`
                  : "";
              if (statusEl)
                statusEl.textContent = `Plan cancels${until}. Credits remain until used.`;
              actionsEl.innerHTML =
                '<button id="billing-resubscribe" style="padding:6px 20px;border:1px solid var(--text-heading);border-radius:6px;background:transparent;color:var(--text-heading);cursor:pointer;font-size:13px;font-family:inherit;">Resubscribe</button>';
              document.getElementById("billing-resubscribe")?.addEventListener("click", () => {
                void fetch(`${syncUrl}/api/v1/subscriptions/${motebitId}/resubscribe`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                }).then((res) => {
                  if (res.ok) {
                    addMessage("system", "Plan resumed");
                    populateBillingTab();
                  } else {
                    if (messageEl) messageEl.textContent = "Failed to resume";
                  }
                });
              });
            } else {
              if (statusEl) statusEl.textContent = "Motebit Cloud active";
              actionsEl.innerHTML =
                '<a href="#" id="billing-cancel" style="font-size:11px;color:var(--text-muted);opacity:0.5;text-decoration:none;cursor:pointer;">Cancel plan</a>';
              document.getElementById("billing-cancel")?.addEventListener("click", (e) => {
                e.preventDefault();
                void fetch(`${syncUrl}/api/v1/subscriptions/${motebitId}/cancel`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                }).then((res) => {
                  if (res.ok) {
                    addMessage("system", "Plan cancelled — credits remain until used");
                    populateBillingTab();
                  } else {
                    if (messageEl) messageEl.textContent = "Cancel failed";
                  }
                });
              });
            }
          } else {
            // Not subscribed
            if (statusEl) statusEl.textContent = "";
            if (topupEl) topupEl.style.display = "none";
            actionsEl.innerHTML =
              '<button id="billing-subscribe" style="padding:10px 24px;border:1px solid var(--accent-border,rgba(120,100,255,0.3));border-radius:10px;background:var(--accent-bg,rgba(120,100,255,0.08));color:var(--text-heading);font-size:14px;cursor:pointer;font-family:inherit;">Subscribe — $20/mo</button>';
            document.getElementById("billing-subscribe")?.addEventListener("click", () => {
              void openDesktopCheckout(syncUrl, motebitId);
            });
          }
        },
      )
      .catch(() => {
        balanceEl.textContent = "";
        if (statusEl) statusEl.textContent = "Could not reach relay";
      });
  }

  async function openDesktopCheckout(syncUrl: string, motebitId: string): Promise<void> {
    const messageEl = document.getElementById("billing-message");
    const btn = document.getElementById("billing-subscribe") as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Opening checkout…";
    }
    try {
      const res = await fetch(`${syncUrl}/api/v1/subscriptions/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motebit_id: motebitId }),
      });
      const data = (await res.json()) as { checkout_url?: string; error?: string };
      if (data.checkout_url) {
        window.open(data.checkout_url, "_blank");
        if (messageEl)
          messageEl.textContent = "Complete payment in browser — balance updates automatically";
      } else {
        if (messageEl) messageEl.textContent = data.error ?? "Checkout failed";
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Subscribe — $20/mo";
        }
      }
    } catch {
      if (messageEl) messageEl.textContent = "Network error — try again";
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Subscribe — $20/mo";
      }
    }
  }

  async function openDesktopTopup(
    syncUrl: string,
    motebitId: string,
    amount: number,
  ): Promise<void> {
    const messageEl = document.getElementById("billing-message");
    if (messageEl) messageEl.textContent = "Opening checkout…";
    try {
      const res = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      const data = (await res.json()) as { checkout_url?: string; error?: string };
      if (data.checkout_url) {
        window.open(data.checkout_url, "_blank");
        if (messageEl) messageEl.textContent = "Complete payment in browser";
      } else {
        if (messageEl) messageEl.textContent = data.error ?? "Checkout failed";
      }
    } catch {
      if (messageEl) messageEl.textContent = "Network error";
    }
  }

  function populateGovernanceTab(): void {
    const config = ctx.getConfig();
    if (config?.isTauri !== true || config.invoke == null) return;
    const invoke = config.invoke;
    const listEl = document.getElementById("audit-activity-list")!;
    const emptyEl = document.getElementById("audit-activity-empty")!;

    listEl.innerHTML = "";
    emptyEl.style.display = "none";

    void invoke<Array<Record<string, unknown>>>("db_query", {
      sql: `SELECT call_id, run_id, tool, args, decision, result, injection, timestamp FROM tool_audit_log ORDER BY timestamp DESC LIMIT 50`,
      params: [],
    })
      .then((entries: Array<Record<string, unknown>>) => {
        if (entries.length === 0) {
          emptyEl.style.display = "block";
          return;
        }

        // Group by run_id, preserving order of first appearance
        const groups: Array<{ runId: string | null; entries: Array<Record<string, unknown>> }> = [];
        const runIndex = new Map<string, number>();

        for (const entry of entries) {
          const rid = entry.run_id != null ? ipcString(entry.run_id) : null;
          if (rid != null && rid !== "" && runIndex.has(rid)) {
            groups[runIndex.get(rid)!]!.entries.push(entry);
          } else {
            if (rid != null && rid !== "") runIndex.set(rid, groups.length);
            groups.push({ runId: rid, entries: [entry] });
          }
        }

        // Separate grouped runs from legacy (no run_id)
        const runGroups = groups.filter((g) => g.runId != null && g.runId !== "");
        const legacyEntries = groups
          .filter((g) => g.runId == null || g.runId === "")
          .flatMap((g) => g.entries);

        for (const group of runGroups) {
          const groupEl = document.createElement("div");
          groupEl.className = "audit-run-group";
          // Auto-expand the first (most recent) group
          if (listEl.children.length === 0) groupEl.classList.add("expanded");

          const header = document.createElement("div");
          header.className = "audit-run-header";

          const idSpan = document.createElement("span");
          idSpan.className = "audit-run-id";
          idSpan.textContent = `run:${group.runId!.slice(0, 8)}`;
          header.appendChild(idSpan);

          // Decision summary badges + semantic label
          const stats = document.createElement("span");
          stats.className = "audit-run-stats";

          let denied = 0,
            approval = 0;
          for (const e of group.entries) {
            const c = classifyDecision(e.decision);
            if (c === "denied") denied++;
            else if (c === "approval") approval++;
          }

          // Semantic trust badge — only surface when something noteworthy happened
          if (denied > 0) {
            const tb = document.createElement("span");
            tb.className = "audit-decision-badge denied";
            tb.textContent = "denied";
            stats.appendChild(tb);
          } else if (approval > 0) {
            const tb = document.createElement("span");
            tb.className = "audit-decision-badge approval";
            tb.textContent = "approval";
            stats.appendChild(tb);
          }

          const countSpan = document.createElement("span");
          countSpan.className = "audit-run-count";
          countSpan.textContent = `${group.entries.length} tool${group.entries.length !== 1 ? "s" : ""}`;
          stats.appendChild(countSpan);

          // Query token count for this run from goal_outcomes (async, fills in when ready)
          void invoke<Array<{ tokens_used: number | null }>>("db_query", {
            sql: "SELECT tokens_used FROM goal_outcomes WHERE outcome_id = ?",
            params: [group.runId],
          })
            .then((rows) => {
              const tokens = rows?.[0]?.tokens_used;
              if (tokens != null && tokens > 0) {
                const tokenSpan = document.createElement("span");
                tokenSpan.className = "audit-run-tokens";
                tokenSpan.textContent = `${tokens.toLocaleString()} tok`;
                stats.appendChild(tokenSpan);
              }
            })
            .catch(() => {});

          header.appendChild(stats);

          // Time — use earliest entry (entries are DESC, so last in array)
          const earliest = group.entries[group.entries.length - 1]!;
          const timeSpan = document.createElement("span");
          timeSpan.className = "audit-run-time";
          timeSpan.textContent = formatTimeAgo(Number(earliest.timestamp) || 0);
          header.appendChild(timeSpan);

          // "View" link — only if the bubble exists in current session
          if (scrollToRunId) {
            const viewLink = document.createElement("span");
            viewLink.className = "audit-run-view";
            viewLink.textContent = "View";
            viewLink.addEventListener("click", (e) => {
              e.stopPropagation();
              const found = scrollToRunId(group.runId!);
              if (!found) {
                viewLink.textContent = "not in session";
                setTimeout(() => {
                  viewLink.textContent = "View";
                }, 1500);
              }
            });
            header.appendChild(viewLink);
          }

          groupEl.appendChild(header);
          header.addEventListener("click", () => {
            groupEl.classList.toggle("expanded");
          });

          // Body — individual tool rows (chronological: oldest first)
          const body = document.createElement("div");
          body.className = "audit-run-body";
          const sorted = [...group.entries].reverse();
          for (const entry of sorted) {
            body.appendChild(buildAuditRow(entry));
          }
          groupEl.appendChild(body);

          listEl.appendChild(groupEl);
        }

        // Legacy entries — collapsed section at the bottom
        if (legacyEntries.length > 0) {
          const legacyGroup = document.createElement("div");
          legacyGroup.className = "audit-run-group";

          const legacyHeader = document.createElement("div");
          legacyHeader.className = "audit-run-header";
          const legacyLabel = document.createElement("span");
          legacyLabel.className = "audit-run-id";
          legacyLabel.textContent = "Older activity";
          legacyHeader.appendChild(legacyLabel);

          const legacyCount = document.createElement("span");
          legacyCount.className = "audit-run-count";
          legacyCount.style.marginLeft = "auto";
          legacyCount.textContent = `${legacyEntries.length} tool${legacyEntries.length !== 1 ? "s" : ""}`;
          legacyHeader.appendChild(legacyCount);

          legacyGroup.appendChild(legacyHeader);
          legacyHeader.addEventListener("click", () => {
            legacyGroup.classList.toggle("expanded");
          });

          const legacyBody = document.createElement("div");
          legacyBody.className = "audit-run-body";
          for (const entry of legacyEntries) {
            legacyBody.appendChild(buildAuditRow(entry));
          }
          legacyGroup.appendChild(legacyBody);

          listEl.appendChild(legacyGroup);
        }
      })
      .catch(() => {
        emptyEl.style.display = "block";
      });
  }

  // === MCP Server List ===

  function renderMcpServerList(): void {
    mcpServerList.innerHTML = "";
    const servers = ctx.app.getMcpStatus();
    if (mcpServersConfig.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:12px;color:rgba(255,255,255,0.3);padding:8px 0;";
      empty.textContent = "No MCP servers configured";
      mcpServerList.appendChild(empty);
      return;
    }
    for (const config of mcpServersConfig) {
      const status = servers.find((s) => s.name === config.name);
      const row = document.createElement("div");
      row.className = "mcp-server-row";

      const nameSpan = document.createElement("span");
      nameSpan.className = "mcp-server-name";
      nameSpan.textContent = config.name;
      row.appendChild(nameSpan);

      const transportBadge = document.createElement("span");
      transportBadge.className = "mcp-badge";
      transportBadge.textContent = config.transport;
      row.appendChild(transportBadge);

      if (config.source != null && config.source !== "") {
        const discoveredBadge = document.createElement("span");
        discoveredBadge.className = "mcp-badge discovered";
        discoveredBadge.textContent = "discovered";
        discoveredBadge.title = config.source;
        row.appendChild(discoveredBadge);
      }

      if (config.trusted === true) {
        const trustedBadge = document.createElement("span");
        trustedBadge.className = "mcp-badge trusted";
        trustedBadge.textContent = "trusted";
        row.appendChild(trustedBadge);
      }

      if (config.motebit === true) {
        const motebitBadge = document.createElement("span");
        motebitBadge.className = "mcp-badge motebit";
        motebitBadge.textContent = "motebit";
        if (config.motebitPublicKey) {
          motebitBadge.title = `Key: ${config.motebitPublicKey}`;
        }
        row.appendChild(motebitBadge);
      }

      const collision = discoveryCollisions.find((c) => c.name === config.name);
      if (collision) {
        const warnBadge = document.createElement("span");
        warnBadge.className = "mcp-badge collision";
        warnBadge.textContent = "collision";
        warnBadge.title = `Discovered different config from ${collision.discoveredSource} (${collision.discoveredCommand})`;
        row.appendChild(warnBadge);
      }

      const statusDot = document.createElement("span");
      statusDot.className = "mcp-status-dot" + (status?.connected === true ? " connected" : "");
      row.appendChild(statusDot);

      // Connect button for disconnected servers
      if (status?.connected !== true) {
        const connectBtn = document.createElement("button");
        connectBtn.className = "mcp-connect-btn";
        connectBtn.textContent = "Connect";
        connectBtn.addEventListener("click", () => {
          const appConfig = ctx.getConfig();
          if (appConfig?.invoke == null) return;
          const inv = appConfig.invoke;
          config.spawnApproved = true;
          // Persist spawnApproved so we don't re-prompt after restart
          void inv<string>("read_config")
            .then((raw) => {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              parsed.mcp_servers = mcpServersConfig;
              return inv("write_config", { json: JSON.stringify(parsed) });
            })
            .catch(() => {
              /* non-fatal */
            });
          void ctx.app
            .connectMcpServerViaTauri(config, inv)
            .then((status) => {
              if (status.manifestChanged === true) {
                const diff = status.manifestDiff;
                const parts = [`${config.name}: tools changed — trust revoked`];
                if (diff) {
                  if (diff.added.length) parts.push(`+${diff.added.length} added`);
                  if (diff.removed.length) parts.push(`-${diff.removed.length} removed`);
                }
                ctx.showToast(parts.join(", "));
              }
              // Persist updated manifest hash
              void inv<string>("read_config")
                .then((raw) => {
                  const parsed = JSON.parse(raw) as Record<string, unknown>;
                  parsed.mcp_servers = mcpServersConfig;
                  return inv("write_config", { json: JSON.stringify(parsed) });
                })
                .catch(() => {
                  /* non-fatal */
                });
              renderMcpServerList();
            })
            .catch(() => {
              renderMcpServerList();
            });
        });
        row.appendChild(connectBtn);
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "mcp-remove-btn";
      removeBtn.textContent = "\u00d7";
      removeBtn.addEventListener("click", () => {
        mcpServersConfig = mcpServersConfig.filter((s) => s.name !== config.name);
        void ctx.app.removeMcpServer(config.name);
        renderMcpServerList();
      });
      row.appendChild(removeBtn);
      mcpServerList.appendChild(row);
    }
  }

  // MCP add form
  mcpAddToggle.addEventListener("click", () => {
    mcpAddForm.style.display = mcpAddForm.style.display === "none" ? "block" : "none";
  });

  mcpTransport.addEventListener("change", () => {
    mcpCommandField.style.display = mcpTransport.value === "stdio" ? "flex" : "none";
    mcpUrlField.style.display = mcpTransport.value === "http" ? "flex" : "none";
  });

  mcpMotebitCheckbox.addEventListener("change", () => {
    mcpPublicKeyField.style.display =
      mcpMotebitCheckbox.checked && mcpPublicKeyInput.value ? "flex" : "none";
  });

  document.getElementById("mcp-add-cancel")!.addEventListener("click", () => {
    mcpAddForm.style.display = "none";
  });

  document.getElementById("mcp-add-confirm")!.addEventListener("click", () => {
    const name = (document.getElementById("mcp-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const transport = mcpTransport.value as "stdio" | "http";
    const command = (document.getElementById("mcp-command") as HTMLInputElement).value.trim();
    const url = (document.getElementById("mcp-url") as HTMLInputElement).value.trim();
    const trusted = (document.getElementById("mcp-trusted") as HTMLInputElement).checked;
    const motebit = mcpMotebitCheckbox.checked;

    const config: McpServerConfig = { name, transport, trusted };
    if (motebit) config.motebit = true;
    if (transport === "stdio" && command) {
      const parts = command.split(/\s+/);
      config.command = parts[0];
      config.args = parts.slice(1);
    } else if (transport === "http" && url) {
      config.url = url;
    }

    mcpServersConfig.push(config);
    renderMcpServerList();
    mcpAddForm.style.display = "none";
    (document.getElementById("mcp-name") as HTMLInputElement).value = "";
    (document.getElementById("mcp-command") as HTMLInputElement).value = "";
    (document.getElementById("mcp-url") as HTMLInputElement).value = "";
    (document.getElementById("mcp-trusted") as HTMLInputElement).checked = false;
    mcpMotebitCheckbox.checked = false;
    mcpPublicKeyField.style.display = "none";
    mcpPublicKeyInput.value = "";
  });

  // === Link Device (Device A) ===

  document.getElementById("settings-link-device")!.addEventListener("click", () => {
    const config = ctx.getConfig();
    if (config?.isTauri !== true || config.invoke == null) {
      addMessage("system", "Pairing requires Tauri (not available in dev mode)");
      return;
    }
    const syncUrl = config.syncUrl;
    if (syncUrl == null || syncUrl === "") {
      addMessage("system", "No sync relay configured — set sync_url in config");
      return;
    }

    close();
    pairing.startLinkDevice(config.invoke, syncUrl);
  });

  // === Settings Open / Close ===

  function open(): void {
    saveFocus();

    const config = ctx.getConfig();
    if (config) {
      settingsProvider.value = config.provider;
      settingsMaxTokens.value = String(config.maxTokens ?? 4096);
      const currentModel =
        (ctx.app.currentModel != null && ctx.app.currentModel !== ""
          ? ctx.app.currentModel
          : config.model) ?? "";
      populateModelSelect(config.provider, currentModel);
    } else {
      populateModelSelect("ollama");
    }
    settingsApiKey.value = "";
    settingsApiKey.type = "password";
    settingsApiKeyToggle.textContent = "Show";
    settingsApiKey.placeholder = hasApiKeyInKeyring ? "API key stored" : "sk-ant-...";

    settingsOperatorMode.checked = ctx.app.isOperatorMode;

    settingsWhisperApiKey.value = "";
    settingsWhisperApiKey.type = "password";
    settingsWhisperApiKeyToggle.textContent = "Show";
    settingsWhisperApiKey.placeholder = hasWhisperKeyInKeyring ? "API key stored" : "sk-...";
    settingsVoiceAutoSend.checked = voice.getVoiceAutoSend();
    settingsVoiceResponse.checked = voice.getVoiceResponseEnabled();
    settingsTtsVoice.value = voice.getTtsVoice();

    colorPicker.savePreviousState();
    colorPicker.buildColorSwatches();

    renderMcpServerList();

    selectApprovalPreset(selectedApprovalPreset);

    switchTab("appearance");

    settingsBackdrop.classList.add("open");
    settingsModal.classList.add("open");

    // Focus the first focusable element in the modal
    requestAnimationFrame(() => focusFirst(settingsModal));
  }

  function openToTab(tabName: string): void {
    open();
    switchTab(tabName);
  }

  function close(): void {
    settingsBackdrop.classList.remove("open");
    settingsModal.classList.remove("open");
    restoreFocus();
  }

  function cancel(): void {
    colorPicker.restorePreviousState();
    close();
  }

  // === Save Settings ===

  async function saveSettings(): Promise<void> {
    const provider = settingsProvider.value as DesktopAIConfig["provider"];
    const model = settingsModel.value.trim() || undefined;
    const apiKey = settingsApiKey.value.trim() || undefined;
    const whisperApiKey = settingsWhisperApiKey.value.trim() || undefined;
    const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

    voice.setVoiceAutoSend(settingsVoiceAutoSend.checked);
    voice.setVoiceResponseEnabled(settingsVoiceResponse.checked);
    voice.setTtsVoice(settingsTtsVoice.value);

    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");

      const customColor = colorPicker.getCustomInteriorColor();
      const configData: Record<string, unknown> = {
        default_provider: provider,
        interior_color_preset: colorPicker.getSelectedPreset(),
        ...(colorPicker.getSelectedPreset() === "custom" && customColor
          ? {
              custom_soul_color: {
                hue: colorPicker.getCustomHue(),
                saturation: colorPicker.getCustomSaturation(),
                tint: customColor.tint,
                glow: customColor.glow,
              },
            }
          : {}),
        approval_preset: selectedApprovalPreset,
        mcp_servers: mcpServersConfig,
        memory_governance: {
          persistence_threshold: parseFloat(persistenceThreshold.value),
          reject_secrets: rejectSecrets.checked,
        },
        budget: {
          maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10,
        },
        voice: {
          auto_send: voice.getVoiceAutoSend(),
          voice_response: voice.getVoiceResponseEnabled(),
          tts_voice: voice.getTtsVoice(),
        },
      };
      if (model != null && model !== "") configData.default_model = model;
      await invoke("write_config", { json: JSON.stringify(configData) });

      if (apiKey != null && apiKey !== "") {
        await invoke("keyring_set", { key: "api_key", value: apiKey });
        hasApiKeyInKeyring = true;
      }

      if (whisperApiKey != null && whisperApiKey !== "") {
        await invoke("keyring_set", { key: "whisper_api_key", value: whisperApiKey });
        hasWhisperKeyInKeyring = true;
      }

      voice.rebuildTtsProvider(invoke as InvokeFn);
    }

    const approvalConfig = APPROVAL_PRESET_CONFIGS[selectedApprovalPreset];
    if (approvalConfig) {
      ctx.app.updatePolicyConfig({
        ...approvalConfig,
        operatorMode: settingsOperatorMode.checked,
        budget: { maxCallsPerTurn: parseInt(maxCalls.value, 10) || 10 },
      });
    }
    ctx.app.updateMemoryGovernance({
      persistenceThreshold: parseFloat(persistenceThreshold.value),
      rejectSecrets: rejectSecrets.checked,
    });

    const wantsOperator = settingsOperatorMode.checked;
    if (wantsOperator && !ctx.app.isOperatorMode) {
      const result = await ctx.app.setOperatorMode(true);
      if (!result.success) {
        if (result.needsSetup === true) {
          showPinDialog("setup");
        } else {
          showPinDialog("verify");
        }
        pendingSettingsSave = { provider, model, apiKey, isTauri };
        return;
      }
    } else if (!wantsOperator && ctx.app.isOperatorMode) {
      await ctx.app.setOperatorMode(false);
    }

    await finishSaveSettings(provider, model, apiKey, isTauri);
  }

  async function finishSaveSettings(
    provider: DesktopAIConfig["provider"],
    model?: string,
    apiKey?: string,
    isTauri = false,
  ): Promise<void> {
    const currentConfig = ctx.getConfig();
    const maxTokens = parseInt(settingsMaxTokens.value, 10) || undefined;
    const newConfig: DesktopAIConfig = {
      provider,
      model,
      apiKey: apiKey != null && apiKey !== "" ? apiKey : currentConfig?.apiKey,
      isTauri,
      maxTokens,
      invoke: currentConfig?.invoke,
    };
    ctx.setConfig(newConfig);

    if (!(await ctx.app.initAI(newConfig))) {
      addMessage("system", "AI initialization failed — check API key");
    }

    updateModelIndicator();
    close();
  }

  // === PIN Dialog ===

  function showPinDialog(mode: "setup" | "verify" | "reset"): void {
    pinMode = mode;
    pinInput.value = "";
    pinConfirmInput.value = "";
    pinError.textContent = "";
    pinConfirmText.style.display = "none";
    pinConfirmText.textContent = "";
    pinHint.style.display = mode === "reset" ? "none" : "block";
    if (mode === "setup") {
      pinTitle.textContent = "Set Operator PIN";
      pinInput.style.display = "block";
      pinConfirmInput.style.display = "block";
      (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "OK";
    } else if (mode === "reset") {
      pinTitle.textContent = "Reset Operator PIN?";
      pinInput.style.display = "none";
      pinConfirmInput.style.display = "none";
      pinConfirmText.style.display = "block";
      pinConfirmText.textContent = "This will clear your PIN and disable operator mode.";
      (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "Reset";
    } else {
      pinTitle.textContent = "Enter Operator PIN";
      pinInput.style.display = "block";
      pinConfirmInput.style.display = "none";
      (document.getElementById("pin-submit") as HTMLButtonElement).textContent = "OK";
    }
    pinBackdrop.classList.add("open");
    if (mode !== "reset") {
      requestAnimationFrame(() => pinInput.focus());
    }
  }

  function closePinDialog(): void {
    pinBackdrop.classList.remove("open");
    pinInput.value = "";
    pinConfirmInput.value = "";
    pinError.textContent = "";
    pendingRotation = false;
    settingsOperatorMode.checked = ctx.app.isOperatorMode;
  }

  async function handlePinSubmit(): Promise<void> {
    pinError.textContent = "";

    if (pinMode === "reset") {
      try {
        await ctx.app.resetOperatorPin();
      } catch (err: unknown) {
        pinError.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
      pinBackdrop.classList.remove("open");
      settingsOperatorMode.checked = false;
      return;
    }

    const pin = pinInput.value.trim();

    if (!/^\d{4,6}$/.test(pin)) {
      pinError.textContent = "PIN must be 4-6 digits";
      return;
    }

    if (pinMode === "setup") {
      const confirm = pinConfirmInput.value.trim();
      if (pin !== confirm) {
        pinError.textContent = "PINs do not match";
        return;
      }
      try {
        await ctx.app.setupOperatorPin(pin);
      } catch (err: unknown) {
        pinError.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
    }

    const result = await ctx.app.setOperatorMode(true, pin);
    if (!result.success) {
      pinError.textContent =
        result.error != null && result.error !== ""
          ? result.error
          : "Failed to enable operator mode";
      return;
    }

    pinBackdrop.classList.remove("open");
    if (pendingRotation) {
      pendingRotation = false;
      showRotateKeyDialog();
      return;
    }
    if (pendingSettingsSave) {
      const s = pendingSettingsSave;
      pendingSettingsSave = null;
      await finishSaveSettings(s.provider, s.model, s.apiKey, s.isTauri);
    }
  }

  // === Event Listeners ===

  document.getElementById("pin-cancel")!.addEventListener("click", closePinDialog);
  document.getElementById("pin-submit")!.addEventListener("click", () => {
    void handlePinSubmit();
  });
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      void handlePinSubmit();
    }
  });
  pinConfirmInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      void handlePinSubmit();
    }
  });

  settingsOperatorMode.addEventListener("change", () => {
    if (settingsOperatorMode.checked && !ctx.app.isOperatorMode) {
      const resultP = ctx.app.setOperatorMode(true);
      void resultP.then((result) => {
        if (!result.success) {
          showPinDialog(result.needsSetup === true ? "setup" : "verify");
        }
      });
    }
  });

  document.getElementById("settings-reset-pin")!.addEventListener("click", () => {
    showPinDialog("reset");
  });

  settingsBackdrop.addEventListener("click", cancel);
  document.getElementById("settings-btn")!.addEventListener("click", open);
  document.getElementById("settings-cancel")!.addEventListener("click", cancel);
  document.getElementById("settings-save")!.addEventListener("click", () => {
    void saveSettings();
  });
  settingsApiKeyToggle.addEventListener("click", () => {
    if (settingsApiKey.type === "password") {
      settingsApiKey.type = "text";
      settingsApiKeyToggle.textContent = "Hide";
    } else {
      settingsApiKey.type = "password";
      settingsApiKeyToggle.textContent = "Show";
    }
  });
  settingsWhisperApiKeyToggle.addEventListener("click", () => {
    if (settingsWhisperApiKey.type === "password") {
      settingsWhisperApiKey.type = "text";
      settingsWhisperApiKeyToggle.textContent = "Hide";
    } else {
      settingsWhisperApiKey.type = "password";
      settingsWhisperApiKeyToggle.textContent = "Show";
    }
  });

  return {
    open,
    openToTab,
    close,
    updateModelIndicator,
    getHasApiKeyInKeyring() {
      return hasApiKeyInKeyring;
    },
    setHasApiKeyInKeyring(v: boolean) {
      hasApiKeyInKeyring = v;
    },
    getHasWhisperKeyInKeyring() {
      return hasWhisperKeyInKeyring;
    },
    setHasWhisperKeyInKeyring(v: boolean) {
      hasWhisperKeyInKeyring = v;
    },
    getSelectedApprovalPreset() {
      return selectedApprovalPreset;
    },
    setSelectedApprovalPreset(v: string) {
      selectedApprovalPreset = v;
    },
    getMcpServersConfig() {
      return mcpServersConfig;
    },
    setMcpServersConfig(v: McpServerConfig[]) {
      mcpServersConfig = v;
    },
    setDiscoveryCollisions(v: NameCollision[]) {
      discoveryCollisions = v;
    },
    isPinDialogOpen() {
      return pinBackdrop.classList.contains("open");
    },
    closePinDialog,
    isRotateKeyDialogOpen() {
      return rotateKeyBackdrop.classList.contains("open");
    },
    closeRotateKeyDialog,
  };
}

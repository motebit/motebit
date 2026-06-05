import type { WebContext } from "../types";
import type { ProviderConfig, GovernanceConfig, VoiceConfig, AppearanceConfig } from "../storage";
import { APPROVAL_PRESET_CONFIGS, DEFAULT_GOVERNANCE_CONFIG } from "@motebit/sdk";
import {
  saveProviderConfig,
  saveSoulColor,
  saveGovernanceConfig,
  saveProactiveConfig,
  loadProactiveConfig,
  saveColdStartOptIn,
  loadColdStartOptIn,
  loadGovernanceConfig,
  saveVoiceConfig,
  loadVoiceConfig,
  getVendorKey,
  setVendorKey,
} from "../storage";
import { checkWebGPU, WebLLMProvider, DEFAULT_OLLAMA_URL } from "../providers";
import { detectLocalInference, probeLocalModels, DEFAULT_LOCAL_ENDPOINTS } from "../bootstrap";
import { setTTSVoice } from "./chat";
import { rebuildTTSProvider } from "../main";
import { ELEVENLABS_VOICES, DEEPGRAM_VOICES } from "@motebit/voice";
import { hexPublicKeyToDidKey } from "@motebit/encryption";
import type { ColorPickerAPI } from "./color-picker";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_GOOGLE_MODEL, isLocalServerUrl } from "@motebit/sdk";

/** Which provider tab the UI is showing. Maps from `UnifiedProviderConfig.mode`. */
type ProviderTab = "proxy" | "anthropic" | "openai" | "ollama" | "webllm";

// === DOM Refs ===

const settingsBackdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const connectPrompt = document.getElementById("connect-prompt") as HTMLDivElement;
const modelIndicator = document.getElementById("model-indicator") as HTMLDivElement;

// Identity fields
const identityMotebitId = document.getElementById("identity-motebit-id") as HTMLElement;
const identityDeviceId = document.getElementById("identity-device-id") as HTMLElement;
const identityDid = document.getElementById("identity-did") as HTMLElement;
const identityPublicKey = document.getElementById("identity-public-key") as HTMLElement;
const identitySyncStatus = document.getElementById("identity-sync-status");

// Sovereign wallet address lives in Settings as part of identity (the address
// *is* the Ed25519 public key, base58-encoded). Balance and funding live in
// the Sovereign panel, where economic state belongs — doctrine split:
// Settings = who you are; Sovereign panel = what you have, what's flowing.
const walletSolanaAddress = document.getElementById("wallet-solana-address") as HTMLElement;

// Recovery seed reveal — sensitive action, gated behind explicit click +
// auto-hide. The keystore is already encrypted at rest; this is the
// user-facing affordance to back the seed up to a password manager.
const identityRecoverySeed = document.getElementById(
  "identity-recovery-seed",
) as HTMLDivElement | null;
const revealRecoverySeedBtn = document.getElementById(
  "reveal-recovery-seed",
) as HTMLButtonElement | null;
const copyRecoverySeedBtn = document.getElementById(
  "copy-recovery-seed",
) as HTMLButtonElement | null;
const hideRecoverySeedBtn = document.getElementById(
  "hide-recovery-seed",
) as HTMLButtonElement | null;
let recoverySeedAutoHideTimer: ReturnType<typeof setTimeout> | null = null;
const RECOVERY_SEED_AUTOHIDE_MS = 60_000;

// === Provider Tab DOM ===
const providerTabs = document.querySelectorAll<HTMLButtonElement>("#provider-tabs .provider-tab");
const providerConfigs = {
  proxy: document.getElementById("provider-proxy") as HTMLDivElement,
  anthropic: document.getElementById("provider-anthropic") as HTMLDivElement,
  openai: document.getElementById("provider-openai") as HTMLDivElement,
  ollama: document.getElementById("provider-ollama") as HTMLDivElement,
  webllm: document.getElementById("provider-webllm") as HTMLDivElement,
};

// Input elements
const anthropicApiKey = document.getElementById("anthropic-api-key") as HTMLInputElement;
const anthropicModel = document.getElementById("anthropic-model") as HTMLSelectElement;
const openaiApiKey = document.getElementById("openai-api-key") as HTMLInputElement;
const openaiModel = document.getElementById("openai-model") as HTMLSelectElement;
const ollamaBaseUrl = document.getElementById("ollama-base-url") as HTMLInputElement;
const ollamaModel = document.getElementById("ollama-model") as HTMLSelectElement;
const ollamaStatus = document.getElementById("ollama-status") as HTMLDivElement;
const webllmModel = document.getElementById("webllm-model") as HTMLSelectElement;
const webllmStatus = document.getElementById("webllm-status") as HTMLDivElement;
const webllmProgress = document.getElementById("webllm-progress") as HTMLDivElement;
const webllmProgressFill = document.getElementById("webllm-progress-fill") as HTMLDivElement;
const webllmProgressText = document.getElementById("webllm-progress-text") as HTMLDivElement;
const maxTokensSelect = document.getElementById("max-tokens-select") as HTMLSelectElement | null;

// Governance elements
const approvalPresets = document.querySelectorAll<HTMLInputElement>(
  'input[name="approval-preset"]',
);
const presetGroup = document.getElementById("approval-preset-group");
const settingsOperatorMode = document.getElementById(
  "settings-operator-mode",
) as HTMLInputElement | null;
const settingsResetPin = document.getElementById("settings-reset-pin") as HTMLButtonElement | null;
const govPersistenceThreshold = document.getElementById(
  "gov-persistence-threshold",
) as HTMLInputElement;
const govPersistenceValue = document.getElementById("gov-persistence-value") as HTMLSpanElement;
const govRejectSecrets = document.getElementById("gov-reject-secrets") as HTMLInputElement;
const govMaxCalls = document.getElementById("gov-max-calls") as HTMLInputElement;
const govProactiveEnabled = document.getElementById(
  "gov-proactive-enabled",
) as HTMLInputElement | null;
const govProactiveAnchor = document.getElementById(
  "gov-proactive-anchor",
) as HTMLInputElement | null;
const govP2pColdStart = document.getElementById("gov-p2p-cold-start") as HTMLInputElement | null;

// PIN dialog elements (operator-mode escalation)
const pinBackdrop = document.getElementById("pin-backdrop");
const pinTitle = document.getElementById("pin-title") as HTMLDivElement | null;
const pinInput = document.getElementById("pin-input") as HTMLInputElement | null;
const pinConfirmInput = document.getElementById("pin-confirm-input") as HTMLInputElement | null;
const pinHint = document.getElementById("pin-hint") as HTMLDivElement | null;
const pinConfirmText = document.getElementById("pin-confirm-text") as HTMLDivElement | null;
const pinError = document.getElementById("pin-error") as HTMLDivElement | null;

// Voice elements
const ttsVoiceSelect = document.getElementById("settings-tts-voice") as HTMLSelectElement;
const voiceAutoSend = document.getElementById("settings-voice-autosend") as HTMLInputElement;
const voiceResponse = document.getElementById("settings-voice-response") as HTMLInputElement;
const ttsElevenlabsKey = document.getElementById("tts-elevenlabs-key") as HTMLInputElement | null;
const ttsDeepgramKey = document.getElementById("tts-deepgram-key") as HTMLInputElement | null;
const ttsInworldKey = document.getElementById("tts-inworld-key") as HTMLInputElement | null;

// === State ===

let activeProviderTab: ProviderTab = "proxy";
let activeByokProvider: "anthropic" | "openai" | "google" | "deepseek" | "groq" = "anthropic";
/** On-Device backend: browser (WebLLM) or auto-detected local server. */
let activeLocalBackend: "webllm" | "server" = "webllm";

// === Settings API ===

export interface SettingsAPI {
  open(): void;
  openToTab(tabName: string): void;
  close(): void;
  updateModelIndicator(): void;
  updateConnectPrompt(): void;
}

export interface SettingsDeps {
  colorPicker: ColorPickerAPI;
}

// Card-click selection — sync `.selected` highlight with the underlying
// radio. Mirrors desktop's `selectApprovalPreset` so the visual state
// matches the input state regardless of which one the user interacted with.
function selectApprovalPreset(preset: string): void {
  approvalPresets.forEach((radio) => {
    const checked = radio.value === preset;
    radio.checked = checked;
    const label = radio.closest<HTMLElement>(".preset-option");
    if (label != null) label.classList.toggle("selected", checked);
  });
}

// Operator-mode toggle's checked state is the source of truth at save
// time. Keeping the runtime in sync — `runtime.setOperatorMode(true, pin?)`
// is the gate that requires PIN; this function only writes the
// non-operator-mode policy fields, so flipping the preset never bypasses
// the PIN check.
function applyGovernanceToRuntime(ctx: WebContext, gov: GovernanceConfig): void {
  const runtime = ctx.app.getRuntime();
  if (!runtime) return;
  const preset = APPROVAL_PRESET_CONFIGS[gov.approvalPreset] ?? APPROVAL_PRESET_CONFIGS.balanced!;
  runtime.updatePolicyConfig({
    operatorMode: ctx.app.isOperatorMode,
    maxRiskLevel: preset.maxRiskLevel,
    requireApprovalAbove: preset.requireApprovalAbove,
    denyAbove: preset.denyAbove,
    budget: { maxCallsPerTurn: gov.maxCallsPerTurn },
  });
}

export function initSettings(ctx: WebContext, deps: SettingsDeps): SettingsAPI {
  const { colorPicker } = deps;

  // === Tab Switching (Appearance / Intelligence) ===

  function switchTab(tabName: string): void {
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      const isActive = (tab as HTMLElement).dataset.tab === tabName;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
    document.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.classList.toggle("active", pane.id === `pane-${tabName}`);
    });

    if (tabName === "identity") {
      populateIdentityFields();
    }
    if (tabName === "governance") {
      populateAuditTrail();
    }
  }

  function populateIdentityFields(): void {
    identityMotebitId.textContent = ctx.app.motebitId || "—";
    identityDeviceId.textContent = ctx.app.deviceId || "—";
    const pubHex = ctx.app.publicKeyHex;
    identityDid.textContent = pubHex ? hexPublicKeyToDidKey(pubHex) : "—";
    identityPublicKey.textContent = pubHex || "—";
    populateWalletFields();
    resetRecoverySeedUi();
  }

  /** Reset the recovery seed UI to the hidden state. Called every time
   *  the settings panel opens (so the seed never persists across opens)
   *  and on auto-hide timer expiry. */
  function resetRecoverySeedUi(): void {
    if (identityRecoverySeed != null) {
      identityRecoverySeed.textContent = "— hidden —";
      identityRecoverySeed.dataset.state = "hidden";
      identityRecoverySeed.title = "Reveal recovery seed";
    }
    if (revealRecoverySeedBtn != null) revealRecoverySeedBtn.style.display = "";
    if (copyRecoverySeedBtn != null) copyRecoverySeedBtn.style.display = "none";
    if (hideRecoverySeedBtn != null) hideRecoverySeedBtn.style.display = "none";
    if (recoverySeedAutoHideTimer != null) {
      clearTimeout(recoverySeedAutoHideTimer);
      recoverySeedAutoHideTimer = null;
    }
  }

  // Wire the recovery-seed reveal flow once. Confirm before reveal —
  // sensitive action, screen-share protection. Auto-hides after a fixed
  // interval so an unattended browser tab doesn't leak the seed.
  if (revealRecoverySeedBtn != null && identityRecoverySeed != null) {
    revealRecoverySeedBtn.addEventListener("click", () => {
      const confirmed = window.confirm(
        "Reveal recovery seed?\n\n" +
          "Anyone with this string can sign as your motebit forever and spend any SOL at " +
          "your sovereign address. Make sure no one else can see your screen.\n\n" +
          "The seed will auto-hide in 60 seconds.",
      );
      if (!confirmed) return;
      void (async () => {
        try {
          const seed = await ctx.app.revealRecoverySeed();
          if (seed == null || seed === "") {
            identityRecoverySeed.textContent = "(no seed found — keystore empty)";
            identityRecoverySeed.dataset.state = "error";
            return;
          }
          identityRecoverySeed.textContent = seed;
          identityRecoverySeed.dataset.state = "revealed";
          identityRecoverySeed.title = "Click Copy or Hide";
          if (revealRecoverySeedBtn != null) revealRecoverySeedBtn.style.display = "none";
          if (copyRecoverySeedBtn != null) copyRecoverySeedBtn.style.display = "";
          if (hideRecoverySeedBtn != null) hideRecoverySeedBtn.style.display = "";
          if (recoverySeedAutoHideTimer != null) clearTimeout(recoverySeedAutoHideTimer);
          recoverySeedAutoHideTimer = setTimeout(() => {
            resetRecoverySeedUi();
          }, RECOVERY_SEED_AUTOHIDE_MS);
        } catch (err: unknown) {
          identityRecoverySeed.textContent = `(reveal failed: ${err instanceof Error ? err.message : String(err)})`;
          identityRecoverySeed.dataset.state = "error";
        }
      })();
    });
  }
  if (copyRecoverySeedBtn != null && identityRecoverySeed != null) {
    copyRecoverySeedBtn.addEventListener("click", () => {
      const seed = identityRecoverySeed.textContent ?? "";
      if (seed === "" || seed === "— hidden —") return;
      void navigator.clipboard.writeText(seed).then(() => {
        const original = copyRecoverySeedBtn.textContent;
        copyRecoverySeedBtn.textContent = "Copied";
        setTimeout(() => {
          copyRecoverySeedBtn.textContent = original;
        }, 1200);
      });
    });
  }
  if (hideRecoverySeedBtn != null) {
    hideRecoverySeedBtn.addEventListener("click", () => {
      resetRecoverySeedUi();
    });
  }

  /**
   * Populate the Sovereign Wallet card. Derives the Solana address from the
   * runtime's Ed25519 identity key (synchronous — no RPC). Balance rendering
   * lives in the Sovereign panel; Settings shows identity-shaped fields only.
   */
  function populateWalletFields(): void {
    const runtime = ctx.app.getRuntime();
    const address = runtime?.getSolanaAddress() ?? null;
    walletSolanaAddress.textContent = address ?? "—";
  }

  /**
   * Populate the TTS voice picker based on which BYOK keys are currently
   * entered. The picker always reflects the *active* provider's voice space.
   * Voice section's three majors: ElevenLabs / Deepgram / Inworld. Each
   * adds an optgroup to the picker when keyed; runtime's fallback chain
   * routes the call to whichever provider owns the chosen voice id.
   *
   *   ElevenLabs keyed → curated `ELEVENLABS_VOICES` names
   *   Deepgram keyed   → `DEEPGRAM_VOICES` (Aura / Aura-2 voice ids)
   *   Inworld keyed    → Inworld voice ids (e.g., "Dennis"; full list
   *                      not enumerated here — Inworld supports voice
   *                      cloning so the canonical set grows over time)
   *   None             → a single "Browser default" option
   *
   * Re-runs on every key-field input so the menu tracks what the user is
   * currently typing without waiting for Save. Preserves the current
   * selection if it still exists in the new option list.
   */
  function populateTtsVoices(): void {
    const elevenKey = ttsElevenlabsKey?.value.trim() ?? "";
    const deepgramKey = ttsDeepgramKey?.value.trim() ?? "";
    const inworldKey = ttsInworldKey?.value.trim() ?? "";
    const previous = ttsVoiceSelect.value;
    const saved = loadVoiceConfig()?.ttsVoice ?? "";

    ttsVoiceSelect.innerHTML = "";
    const allValues: string[] = [];

    // Union of every voice the user can actually pick right now, grouped by
    // provider with <optgroup>. Multiple keys → multiple groups visible.
    // Runtime's fallback chain (ElevenLabs → Inworld → Deepgram → browser)
    // routes the call to the provider that owns the chosen voice id.
    const appendGroup = (label: string, voices: readonly string[]): void => {
      if (voices.length === 0) return;
      const group = document.createElement("optgroup");
      group.label = label;
      for (const name of voices) {
        const el = document.createElement("option");
        el.value = name;
        el.textContent = name;
        group.appendChild(el);
        allValues.push(name);
      }
      ttsVoiceSelect.appendChild(group);
    };

    if (elevenKey) appendGroup("ElevenLabs", Object.keys(ELEVENLABS_VOICES));
    // Inworld doesn't publish a fixed voice list (voice cloning supported);
    // surface the documented example "Dennis" plus an empty default. Users
    // can override via direct text entry on the Inworld voice config later.
    if (inworldKey) appendGroup("Inworld", ["Dennis"]);
    if (deepgramKey) appendGroup("Deepgram", DEEPGRAM_VOICES);

    // Browser default is always available — it's the zero-key fallback.
    const browserGroup = document.createElement("optgroup");
    browserGroup.label = "Browser";
    const browserOpt = document.createElement("option");
    browserOpt.value = "";
    browserOpt.textContent = "Browser default";
    browserGroup.appendChild(browserOpt);
    ttsVoiceSelect.appendChild(browserGroup);
    allValues.push("");

    // Restore selection in priority order: live-edit value → stored config → first.
    const candidates = [previous, saved].filter(
      (v): v is string => v !== "" || allValues.includes(""),
    );
    for (const candidate of candidates) {
      if (allValues.includes(candidate)) {
        ttsVoiceSelect.value = candidate;
        return;
      }
    }
    ttsVoiceSelect.value = allValues[0] ?? "";
  }

  /**
   * Toggle password-reveal on a key input. Each reveal button carries a
   * `data-target` pointing at the input id. Calm UI — no icon swap; we use
   * "Show" / "Hide" text so the affordance is unambiguous without depending
   * on a glyph set.
   */
  function wireKeyRevealButtons(): void {
    document.querySelectorAll<HTMLButtonElement>(".tts-key-reveal").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.target;
        if (!targetId) return;
        const input = document.getElementById(targetId) as HTMLInputElement | null;
        if (!input) return;
        const revealed = input.type === "text";
        input.type = revealed ? "password" : "text";
        btn.textContent = revealed ? "Show" : "Hide";
        btn.setAttribute("aria-pressed", String(!revealed));
      });
    });
  }

  // Re-populate voices whenever a key field changes — the option space
  // depends on which keys are present. Debouncing not needed; the work is
  // <10 options and a few DOM nodes.
  ttsElevenlabsKey?.addEventListener("input", () => populateTtsVoices());
  ttsDeepgramKey?.addEventListener("input", () => populateTtsVoices());
  ttsInworldKey?.addEventListener("input", () => populateTtsVoices());
  wireKeyRevealButtons();

  function classifyDecision(decision: unknown): "allowed" | "denied" | "approval" {
    if (decision == null || typeof decision !== "object") return "allowed";
    const d = decision as Record<string, unknown>;
    if (d.allowed === false) return "denied";
    if (d.requiresApproval === true) return "approval";
    return "allowed";
  }

  function formatTimeAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function populateAuditTrail(): void {
    const listEl = document.getElementById("audit-activity-list")!;
    const emptyEl = document.getElementById("audit-activity-empty")!;
    listEl.innerHTML = "";
    emptyEl.style.display = "none";

    const runtime = ctx.app.getRuntime();
    if (!runtime) {
      emptyEl.style.display = "block";
      return;
    }

    const entries = runtime.policy.audit.getAll();
    if (entries.length === 0) {
      emptyEl.style.display = "block";
      return;
    }

    // Show most recent first, limit to 50
    const recent = entries.slice(-50).reverse();
    for (const entry of recent) {
      const row = document.createElement("div");
      row.className = "audit-row";

      const header = document.createElement("div");
      header.className = "audit-row-header";

      const toolName = document.createElement("span");
      toolName.className = "audit-tool-name";
      toolName.textContent = entry.tool;
      header.appendChild(toolName);

      const badgeClass = classifyDecision(entry.decision);
      const badge = document.createElement("span");
      badge.className = `audit-decision-badge ${badgeClass}`;
      badge.textContent = badgeClass;
      header.appendChild(badge);

      if (entry.injection?.detected) {
        const injBadge = document.createElement("span");
        injBadge.className = "audit-decision-badge denied";
        injBadge.textContent = "injection";
        header.appendChild(injBadge);
      }

      const time = document.createElement("span");
      time.className = "audit-time";
      time.textContent = formatTimeAgo(entry.timestamp);
      header.appendChild(time);

      row.appendChild(header);

      // Expandable detail
      const detail = document.createElement("div");
      detail.className = "audit-row-detail";

      const argsStr = JSON.stringify(entry.args ?? {});
      const argsDiv = document.createElement("div");
      argsDiv.className = "audit-detail-args";
      argsDiv.textContent = argsStr.length > 200 ? argsStr.slice(0, 200) + "..." : argsStr;
      detail.appendChild(argsDiv);

      if (entry.result) {
        const resultDiv = document.createElement("div");
        resultDiv.className = "audit-detail-result";
        const ok = entry.result.ok ? "ok" : "failed";
        const dur = entry.result.durationMs != null ? `${entry.result.durationMs}ms` : "";
        resultDiv.textContent = [ok, dur].filter(Boolean).join(" · ");
        detail.appendChild(resultDiv);
      }

      row.appendChild(detail);
      row.addEventListener("click", () => row.classList.toggle("expanded"));
      listEl.appendChild(row);
    }
  }

  function setupIdentityCopyHandlers(): void {
    // Two parallel patterns:
    //   1. Click anywhere on the identity-value span itself — legacy
    //      click-to-copy (kept for backward muscle memory).
    //   2. Explicit `.copy-btn[data-copy]` buttons next to each row —
    //      mirrors desktop's pattern and is the more discoverable
    //      affordance for new users.
    const clickable = [
      identityMotebitId,
      identityDeviceId,
      identityDid,
      identityPublicKey,
      walletSolanaAddress,
    ];
    for (const el of clickable) {
      el.addEventListener("click", () => {
        const text = el.textContent;
        if (text == null || text === "" || text === "—") return;
        void navigator.clipboard.writeText(text).then(() => {
          el.classList.add("copied");
          setTimeout(() => el.classList.remove("copied"), 1000);
        });
      });
    }
    // Explicit Copy buttons (data-copy attribute identifies the target id).
    document.querySelectorAll<HTMLButtonElement>(".copy-btn[data-copy]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation(); // don't double-trigger the field click
        const targetId = btn.dataset.copy;
        if (targetId == null || targetId === "") return;
        const target = document.getElementById(targetId);
        if (target == null) return;
        const text = target.textContent;
        if (text == null || text === "" || text === "—") return;
        void navigator.clipboard.writeText(text).then(() => {
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = prev;
          }, 1200);
        });
      });
    });
  }

  setupIdentityCopyHandlers();

  // Sync-status badge — reflects ctx.app.syncStatus. The disconnected /
  // connecting / connected classes drive the badge color from the
  // .sync-badge CSS in index.html. Mirrors desktop's identity-sync-status
  // wiring; web's status is "offline" when the relay is unreachable
  // and the local-only path is still operating.
  function updateSyncBadge(): void {
    if (identitySyncStatus == null) return;
    const status = ctx.app.syncStatus;
    const labels: Record<typeof status, string> = {
      offline: "Not connected",
      connecting: "Connecting…",
      connected: "Connected",
      syncing: "Syncing…",
      error: "Error",
      disconnected: "Disconnected",
    };
    identitySyncStatus.textContent = labels[status] ?? "Not connected";
    identitySyncStatus.className = `sync-badge ${status === "connected" || status === "syncing" ? "connected" : "disconnected"}`;
  }
  updateSyncBadge();
  ctx.app.onSyncStatusChange(updateSyncBadge);

  // Funding lives in the Sovereign panel — see openSovereignFundingFlow in
  // ./wallet-balance.ts. Settings shows the address (identity); Sovereign
  // shows the balance and the Fund action (economic state).

  // Rotate Key button
  document.getElementById("settings-rotate-key")?.addEventListener("click", () => {
    const confirmed = confirm(
      "Rotate your Ed25519 keypair? The old key signs a succession record transferring trust to the new key.",
    );
    if (!confirmed) return;
    void ctx.app
      .rotateKey("manual rotation")
      .then(() => {
        populateIdentityFields();
        ctx.showToast("Key rotated successfully");
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.showToast(`Key rotation failed: ${msg}`);
      });
  });

  // Capabilities panel — opens via custom event the capabilities-panel
  // module listens for. Settings closes first so the panel renders
  // cleanly. Replaces a HUD button slot — the canonical 3-1-3 HUD
  // doesn't include Capabilities; Settings → Intelligence is the
  // discoverability path.
  document.getElementById("settings-open-capabilities")?.addEventListener("click", () => {
    close();
    document.dispatchEvent(new CustomEvent("motebit:open-capabilities"));
  });

  // Export Data button
  document.getElementById("settings-export-data")?.addEventListener("click", () => {
    void ctx.app.exportData().then((json) => {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `motebit-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // Export motebit.md — signed identity file. Same shape as desktop's
  // settings-export-identity wiring; web triggers a browser download
  // instead of routing through a Tauri save-file dialog.
  document.getElementById("settings-export-identity")?.addEventListener("click", () => {
    void ctx.app.exportMotebitMd().then((md) => {
      if (md == null) {
        ctx.showToast("Cannot export — identity not initialized");
        return;
      }
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "motebit.md";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // Verify motebit.md — file picker → read selected .md → call verify
  // through @motebit/identity-file (browser-safe, zero node:* deps).
  document.getElementById("settings-verify-identity")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,text/markdown,text/plain";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then(async (content) => {
        const result = await ctx.app.verifyMotebitMd(content);
        const el = document.getElementById("verify-result");
        if (el == null) return;
        el.style.display = "";
        if (result.valid) {
          el.style.background = "var(--accent-bg, rgba(110, 130, 240, 0.12))";
          el.style.color = "var(--accent, #6e82f0)";
          el.textContent = `✓ Valid — ${file.name}`;
        } else {
          el.style.background = "var(--status-warning-bg, rgba(240, 160, 48, 0.12))";
          el.style.color = "var(--status-warning, #f0a030)";
          el.textContent = `✗ Invalid — ${result.error ?? "signature check failed"}`;
        }
      });
    });
    input.click();
  });

  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = (tab as HTMLElement).dataset.tab;
      if (name != null && name !== "") switchTab(name);
    });
  });

  // === WebLLM Model List ===
  // Fetched from @mlc-ai/web-llm's prebuiltAppConfig.model_list on first demand.
  // Curated subset: the most useful general-purpose chat models, ordered by
  // memory footprint (smallest first). Avoids dumping 80+ exotic variants.

  let webllmModelsPopulated = false;

  async function populateWebLLMModels(): Promise<void> {
    if (webllmModelsPopulated) return;
    try {
      // @ts-expect-error — CDN dynamic import, same path used by WebLLMProvider
      const webllm = (await import("https://esm.run/@mlc-ai/web-llm")) as {
        prebuiltAppConfig?: {
          model_list?: Array<{
            model_id: string;
            vram_required_MB?: number;
            model_type?: number;
          }>;
        };
      };
      const list = webllm.prebuiltAppConfig?.model_list;
      if (!list || list.length === 0) return;

      // Curated families: general-purpose instruction-tuned chat models only.
      // Skip embedding/function-calling-only variants.
      const CURATED_FAMILIES = [
        "Llama-3.2-1B-Instruct",
        "Llama-3.2-3B-Instruct",
        "Llama-3.1-8B-Instruct",
        "Phi-3.5-mini-instruct",
        "Qwen2.5-0.5B-Instruct",
        "Qwen2.5-1.5B-Instruct",
        "Qwen2.5-3B-Instruct",
        "Qwen2.5-7B-Instruct",
        "gemma-2-2b-it",
        "gemma-2-9b-it",
        "Mistral-7B-Instruct-v0.3",
        "SmolLM2-1.7B-Instruct",
        "SmolLM2-360M-Instruct",
      ];

      const seenFamilies = new Set<string>();
      const curated: Array<{ id: string; label: string; vramMB: number }> = [];
      for (const entry of list) {
        const family = CURATED_FAMILIES.find((f) => entry.model_id.includes(f));
        if (!family) continue;
        // Prefer q4f16 quantizations; skip duplicates of the same family.
        if (seenFamilies.has(family)) continue;
        if (!entry.model_id.includes("q4f16")) continue;
        seenFamilies.add(family);
        curated.push({
          id: entry.model_id,
          label: family.replace(/-Instruct|-it/g, ""),
          vramMB: entry.vram_required_MB ?? 9999,
        });
      }

      if (curated.length === 0) return;
      curated.sort((a, b) => a.vramMB - b.vramMB);

      // Preserve current selection if possible
      const current = webllmModel.value;
      webllmModel.innerHTML = "";
      for (const m of curated) {
        const opt = document.createElement("option");
        opt.value = m.id;
        const vramGb = (m.vramMB / 1024).toFixed(1);
        opt.textContent = `${m.label} (${vramGb} GB)`;
        webllmModel.appendChild(opt);
      }
      if (current && curated.some((m) => m.id === current)) {
        webllmModel.value = current;
      }
      webllmModelsPopulated = true;
    } catch {
      // Network failure, CDN offline, etc. — silently fall back to the static list in index.html
    }
  }

  // === Provider Tab Switching ===

  function switchProviderTab(provider: ProviderTab): void {
    activeProviderTab = provider;
    providerTabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.provider === provider);
    });
    for (const [key, el] of Object.entries(providerConfigs)) {
      el.classList.toggle("active", key === provider);
    }

    // Auto-detect local servers when switching to On-Device tab with server backend active
    if (provider === "ollama" && activeLocalBackend === "server") {
      void detectAndPopulateLocalServer();
    }

    // Check WebGPU when switching to WebLLM tab
    if (provider === "webllm") {
      if (checkWebGPU()) {
        webllmStatus.textContent = "WebGPU available";
        webllmStatus.className = "webllm-status";
      } else {
        webllmStatus.textContent = "WebGPU not available in this browser";
        webllmStatus.className = "webllm-status error";
      }
      void populateWebLLMModels();
    }
    // On-Device tab with WebLLM sub-backend also needs the populated list.
    if (provider === "ollama" && activeLocalBackend === "webllm") {
      void populateWebLLMModels();
    }
  }

  providerTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const provider = tab.dataset.provider;
      if (provider) switchProviderTab(provider as ProviderTab);
    });
  });

  // === BYOK Sub-Provider Toggle ===
  document.querySelectorAll<HTMLButtonElement>(".byok-provider-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const byok = btn.dataset.byok as "anthropic" | "openai" | "google" | "deepseek" | "groq";
      if (!byok) return;
      activeByokProvider = byok;
      setByokProviderUI(byok);
    });
  });

  // === On-Device Backend Toggle (WebLLM vs Local Server) ===
  document.querySelectorAll<HTMLButtonElement>(".local-backend-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const backend = btn.dataset.backend as "webllm" | "server";
      if (!backend) return;
      activeLocalBackend = backend;
      document.querySelectorAll<HTMLButtonElement>(".local-backend-btn").forEach((b) => {
        const isActive = b.dataset.backend === backend;
        b.classList.toggle("active", isActive);
        b.style.background = isActive ? "var(--accent-bg)" : "transparent";
        b.style.color = isActive ? "var(--text-heading)" : "var(--text-muted)";
      });
      const webllmSection = document.getElementById("local-webllm");
      const serverSection = document.getElementById("local-ollama");
      if (webllmSection) webllmSection.style.display = backend === "webllm" ? "" : "none";
      if (serverSection) serverSection.style.display = backend === "server" ? "" : "none";
      if (backend === "server") void detectAndPopulateLocalServer();
      if (backend === "webllm") void populateWebLLMModels();
    });
  });

  // === Local Server Auto-Detection ===
  // Probes multiple known endpoints (Ollama, LM Studio, llama.cpp, Jan, generic OpenAI-compat)
  // and shows which one was found. User can override the endpoint manually.

  /** Friendly server name from endpoint URL and API type. */
  function friendlyServerName(baseUrl: string, type: "ollama" | "openai"): string {
    if (type === "ollama") return "Ollama";
    if (baseUrl.includes(":1234")) return "LM Studio";
    if (baseUrl.includes(":8080")) return "llama.cpp";
    if (baseUrl.includes(":1337")) return "Jan";
    return "Local server";
  }

  function populateModelList(models: string[]): void {
    ollamaModel.innerHTML = "";
    if (models.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No models found";
      ollamaModel.appendChild(opt);
      return;
    }
    for (const model of models) {
      const opt = document.createElement("option");
      opt.value = model;
      opt.textContent = model;
      ollamaModel.appendChild(opt);
    }
  }

  /**
   * Render a `ProbeOutcome` into the settings status row. Each
   * non-ok kind carries a specific user remediation — the typed-
   * truth-perception doctrine applied to the local-server probe:
   * the wire signal IS the kind, the surface reads it, the user
   * sees the action they need to take.
   *
   *   ok                  → "<server name> — N models" (connected)
   *   server_up_no_models → "Server is up but has no models. Pull
   *                          one (e.g. `ollama pull llama3`)."
   *   cors_blocked        → red text + the OLLAMA_ORIGINS copy-
   *                          paste command keyed to the current
   *                          origin, so the user can fix it in one
   *                          terminal command.
   *   unreachable         → "Start your server" hint.
   *
   * Pre-doctrine, all three failures collapsed to "no models found"
   * and the user couldn't tell which remediation applied.
   */
  function renderProbeOutcome(outcome: import("../bootstrap").ProbeOutcome): void {
    if (outcome.kind === "ok") {
      ollamaBaseUrl.value = outcome.baseUrl;
      const name = friendlyServerName(outcome.baseUrl, outcome.type);
      ollamaStatus.textContent = `${name} — ${outcome.models.length} model${outcome.models.length !== 1 ? "s" : ""}`;
      ollamaStatus.className = "ollama-status connected";
      populateModelList(outcome.models);
      return;
    }
    populateModelList([]);
    if (outcome.kind === "server_up_no_models") {
      const name = friendlyServerName(outcome.baseUrl, outcome.type);
      ollamaStatus.textContent = `${name} is running but has no models. Pull one (e.g. \`ollama pull llama3\`).`;
      ollamaStatus.className = "ollama-status error";
      return;
    }
    if (outcome.kind === "cors_blocked") {
      // The user is on HTTPS (motebit.com) probing http://localhost.
      // The browser fired the request, the server received it, but
      // the response was dropped because Ollama's default
      // Access-Control-Allow-Origin is localhost-only. The
      // remediation is one shell command. Keep the message tight —
      // calm-software register, not a wall of debug text.
      const origin =
        typeof globalThis !== "undefined" && "location" in globalThis
          ? (globalThis as { location?: { origin?: string } }).location?.origin
          : undefined;
      const cmd = origin
        ? `OLLAMA_ORIGINS="${origin}" ollama serve`
        : `OLLAMA_ORIGINS="https://motebit.com" ollama serve`;
      ollamaStatus.textContent = `Server reachable but blocking the browser. Restart with: ${cmd}`;
      ollamaStatus.className = "ollama-status error";
      return;
    }
    // unreachable
    ollamaStatus.textContent =
      "No local server detected. Start Ollama, LM Studio, or llama.cpp on localhost.";
    ollamaStatus.className = "ollama-status error";
  }

  /** Initial detection — probe all known endpoints and populate UI with the first hit. */
  async function detectAndPopulateLocalServer(): Promise<void> {
    ollamaStatus.textContent = "Detecting local servers...";
    ollamaStatus.className = "ollama-status";

    const outcome = await detectLocalInference(DEFAULT_LOCAL_ENDPOINTS);
    if (outcome.kind !== "ok" && !ollamaBaseUrl.value) {
      ollamaBaseUrl.value = DEFAULT_OLLAMA_URL;
    }
    renderProbeOutcome(outcome);
  }

  /** Re-probe a specific endpoint when the user edits the URL manually. */
  async function reprobeCustomEndpoint(): Promise<void> {
    const url = ollamaBaseUrl.value.trim();
    if (!url) return;
    ollamaStatus.textContent = "Probing...";
    ollamaStatus.className = "ollama-status";

    // Try Ollama API first; fall back to OpenAI shape ONLY when the
    // first probe surfaced as unreachable. cors_blocked +
    // server_up_no_models are server-up signals — the second probe
    // would ride the same wire (and the same blockage), so the
    // actionable kind from the first call is the right one to
    // surface. This prevents clobbering "set OLLAMA_ORIGINS" with a
    // generic "no server found" when the second probe also threw.
    let outcome = await probeLocalModels(url, "ollama");
    if (outcome.kind === "unreachable") {
      const fallback = await probeLocalModels(url, "openai");
      if (fallback.kind !== "unreachable") outcome = fallback;
    }
    renderProbeOutcome(outcome);
  }

  // Re-detect when base URL changes
  ollamaBaseUrl.addEventListener("change", () => void reprobeCustomEndpoint());

  // Governance: live-update persistence threshold display. Input is 0–1
  // (step 0.05) directly, matching desktop's range — no /100 conversion.
  govPersistenceThreshold.addEventListener("input", () => {
    govPersistenceValue.textContent = parseFloat(govPersistenceThreshold.value).toFixed(2);
  });

  // Card-click selection — clicking anywhere on the .preset-option card
  // updates the radio + the highlight. Native click on the radio also
  // fires this branch via the `<label>` wrapper, so this is the single
  // reconciliation point for both interaction surfaces.
  if (presetGroup != null) {
    presetGroup.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const card = target.closest<HTMLElement>(".preset-option");
      if (card == null) return;
      const preset = card.dataset.preset;
      if (preset != null && preset !== "") selectApprovalPreset(preset);
    });
  }

  // Operator-mode toggle: probe runtime.setOperatorMode(true) — if PIN is
  // already valid (post-cooldown), this succeeds silently; otherwise the
  // probe returns needsSetup or invalid-pin, and we surface the right
  // dialog mode. Disabling never requires a PIN (safe direction). Mirrors
  // desktop's wiring at apps/desktop/src/ui/settings.ts ~2239.
  if (settingsOperatorMode != null) {
    settingsOperatorMode.addEventListener("change", () => {
      if (settingsOperatorMode.checked && !ctx.app.isOperatorMode) {
        void ctx.app.setOperatorMode(true).then((result) => {
          if (!result.success) {
            showPinDialog(result.needsSetup === true ? "setup" : "verify");
          }
        });
      } else if (!settingsOperatorMode.checked && ctx.app.isOperatorMode) {
        void ctx.app.setOperatorMode(false);
      }
    });
  }

  if (settingsResetPin != null) {
    settingsResetPin.addEventListener("click", () => {
      showPinDialog("reset");
    });
  }

  // PIN dialog wiring — same shape as desktop. CSS lives in index.html;
  // the markup is the small modal block right after the settings dialog.
  let pinMode: "setup" | "verify" | "reset" = "verify";

  function showPinDialog(mode: "setup" | "verify" | "reset"): void {
    if (
      pinBackdrop == null ||
      pinTitle == null ||
      pinInput == null ||
      pinConfirmInput == null ||
      pinHint == null ||
      pinConfirmText == null ||
      pinError == null
    )
      return;
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
    if (pinBackdrop == null || pinInput == null || pinConfirmInput == null || pinError == null)
      return;
    pinBackdrop.classList.remove("open");
    pinInput.value = "";
    pinConfirmInput.value = "";
    pinError.textContent = "";
    // Reconcile toggle to actual state — covers cancel-mid-setup case.
    if (settingsOperatorMode != null) {
      settingsOperatorMode.checked = ctx.app.isOperatorMode;
    }
  }

  async function handlePinSubmit(): Promise<void> {
    if (pinBackdrop == null || pinInput == null || pinConfirmInput == null || pinError == null)
      return;
    pinError.textContent = "";

    if (pinMode === "reset") {
      try {
        await ctx.app.resetOperatorPin();
      } catch (err: unknown) {
        pinError.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
      pinBackdrop.classList.remove("open");
      if (settingsOperatorMode != null) settingsOperatorMode.checked = false;
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
  }

  document.getElementById("pin-cancel")?.addEventListener("click", closePinDialog);
  document.getElementById("pin-submit")?.addEventListener("click", () => {
    void handlePinSubmit();
  });
  pinInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handlePinSubmit();
  });
  pinConfirmInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handlePinSubmit();
  });

  // === Open / Close ===

  function open(): void {
    colorPicker.savePreviousState();
    colorPicker.buildColorSwatches();
    settingsBackdrop.classList.add("open");
    settingsModal.classList.add("open");

    // Pre-fill governance config
    const govConfig = loadGovernanceConfig();
    const activePreset = govConfig?.approvalPreset ?? "balanced";
    selectApprovalPreset(activePreset);
    if (govConfig) {
      // Range input is 0–1 directly (step 0.05) — no /100 conversion.
      govPersistenceThreshold.value = String(govConfig.persistenceThreshold);
      govPersistenceValue.textContent = govConfig.persistenceThreshold.toFixed(2);
      govRejectSecrets.checked = govConfig.rejectSecrets;
      govMaxCalls.value = String(govConfig.maxCallsPerTurn);
    }
    // Pre-fill proactive interior config
    const proactiveConfig = loadProactiveConfig();
    if (govProactiveEnabled != null) govProactiveEnabled.checked = proactiveConfig.enabled;
    if (govProactiveAnchor != null) govProactiveAnchor.checked = proactiveConfig.anchorOnchain;
    if (govP2pColdStart != null) govP2pColdStart.checked = loadColdStartOptIn();
    // Operator-mode toggle reflects runtime state. The policy gate is the
    // source of truth; the toggle is a view onto it.
    if (settingsOperatorMode != null) {
      settingsOperatorMode.checked = ctx.app.isOperatorMode;
    }

    // Pre-fill BYOK TTS key inputs from local storage. Keys never leave
    // this device; the inputs are the only UI path for entering them, so
    // this mirror-load is load-bearing — with no other surface, a blank
    // input would silently overwrite the stored key on Save.
    if (ttsElevenlabsKey) ttsElevenlabsKey.value = getVendorKey("elevenlabs") ?? "";
    if (ttsDeepgramKey) ttsDeepgramKey.value = getVendorKey("deepgram") ?? "";
    if (ttsInworldKey) ttsInworldKey.value = getVendorKey("inworld") ?? "";

    // Populate TTS voices — must run *after* key fields are filled so the
    // picker reflects the active provider's voice space on open.
    populateTtsVoices();
    const voiceConfig = loadVoiceConfig();
    if (voiceConfig) {
      voiceAutoSend.checked = voiceConfig.autoSend;
      voiceResponse.checked = voiceConfig.speakResponses;
      // Voice select already populated above; populateTtsVoices() restores
      // the stored ttsVoice if it's still a valid option in the new space.
    }

    // Pre-fill from current provider config
    const config = ctx.getConfig();
    if (config) {
      if (maxTokensSelect) maxTokensSelect.value = String(config.maxTokens ?? 4096);

      switch (config.mode) {
        case "motebit-cloud": {
          switchProviderTab("proxy");
          const cloudModelEl = document.getElementById("cloud-model") as HTMLSelectElement | null;
          if (cloudModelEl && config.model) cloudModelEl.value = config.model;
          break;
        }
        case "byok": {
          // The "API Key" tab uses the "anthropic" tab key historically.
          switchProviderTab("anthropic");
          activeByokProvider = config.vendor;
          setByokProviderUI(config.vendor);
          if (config.vendor === "anthropic") {
            anthropicApiKey.value = config.apiKey;
            if (config.model) anthropicModel.value = config.model;
          } else if (config.vendor === "openai") {
            openaiApiKey.value = config.apiKey;
            if (config.model) openaiModel.value = config.model;
          } else if (config.vendor === "google") {
            const googleApiKey = document.getElementById(
              "google-api-key",
            ) as HTMLInputElement | null;
            const googleModel = document.getElementById("google-model") as HTMLSelectElement | null;
            if (googleApiKey) googleApiKey.value = config.apiKey;
            if (googleModel) googleModel.value = config.model ?? DEFAULT_GOOGLE_MODEL;
          } else if (config.vendor === "groq") {
            const groqApiKey = document.getElementById("groq-api-key") as HTMLInputElement | null;
            const groqModel = document.getElementById("groq-model") as HTMLSelectElement | null;
            if (groqApiKey) groqApiKey.value = config.apiKey;
            if (groqModel) groqModel.value = config.model ?? "llama-3.3-70b-versatile";
          } else if (config.vendor === "deepseek") {
            const deepseekApiKey = document.getElementById(
              "deepseek-api-key",
            ) as HTMLInputElement | null;
            const deepseekModel = document.getElementById(
              "deepseek-model",
            ) as HTMLSelectElement | null;
            if (deepseekApiKey) deepseekApiKey.value = config.apiKey;
            if (deepseekModel) deepseekModel.value = config.model ?? "deepseek-chat";
          }
          break;
        }
        case "on-device": {
          // On-Device tab (historically keyed as "ollama" in the tab registry).
          switchProviderTab("ollama");
          if (config.backend === "webllm") {
            activeLocalBackend = "webllm";
            setLocalBackendUI("webllm");
            if (config.model) webllmModel.value = config.model;
          } else if (config.backend === "local-server") {
            activeLocalBackend = "server";
            setLocalBackendUI("server");
            ollamaBaseUrl.value = config.endpoint ?? DEFAULT_OLLAMA_URL;
            // Hint: warn if the saved endpoint doesn't look local (LAN, etc. is still ok).
            if (config.endpoint && !isLocalServerUrl(config.endpoint)) {
              // No toast — just leave the field; user can re-probe.
            }
            void detectAndPopulateLocalServer().then(() => {
              if (config.model) ollamaModel.value = config.model;
            });
          }
          // apple-fm / mlx are mobile-only — no UI on web.
          break;
        }
      }
    }
  }

  /** Visually sync the BYOK sub-provider buttons + sections to `vendor`. */
  function setByokProviderUI(
    vendor: "anthropic" | "openai" | "google" | "deepseek" | "groq",
  ): void {
    document.querySelectorAll<HTMLButtonElement>(".byok-provider-btn").forEach((b) => {
      const isActive = b.dataset.byok === vendor;
      b.classList.toggle("active", isActive);
      b.style.background = isActive ? "var(--accent-bg)" : "transparent";
      b.style.color = isActive ? "var(--text-heading)" : "var(--text-muted)";
    });
    const anthropicSection = document.getElementById("byok-anthropic");
    const openaiSection = document.getElementById("byok-openai");
    const googleSection = document.getElementById("byok-google");
    const groqSection = document.getElementById("byok-groq");
    const deepseekSection = document.getElementById("byok-deepseek");
    if (anthropicSection) anthropicSection.style.display = vendor === "anthropic" ? "" : "none";
    if (openaiSection) openaiSection.style.display = vendor === "openai" ? "" : "none";
    if (googleSection) googleSection.style.display = vendor === "google" ? "" : "none";
    if (groqSection) groqSection.style.display = vendor === "groq" ? "" : "none";
    if (deepseekSection) deepseekSection.style.display = vendor === "deepseek" ? "" : "none";
  }

  function setLocalBackendUI(backend: "webllm" | "server"): void {
    document.querySelectorAll<HTMLButtonElement>(".local-backend-btn").forEach((b) => {
      const isActive = b.dataset.backend === backend;
      b.classList.toggle("active", isActive);
      b.style.background = isActive ? "var(--accent-bg)" : "transparent";
      b.style.color = isActive ? "var(--text-heading)" : "var(--text-muted)";
    });
    const webllmSection = document.getElementById("local-webllm");
    const serverSection = document.getElementById("local-ollama");
    if (webllmSection) webllmSection.style.display = backend === "webllm" ? "" : "none";
    if (serverSection) serverSection.style.display = backend === "server" ? "" : "none";
  }

  function close(): void {
    settingsBackdrop.classList.remove("open");
    settingsModal.classList.remove("open");
  }

  function openToTab(tabName: string): void {
    open();
    switchTab(tabName);
  }

  // Backdrop click to close
  settingsBackdrop.addEventListener("click", () => {
    colorPicker.restorePreviousState();
    close();
  });

  // Settings button
  document.getElementById("settings-btn")?.addEventListener("click", () => open());

  // Connect prompt button
  document
    .getElementById("connect-prompt-btn")
    ?.addEventListener("click", () => openToTab("intelligence"));

  // Cancel button
  document.getElementById("settings-cancel")?.addEventListener("click", () => {
    colorPicker.restorePreviousState();
    close();
  });

  // Save button
  document.getElementById("settings-save")?.addEventListener("click", () => {
    // Build provider config from current tab
    const maxTokens = maxTokensSelect
      ? parseInt(maxTokensSelect.value, 10) || undefined
      : undefined;
    let config: ProviderConfig;
    switch (activeProviderTab) {
      case "proxy": {
        // Motebit Cloud — read model from the cloud model selector
        const cloudModel =
          (document.getElementById("cloud-model") as HTMLSelectElement | null)?.value ??
          DEFAULT_ANTHROPIC_MODEL;
        config = { mode: "motebit-cloud", model: cloudModel, maxTokens };
        break;
      }
      case "anthropic": {
        // BYOK tab — branch on the active sub-provider
        if (activeByokProvider === "groq") {
          // US-hosted Meta-Llama path — Groq's LPU inference at
          // ~280 tok/sec via OpenAI-compatible API. Fifth instance
          // of agility-as-role for BYOK vendors. Same dispatch arm
          // as DeepSeek / Google (wireProtocol: "openai").
          const groqApiKey = document.getElementById("groq-api-key") as HTMLInputElement | null;
          const groqModelEl = document.getElementById("groq-model") as HTMLSelectElement | null;
          config = {
            mode: "byok",
            vendor: "groq",
            apiKey: groqApiKey?.value.trim() ?? "",
            model: groqModelEl?.value ?? "llama-3.3-70b-versatile",
            maxTokens,
          };
        } else if (activeByokProvider === "deepseek") {
          // Agent-surface affordability path — DeepSeek V3 via the
          // hosted OpenAI-compatible API. Fourth instance of
          // agility-as-role for BYOK vendors. Resolver picks the
          // wire protocol + canonical URL from the SDK's closed
          // registry; the surface just collects the API key + model.
          const deepseekApiKey = document.getElementById(
            "deepseek-api-key",
          ) as HTMLInputElement | null;
          const deepseekModelEl = document.getElementById(
            "deepseek-model",
          ) as HTMLSelectElement | null;
          config = {
            mode: "byok",
            vendor: "deepseek",
            apiKey: deepseekApiKey?.value.trim() ?? "",
            model: deepseekModelEl?.value ?? "deepseek-chat",
            maxTokens,
          };
        } else if (activeByokProvider === "google") {
          const googleApiKey = document.getElementById("google-api-key") as HTMLInputElement | null;
          const googleModelEl = document.getElementById("google-model") as HTMLSelectElement | null;
          config = {
            mode: "byok",
            vendor: "google",
            apiKey: googleApiKey?.value.trim() ?? "",
            model: googleModelEl?.value ?? DEFAULT_GOOGLE_MODEL,
            // Google via OpenAI-compatible endpoint
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            maxTokens,
          };
        } else if (activeByokProvider === "openai") {
          config = {
            mode: "byok",
            vendor: "openai",
            apiKey: openaiApiKey.value.trim(),
            model: openaiModel.value,
            maxTokens,
          };
        } else {
          config = {
            mode: "byok",
            vendor: "anthropic",
            apiKey: anthropicApiKey.value.trim(),
            model: anthropicModel.value,
            maxTokens,
          };
        }
        break;
      }
      case "openai": {
        config = {
          mode: "byok",
          vendor: "openai",
          apiKey: openaiApiKey.value.trim(),
          model: openaiModel.value,
          maxTokens,
        };
        break;
      }
      case "ollama": {
        // On-Device tab — branch on the selected backend picker
        if (activeLocalBackend === "webllm") {
          config = { mode: "on-device", backend: "webllm", model: webllmModel.value, maxTokens };
        } else {
          config = {
            mode: "on-device",
            backend: "local-server",
            model: ollamaModel.value,
            endpoint: ollamaBaseUrl.value.trim(),
            maxTokens,
          };
        }
        break;
      }
      case "webllm": {
        config = { mode: "on-device", backend: "webllm", model: webllmModel.value, maxTokens };
        break;
      }
    }

    // Save appearance (soul color preset). The on-disk shape is the
    // canonical `AppearanceConfig` from `@motebit/sdk` — `colorPreset`,
    // not the legacy `preset` web used to write.
    const colorPreset = colorPicker.getSelectedPreset();
    const soulColor: AppearanceConfig =
      colorPreset === "custom"
        ? {
            colorPreset: "custom",
            customHue: colorPicker.getCustomHue(),
            customSaturation: colorPicker.getCustomSaturation(),
          }
        : { colorPreset };
    saveSoulColor(soulColor);

    // Only reconnect provider if the provider config actually changed.
    // Compare shallow — good enough to avoid a needless model reload.
    const prev = ctx.getConfig();
    const providerChanged = !prev || JSON.stringify(prev) !== JSON.stringify(config);

    const isWebLLMConfig = config.mode === "on-device" && config.backend === "webllm";
    if (providerChanged) {
      if (isWebLLMConfig) {
        void initWebLLM(config);
      } else {
        ctx.app.connectProvider(config);
      }
    }

    saveProviderConfig(config);
    ctx.setConfig(config);

    // Save governance config and apply to runtime
    const selectedPreset =
      document.querySelector<HTMLInputElement>('input[name="approval-preset"]:checked')?.value ??
      "balanced";
    const prevGov = loadGovernanceConfig();
    const govCfg: GovernanceConfig = {
      approvalPreset: selectedPreset as GovernanceConfig["approvalPreset"],
      persistenceThreshold: parseFloat(govPersistenceThreshold.value),
      rejectSecrets: govRejectSecrets.checked,
      maxCallsPerTurn: parseInt(govMaxCalls.value, 10) || 10,
      // Web UI doesn't expose a max-memories slider yet; preserve whatever
      // was stored, default from the canonical sdk config.
      maxMemoriesPerTurn:
        prevGov?.maxMemoriesPerTurn ?? DEFAULT_GOVERNANCE_CONFIG.maxMemoriesPerTurn,
    };
    saveGovernanceConfig(govCfg);
    applyGovernanceToRuntime(ctx, govCfg);

    // Persist proactive interior config. Runtime picks up the change on
    // next bootstrap (idle-tick + auto-anchor are constructor-time
    // wiring) — the help text under the toggle tells the user to reload.
    saveProactiveConfig({
      enabled: govProactiveEnabled?.checked === true,
      anchorOnchain: govProactiveAnchor?.checked === true,
    });

    // Cold-start opt-in is read fresh per delegation by WebApp.invokeCapability,
    // so this takes effect on the next delegation with no reload.
    saveColdStartOptIn(govP2pColdStart?.checked === true);

    // Persist BYOK voice keys first so the rebuild below sees fresh values.
    // Empty-string clears the slot (setVendorKey removes the localStorage entry).
    // Voice section is the three voice majors — keys are vendor-scoped and
    // dual-purpose (TTS + STT) per vendor.
    if (ttsElevenlabsKey) setVendorKey("elevenlabs", ttsElevenlabsKey.value.trim());
    if (ttsDeepgramKey) setVendorKey("deepgram", ttsDeepgramKey.value.trim());
    if (ttsInworldKey) setVendorKey("inworld", ttsInworldKey.value.trim());

    // Save voice config. `enabled` stays whatever the stored config said —
    // the web surface doesn't expose a master voice on/off toggle yet; when
    // it does, wire it here. Defaults flow through `migrateVoiceConfig`.
    const prevVoiceCfg = loadVoiceConfig();
    const voiceCfg: VoiceConfig = {
      enabled: prevVoiceCfg?.enabled ?? false,
      ttsVoice: ttsVoiceSelect.value,
      autoSend: voiceAutoSend.checked,
      speakResponses: voiceResponse.checked,
      neuralVad: prevVoiceCfg?.neuralVad,
    };
    saveVoiceConfig(voiceCfg);
    setTTSVoice(voiceCfg.ttsVoice);

    // Rebuild the live TTS provider chain so BYOK key/voice edits take
    // effect without a reload. rebuildTTSProvider re-reads storage and
    // swaps the StreamingTTS provider in place.
    rebuildTTSProvider();

    updateModelIndicator();
    updateConnectPrompt();
    close();
  });

  // === WebLLM Init ===

  async function initWebLLM(config: ProviderConfig): Promise<void> {
    if (config.mode !== "on-device" || config.backend !== "webllm") {
      throw new Error("initWebLLM called with non-webllm config");
    }
    webllmProgress.style.display = "block";
    webllmProgressText.textContent = "Loading model...";
    webllmProgressFill.style.width = "0%";

    // A short, human display name for the HUD — the dropdown option reads
    // "gemma-2-9b (6.3 GB)"; strip the size for the ambient indicator.
    const modelLabel =
      webllmModel.selectedOptions[0]?.textContent?.replace(/\s*\(.*\)\s*$/, "").trim() ||
      (config.model ?? "model");

    try {
      const provider = new WebLLMProvider(config.model ?? "Llama-3.1-8B-Instruct-q4f16_1-MLC");
      await provider.init((progress) => {
        const pct = Math.round(progress.progress * 100);
        webllmProgressFill.style.width = `${pct}%`;
        webllmProgressText.textContent = progress.text;
        // Mirror progress onto the HUD indicator so the download is observable
        // OUTSIDE the settings modal (the modal closes on Save; the download
        // continues for minutes). The active model stays underneath until ready.
        setModelIndicatorLoading(modelLabel, pct);
      });
      // Set the initialized WebLLM provider directly on the runtime
      ctx.app.setProviderDirect(provider);
      webllmProgressText.textContent = "Ready";
      // Settle the HUD from "preparing…" to the now-active model name
      // (updateModelIndicator drops the loading pulse).
      updateModelIndicator();
      updateConnectPrompt();
      ctx.showToast("WebLLM model loaded");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      webllmProgressText.textContent = `Failed: ${msg}`;
      // Surface the failure on the HUD too, not only as a transient toast —
      // otherwise a user who closed the modal sees the stale active model and
      // no sign the switch failed.
      setModelIndicatorError(modelLabel);
      ctx.showToast(`WebLLM failed: ${msg}`);
    }
  }

  // === Escape key ===

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsModal.classList.contains("open")) {
      colorPicker.restorePreviousState();
      close();
    }
  });

  // === Model Indicator ===

  function updateModelIndicator(): void {
    // Any normal indicator update is a settled state — drop a stale loading
    // pulse / error so the HUD can't get stuck mid-transition.
    modelIndicator.classList.remove("is-loading", "is-error");
    const model = ctx.app.currentModel;
    modelIndicator.textContent = ctx.app.isProviderConnected ? (model ?? "") : "";
  }

  /**
   * Ambient "a model is loading" state on the HUD indicator — the third truth
   * the indicator must render (active / none / loading). The active model stays
   * live underneath; this only signals that a switch is in flight so a
   * multi-GB download is observable after the modal closes.
   */
  function setModelIndicatorLoading(modelLabel: string, pct: number): void {
    modelIndicator.classList.remove("is-error");
    modelIndicator.classList.add("is-loading");
    modelIndicator.textContent = `preparing ${modelLabel} · ${pct}%`;
  }

  function setModelIndicatorError(modelLabel: string): void {
    modelIndicator.classList.remove("is-loading");
    modelIndicator.classList.add("is-error");
    modelIndicator.textContent = `couldn't load ${modelLabel}`;
  }

  function updateConnectPrompt(): void {
    if (ctx.app.isProviderConnected) {
      connectPrompt.classList.add("hidden");
    } else {
      connectPrompt.classList.remove("hidden");
    }
  }

  return { open, openToTab, close, updateModelIndicator, updateConnectPrompt };
}

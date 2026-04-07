import type { DesktopAIConfig, InvokeFn } from "../index";
import {
  DEFAULT_GOVERNANCE_CONFIG,
  type ApprovalPreset,
  type GovernanceConfig,
} from "@motebit/sdk";
import { byokKeyringKey, LEGACY_API_KEY_SLOT, SYNC_MASTER_TOKEN_SLOT } from "./keyring-keys";

/**
 * Read a canonical `GovernanceConfig` from the Tauri JSON blob.
 *
 * Accepts two shapes:
 *   1. Canonical: `governance: { approvalPreset, persistenceThreshold, rejectSecrets,
 *      maxCallsPerTurn, maxMemoriesPerTurn }`
 *   2. Legacy: top-level `approval_preset` + `memory_governance: { persistence_threshold,
 *      reject_secrets }` + `budget: { maxCallsPerTurn }`
 *
 * Missing fields fall back to `DEFAULT_GOVERNANCE_CONFIG`. The return value
 * is always a fully-populated canonical record, never partial.
 */
function parseGovernanceFromConfig(parsed: Record<string, unknown>): GovernanceConfig | undefined {
  const canonical = parsed.governance as Partial<GovernanceConfig> | undefined;
  const legacyPreset = parsed.approval_preset as string | undefined;
  const legacyMemory = parsed.memory_governance as
    | { persistence_threshold?: number; reject_secrets?: boolean }
    | undefined;
  const legacyBudget = parsed.budget as { maxCallsPerTurn?: number } | undefined;

  if (canonical == null && legacyPreset == null && legacyMemory == null && legacyBudget == null) {
    return undefined;
  }

  const rawPreset = canonical?.approvalPreset ?? legacyPreset;
  const approvalPreset: ApprovalPreset =
    rawPreset === "cautious" || rawPreset === "balanced" || rawPreset === "autonomous"
      ? rawPreset
      : DEFAULT_GOVERNANCE_CONFIG.approvalPreset;

  return {
    approvalPreset,
    persistenceThreshold:
      canonical?.persistenceThreshold ??
      legacyMemory?.persistence_threshold ??
      DEFAULT_GOVERNANCE_CONFIG.persistenceThreshold,
    rejectSecrets:
      canonical?.rejectSecrets ??
      legacyMemory?.reject_secrets ??
      DEFAULT_GOVERNANCE_CONFIG.rejectSecrets,
    maxCallsPerTurn:
      canonical?.maxCallsPerTurn ??
      legacyBudget?.maxCallsPerTurn ??
      DEFAULT_GOVERNANCE_CONFIG.maxCallsPerTurn,
    maxMemoriesPerTurn:
      canonical?.maxMemoriesPerTurn ?? DEFAULT_GOVERNANCE_CONFIG.maxMemoriesPerTurn,
  };
}

export async function loadDesktopConfig(): Promise<DesktopAIConfig> {
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Migrate the legacy `"ollama"` value transparently. Old config.json
    // files persist `default_provider: "ollama"`; we read them as the new
    // vendor-agnostic `"local-server"` name. New saves write the new value.
    const rawProvider = parsed.default_provider as string | undefined;
    const provider: DesktopAIConfig["provider"] =
      rawProvider === "ollama"
        ? "local-server"
        : ((rawProvider as DesktopAIConfig["provider"] | undefined) ?? "local-server");
    const model = (parsed.default_model as string | undefined) ?? undefined;

    // Per-vendor keyring slot for the active provider. Falls back to the
    // legacy single-slot `api_key` if the per-vendor slot is empty — this
    // transparently migrates users who pre-date the per-vendor split.
    // Providers with no BYOK key (local-server, proxy) skip lookup entirely.
    let apiKey: string | undefined;
    const slot = byokKeyringKey(provider);
    if (slot) {
      try {
        const vendorVal = await invoke<string | null>("keyring_get", { key: slot });
        apiKey = vendorVal ?? undefined;
      } catch {
        // Keyring unavailable — fall through
      }
      if (apiKey == null || apiKey === "") {
        // Legacy single-slot fallback. We don't write-back here: the next
        // save will populate the per-vendor slot, and the legacy slot stays
        // readable until the user explicitly rotates.
        try {
          const legacyVal = await invoke<string | null>("keyring_get", {
            key: LEGACY_API_KEY_SLOT,
          });
          apiKey = legacyVal ?? undefined;
        } catch {
          /* keyring unavailable */
        }
      }
    }
    if (apiKey == null || apiKey === "") {
      apiKey = (parsed.api_key as string | undefined) ?? undefined;
    }

    // Local-server endpoint (optional) — user's LAN/localhost inference
    // server (Ollama, LM Studio, llama.cpp, Jan, vLLM, …). Falls back to
    // the runtime default inside initAI when absent. Canonical JSON key
    // is `local_server_endpoint`; the historical key `ollama_endpoint`
    // is still read for migration.
    const localServerEndpoint =
      (parsed.local_server_endpoint as string | undefined) ??
      (parsed.ollama_endpoint as string | undefined) ??
      undefined;

    // Sync relay config (optional)
    const syncUrl = (parsed.sync_url as string | undefined) ?? undefined;
    let syncMasterToken: string | undefined;
    if (syncUrl != null && syncUrl !== "") {
      try {
        const keyringVal = await invoke<string | null>("keyring_get", {
          key: SYNC_MASTER_TOKEN_SLOT,
        });
        syncMasterToken = keyringVal ?? undefined;
      } catch {
        // Keyring unavailable
      }
    }

    const governance = parseGovernanceFromConfig(parsed);

    return {
      provider,
      model,
      apiKey,
      localServerEndpoint,
      isTauri: true,
      invoke: invoke as InvokeFn,
      syncUrl,
      syncMasterToken,
      governance,
    };
  }

  // Vite dev mode — read from env vars
  const envProvider = import.meta.env.VITE_AI_PROVIDER as string | undefined;
  const provider: DesktopAIConfig["provider"] =
    envProvider === "ollama"
      ? "local-server"
      : ((envProvider as DesktopAIConfig["provider"] | undefined) ?? "local-server");
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY || undefined;

  return { provider, apiKey, isTauri: false };
}

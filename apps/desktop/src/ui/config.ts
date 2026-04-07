import type { DesktopAIConfig, InvokeFn } from "../index";
import { byokKeyringKey, LEGACY_API_KEY_SLOT, SYNC_MASTER_TOKEN_SLOT } from "./keyring-keys";

export async function loadDesktopConfig(): Promise<DesktopAIConfig> {
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider: DesktopAIConfig["provider"] =
      (parsed.default_provider as DesktopAIConfig["provider"] | undefined) ?? "ollama";
    const model = (parsed.default_model as string | undefined) ?? undefined;

    // Per-vendor keyring slot for the active provider. Falls back to the
    // legacy single-slot `api_key` if the per-vendor slot is empty — this
    // transparently migrates users who pre-date the per-vendor split.
    // Providers with no BYOK key (ollama, proxy) skip lookup entirely.
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

    return {
      provider,
      model,
      apiKey,
      isTauri: true,
      invoke: invoke as InvokeFn,
      syncUrl,
      syncMasterToken,
    };
  }

  // Vite dev mode — read from env vars
  const provider = (import.meta.env.VITE_AI_PROVIDER as DesktopAIConfig["provider"]) || "ollama";
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY || undefined;

  return { provider, apiKey, isTauri: false };
}

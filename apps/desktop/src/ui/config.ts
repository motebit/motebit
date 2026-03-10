import type { DesktopAIConfig, InvokeFn } from "../index";

export async function loadDesktopConfig(): Promise<DesktopAIConfig> {
  const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<string>("read_config");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider: DesktopAIConfig["provider"] =
      (parsed.default_provider as DesktopAIConfig["provider"] | undefined) ?? "ollama";
    const model = (parsed.default_model as string | undefined) ?? undefined;

    // Try keyring first, fall back to config file
    let apiKey: string | undefined;
    try {
      const keyringVal = await invoke<string | null>("keyring_get", { key: "api_key" });
      apiKey = keyringVal ?? undefined;
    } catch {
      // Keyring unavailable — fall through
    }
    if (apiKey == null || apiKey === "") {
      apiKey = (parsed.api_key as string | undefined) ?? undefined;
    }

    // Sync relay config (optional)
    const syncUrl = (parsed.sync_url as string | undefined) ?? undefined;
    let syncMasterToken: string | undefined;
    if (syncUrl != null && syncUrl !== "") {
      try {
        const keyringVal = await invoke<string | null>("keyring_get", { key: "sync_master_token" });
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

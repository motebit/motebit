/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANTHROPIC_API_KEY: string;
  readonly VITE_AI_PROVIDER: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  // Legacy v1 global — only set when tauri.conf.json has
  // `app.withGlobalTauri: true`. Kept for compatibility with older
  // detection paths; new code should check `__TAURI_INTERNALS__` or
  // call `@tauri-apps/api/core` directly.
  __TAURI__?: Record<string, unknown>;
  // v2 internals object — set by every Tauri webview regardless of
  // `withGlobalTauri`. The canonical "am I in Tauri?" signal.
  __TAURI_INTERNALS__?: Record<string, unknown>;
}

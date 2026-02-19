// ---------------------------------------------------------------------------
// FallbackTTSProvider — chains multiple TTS providers with graceful fallback
// ---------------------------------------------------------------------------

import type { TTSProvider, TTSOptions } from "./tts.js";

/**
 * Chains multiple TTSProviders — tries each in order until one succeeds.
 * If all providers fail, rejects with the last error.
 *
 * Pattern mirrors `FallbackSearchProvider` at `packages/tools/src/search-provider.ts`.
 */
export class FallbackTTSProvider implements TTSProvider {
  private _activeProvider: TTSProvider | null = null;
  private readonly providers: TTSProvider[];

  constructor(providers: TTSProvider[]) {
    this.providers = providers;
  }

  get speaking(): boolean {
    return this._activeProvider?.speaking ?? false;
  }

  async speak(text: string, options?: TTSOptions): Promise<void> {
    let lastError: Error | undefined;
    for (const provider of this.providers) {
      try {
        this._activeProvider = provider;
        await provider.speak(text, options);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
    }
    this._activeProvider = null;
    if (lastError) throw lastError;
  }

  cancel(): void {
    if (this._activeProvider) {
      this._activeProvider.cancel();
      this._activeProvider = null;
    }
  }
}

---
---

**Surface-side companion to the BYOK DeepSeek SDK addition** (see `.changeset/byok-deepseek-vendor.md`). All four chat surfaces (web, desktop, mobile, CLI) gain a DeepSeek tile per CLAUDE.md's one-pass-delivery principle ("when a core primitive ships, implement across all surfaces in the same pass"). Surface-internal changes only; no published packages bumped (web, desktop, mobile, CLI are all ignored in `.changeset/config.json`).

**Web** (`apps/web/index.html` + `apps/web/src/ui/settings.ts`):

- Fourth `byok-provider-btn` (data-byok="deepseek") added to the BYOK selector row.
- `#byok-deepseek` section with API key input + model select.
- `activeByokProvider` union extended to include `"deepseek"`; toggle handler refactored to call shared `setByokProviderUI`; load + save paths gain the `deepseek` arm.
- Calm-software register: pre-filled defaults, terse data-residency note ("Hosted in China; medical / financial / secret sensitivity tiers block all external AI by default") sized at 11px under the API key input.

**Desktop** (`apps/desktop/`):

- `DesktopProvider` union extended to `"anthropic" | "local-server" | "openai" | "google" | "deepseek" | "proxy"`.
- `desktopConfigToUnified` gains the `deepseek` arm.
- `byokKeyringKey` returns a new `deepseek_api_key` keyring slot; `DEEPSEEK_API_KEY_SLOT` declared in `keyring-keys.ts`.
- Settings UI: fourth tile in the BYOK row; `activeByokVendor` union extended; `populateByokModeModels` + `populateModelSelect` route DeepSeek to `DEEPSEEK_MODELS`.

**Mobile** (`apps/mobile/`):

- `MobileProvider` + `ProviderType` unions extended.
- `mobileConfigToUnified` + `mobileSettingsToUnifiedProvider` gain the `deepseek` arm.
- `IntelligenceTab.tsx`: fourth `TouchableOpacity` radio button + conditional API-key input section with calm-default residency note.
- `SettingsModal.tsx`: `deepseekKey` state, `SECURE_STORE_KEYS.deepseekApiKey` load/save, prop passthrough.
- `storage-keys.ts`: `deepseekApiKey: "motebit_deepseek_api_key"` SecureStore slot.

**CLI** (`apps/cli/`):

- `CliProvider` union extended with `"deepseek"`; `VALID_PROVIDERS` array updated.
- `getApiKey("deepseek")` reads `DEEPSEEK_API_KEY` env var with proper error-message hint.
- Default model fallback returns `"deepseek-chat"` when `--provider deepseek`.
- `mobileConfigToUnified` parallel-shaped arm in `runtime-factory.ts`.

**One-pass delivery rationale.** Adding DeepSeek to only one surface would leave the others structurally drifted from the protocol-layer registry. CLAUDE.md's principle ("when a core primitive ships, implement across all surfaces in the same pass — do not defer UI if the package boundary is stable") forces all four surfaces in the same commit. The cross-surface scope is mechanical: each surface has the same shape (BYOK selector toggle + conditional API-key input + dispatch arm). Future vendor additions follow the same template.

**No new drift gates.** The existing closure discipline already enforces the addition:

- TypeScript exhaustive-switch typecheck on the four `*Provider` / `ByokVendor` unions (any missing case fails compile)
- `check-api-surface` (the SDK's `sdk.api.md` baseline mirrors the union)
- The provider-resolver tests (one describe block per vendor)

Per `feedback_no_separate_pages` + calm-software discipline, no new tabs or modals — just an additional tile in the existing BYOK row on each surface.
